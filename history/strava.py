"""Segment hunter: Strava segments, their top-10 times, and their shape. Standard library only.

Where each piece comes from:
  - Finding segments in an area: Strava's API (segments/explore), with your own Strava API app.
    Optional: without it you can still add segments one at a time by link or ID.
  - Top 10: Strava's public segment widget (strava.com/segments/<id>/embed), the same one
    VeloViewer shows on its Leaderboard tab. No login needed. Athletes who hide themselves are
    left out of it, so a rank can be missing (1, 2, 4, 5, 8...).
  - Shape and elevation: VeloViewer's segment streams, falling back to the explore polyline and
    the segment's average gradient.

Everything is kept under DATA_DIR/strava. Top-10 times are refreshed weekly, slowly (one widget
every few seconds), and only for segments you've looked at.

Env:
  STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET  your Strava API app (strava.com/settings/api)
  STRAVA_REFRESH_TOKEN                    optional: skip the in-app "Connect Strava" step
  STRAVA_LB_DAYS                          refresh top-10 times this often (default 7)
  STRAVA_GAP                              seconds between widget/VeloViewer requests (default 3)
"""
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import html as htmllib

CLIENT_ID = os.environ.get("STRAVA_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("STRAVA_CLIENT_SECRET", "").strip()
ENV_REFRESH = os.environ.get("STRAVA_REFRESH_TOKEN", "").strip()
LB_TTL = float(os.environ.get("STRAVA_LB_DAYS", "7")) * 86400
GAP = float(os.environ.get("STRAVA_GAP", "3"))
DIR = os.path.join(os.environ.get("DATA_DIR", "/data"), "strava")
SEG_FILE = os.path.join(DIR, "segments.json")
TOKEN_FILE = os.path.join(DIR, "token.json")
CELLS_FILE = os.path.join(DIR, "cells.json")

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 cycleplanner"
API = "https://www.strava.com/api/v3"

# Strava's default limits are 100 reads per 15 min and 1,000 a day. Stay well under them.
READS_PER_15 = 80
READS_PER_DAY = 900
CELL_DAYS = 60          # an area searched in the last 60 days isn't searched again
MIN_CELL = 0.006        # ~600 m: explore returns at most 10 segments, so busy cells are split down to this
MAX_SCAN_AREA = 0.25    # square degrees (~50 x 50 km) per search

lock = threading.RLock()
state = {
    "scan": {"running": False, "done": 0, "queued": 0, "found": 0, "error": None},
    "lb_error": None, "lb_last": None, "reads": [],
}
_wake = threading.Event()


# ---------- storage ----------
def _read(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write(path, obj):
    os.makedirs(DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


segments = _read(SEG_FILE, {})   # id (str) -> segment record
cells = _read(CELLS_FILE, {})    # "s,w,n,e" -> time searched
wanted = {}                      # id -> time last asked for (leaderboard refresh priority)


def _save_segments():
    with lock:
        _write(SEG_FILE, segments)


# ---------- polylines ----------
def decode_polyline(s, dims=2, precision=1e5):
    """Google encoded polyline -> list of tuples (dims values each)."""
    out, idx, acc = [], 0, [0] * dims
    while idx < len(s):
        row = []
        for d in range(dims):
            r = sh = 0
            while True:
                b = ord(s[idx]) - 63
                idx += 1
                r |= (b & 0x1F) << sh
                sh += 5
                if b < 0x20:
                    break
            acc[d] += ~(r >> 1) if r & 1 else r >> 1
            row.append(acc[d] / precision)
        out.append(tuple(row))
    return out


def _hav(a, b):
    r = math.pi / 180
    dlat, dlon = (b[1] - a[1]) * r, (b[0] - a[0]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[1] * r) * math.cos(b[1] * r) * math.sin(dlon / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def _thin(coords, step=25.0):
    """Keep a point every ~step metres (and the last), so a segment's shape stays small."""
    if len(coords) < 3:
        return coords
    out, last = [coords[0]], coords[0]
    for c in coords[1:-1]:
        if _hav(last, c) >= step:
            out.append(c)
            last = c
    out.append(coords[-1])
    return out


# ---------- leaderboard widget ----------
def _get(url, timeout=30, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), dict(r.headers)


def parse_time(t):
    """'5:54' / '1:02:03' / '45s' / '45' -> seconds."""
    t = t.strip().lower()
    m = re.match(r"^(\d+)\s*s$", t)
    if m:
        return int(m.group(1))
    parts = [int(p) for p in re.findall(r"\d+", t)]
    if not parts or len(parts) > 3:
        return None
    s = 0
    for p in parts:
        s = s * 60 + p
    return s


def parse_embed(text):
    """Strava segment widget HTML -> {name, place, top: [[rank, secs, watts|None], ...]} (overall board)."""
    name = re.search(r"<h1>\s*<a[^>]*>(.*?)</a>", text, re.S)
    place = re.search(r"</h1>\s*([^<]+?)\s*<ul", text, re.S)
    out = {"name": htmllib.unescape(name.group(1).strip()) if name else None,
           "place": htmllib.unescape(place.group(1).strip()) if place else None, "top": []}
    m = re.search(r"Overall Leaderboard</h2>(.*?)</table>", text, re.S)
    if not m:
        return out
    for row in re.findall(r"<tr>(.*?)</tr>", re.search(r"<tbody>(.*)", m.group(1), re.S).group(1) if "<tbody>" in m.group(1) else "", re.S):
        cells_ = [re.sub(r"<[^>]+>", " ", c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        cells_ = [re.sub(r"\s+", " ", htmllib.unescape(c)).strip() for c in cells_]
        if len(cells_) < 3 or not cells_[0].isdigit():
            continue
        secs = parse_time(cells_[2])
        watts = None
        if len(cells_) >= 5:
            w = re.match(r"^(\d+)\s*W", cells_[4])
            watts = int(w.group(1)) if w else None
        if secs:
            out["top"].append([int(cells_[0]), secs, watts])
    return out


def target_of(top):
    """Time to beat for a top-10 place. The widget lists ranks 1-10 minus hidden athletes, so if
    rank 10 is missing the 10th time isn't known, only that it's no faster than the last one
    shown: beating that is enough."""
    inside = [t for t in top if t[0] <= 10]
    if not inside:
        return None, None
    last = max(inside, key=lambda t: t[0])
    return last[1], last[0]


def veloviewer(sid):
    """Shape and elevation from VeloViewer: (coords [[lon, lat, ele]...] or None, info dict)."""
    info = {}
    try:
        page, _ = _get(f"https://veloviewer.com/segments/{sid}")
        m = re.search(rb"var segment = (\{.*?\});\s*\n", page)
        if m:
            seg = json.loads(m.group(1))
            if seg.get("distance", -1) > 0:
                info = {"name": seg.get("name"), "distance": seg.get("distance"), "grade": seg.get("grade"),
                        "kom": seg.get("komElapsedTime") if (seg.get("komElapsedTime") or 0) > 0 else None,
                        "city": seg.get("city"), "type": seg.get("type"), "hazardous": seg.get("hazardous") == 1}
    except Exception:
        pass
    time.sleep(GAP / 2)
    try:
        body, _ = _get(f"https://veloviewer.com/api/getSegmentStreams.php?id={sid}")
        d = json.loads(body)
        ll = decode_polyline(d.get("latLng") or "")
        ele = [v[0] for v in decode_polyline(d.get("elevation") or "", dims=1, precision=10)]
        if len(ll) >= 2:
            coords = [[round(p[1], 6), round(p[0], 6), round(ele[i], 1) if i < len(ele) else None] for i, p in enumerate(ll)]
            return _thin(coords), info
    except Exception:
        pass
    return None, info


def refresh_one(sid):
    """Fetch top 10 (and shape, if we don't have elevation yet) for one segment."""
    sid = str(sid)
    body, _ = _get(f"https://www.strava.com/segments/{sid}/embed")
    lb = parse_embed(body.decode("utf-8", "replace"))
    with lock:
        seg = segments.get(sid) or {"id": int(sid)}
    if lb["name"]:
        seg["name"] = lb["name"]
    if lb["place"]:
        seg["place"] = lb["place"]
    seg["top"] = lb["top"]
    seg["target"], seg["target_rank"] = target_of(lb["top"])
    seg["lb_at"] = time.time()
    if not seg.get("has_ele"):
        time.sleep(GAP)
        coords, info = veloviewer(sid)
        if coords:
            seg["coords"] = coords
            seg["has_ele"] = any(c[2] is not None for c in coords)
        for k in ("distance", "grade", "hazardous", "type"):
            if info.get(k) is not None and seg.get(k) is None:
                seg[k] = info[k]
        if not seg.get("name") and info.get("name"):
            seg["name"] = info["name"]
        seg["vv_at"] = time.time()
    with lock:
        segments[sid] = seg
    _save_segments()
    return seg


def lb_worker():
    """Keeps top-10 times fresh for segments you've looked at, newest interest first."""
    while True:
        _wake.wait(60)
        _wake.clear()
        while True:
            now = time.time()
            with lock:
                due = [s for s in wanted if now - wanted[s] < 30 * 86400 and s in segments
                       and now - (segments[s].get("lb_at") or 0) > LB_TTL
                       and now - (segments[s].get("lb_fail") or 0) > 3600]
                due.sort(key=lambda s: -wanted[s])
            if not due:
                break
            sid = due[0]
            try:
                refresh_one(sid)
                state["lb_error"], state["lb_last"] = None, time.time()
            except Exception as e:
                state["lb_error"] = f"segment {sid}: {str(e)[:150]}"
                with lock:
                    if sid in segments:
                        segments[sid]["lb_fail"] = time.time()
                if isinstance(e, urllib.error.HTTPError) and e.code == 429:
                    time.sleep(900)  # Strava says slow down: back off 15 minutes
            time.sleep(GAP)


# ---------- Strava API (finding segments) ----------
def configured():
    return bool(CLIENT_ID and CLIENT_SECRET)


def _token():
    tok = _read(TOKEN_FILE, {})
    if not tok and ENV_REFRESH:
        tok = {"refresh_token": ENV_REFRESH, "expires_at": 0}
    return tok


def connected():
    return configured() and bool(_token().get("refresh_token"))


def _token_call(params):
    data = urllib.parse.urlencode({"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, **params}).encode()
    req = urllib.request.Request("https://www.strava.com/oauth/token", data=data, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            tok = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Strava refused the login ({e.code}): {e.read()[:200].decode('utf-8', 'replace')}") from e
    keep = {k: tok.get(k) for k in ("access_token", "refresh_token", "expires_at")}
    if tok.get("athlete"):
        keep["athlete"] = f"{tok['athlete'].get('firstname', '')} {tok['athlete'].get('lastname', '')}".strip()
    else:
        keep["athlete"] = _token().get("athlete")
    _write(TOKEN_FILE, keep)
    return keep


def authorize_url(redirect):
    return "https://www.strava.com/oauth/authorize?" + urllib.parse.urlencode({
        "client_id": CLIENT_ID, "response_type": "code", "redirect_uri": redirect,
        "approval_prompt": "auto", "scope": "read"})


def exchange(code):
    return _token_call({"code": code, "grant_type": "authorization_code"})


def disconnect():
    try:
        os.remove(TOKEN_FILE)
    except OSError:
        pass


def _access():
    tok = _token()
    if not tok.get("refresh_token"):
        raise RuntimeError("Strava isn't connected")
    if not tok.get("access_token") or tok.get("expires_at", 0) < time.time() + 120:
        tok = _token_call({"refresh_token": tok["refresh_token"], "grant_type": "refresh_token"})
    return tok["access_token"]


def _budget_wait():
    """Sleep until a Strava API read is within our share of the rate limit."""
    while True:
        now = time.time()
        with lock:
            state["reads"] = [t for t in state["reads"] if now - t < 86400]
            last15 = [t for t in state["reads"] if now - t < 900]
            if len(state["reads"]) >= READS_PER_DAY:
                wait = state["reads"][0] + 86400 - now
            elif len(last15) >= READS_PER_15:
                wait = last15[0] + 900 - now
            else:
                state["reads"].append(now)
                return
        state["scan"]["waiting"] = round(wait)
        time.sleep(min(wait + 1, 60))


def api_get(path):
    _budget_wait()
    state["scan"].pop("waiting", None)
    req = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {_access()}", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise RuntimeError("Strava rejected the connection (401): connect Strava again") from e
        if e.code == 429:
            raise RuntimeError("Strava rate limit reached: the search carries on later") from e
        raise


def _add_explored(s):
    sid = str(s["id"])
    pts = decode_polyline(s.get("points") or "")
    with lock:
        seg = segments.get(sid) or {"id": s["id"]}
        seg.update(name=s.get("name") or seg.get("name"), distance=s.get("distance"), grade=s.get("avg_grade"),
                   climb=s.get("climb_category"))
        if not seg.get("has_ele") and len(pts) >= 2:
            seg["coords"] = _thin([[round(p[1], 6), round(p[0], 6), None] for p in pts])
        segments[sid] = seg
        return seg


def _cell_key(b):
    return ",".join(f"{v:.4f}" for v in b)


def scan(bbox):
    """Search an area for segments: explore each cell, splitting any cell that comes back full."""
    s, w, n, e = bbox
    step = 0.03  # ~3 km starting cells
    queue = []
    lat = s
    while lat < n - 1e-9:
        lon = w
        while lon < e - 1e-9:
            queue.append([lat, lon, min(lat + step, n), min(lon + step, e)])
            lon += step
        lat += step
    sc = state["scan"]
    sc.update(running=True, done=0, queued=len(queue), found=0, error=None)
    seen = set()
    try:
        while queue:
            b = queue.pop(0)
            sc["queued"] = len(queue)
            key = _cell_key(b)
            if time.time() - cells.get(key, 0) < CELL_DAYS * 86400:
                sc["done"] += 1
                continue
            q = urllib.parse.urlencode({"bounds": ",".join(f"{v:.5f}" for v in b), "activity_type": "riding"})
            res = api_get(f"/segments/explore?{q}").get("segments") or []
            for x in res:
                if x["id"] not in seen:
                    seen.add(x["id"])
                    _add_explored(x)
                    wanted[str(x["id"])] = time.time()
            sc["found"] = len(seen)
            if len(res) >= 10 and (b[2] - b[0]) > MIN_CELL * 1.5:
                ms, mw = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
                queue[0:0] = [[b[0], b[1], ms, mw], [b[0], mw, ms, b[3]], [ms, b[1], b[2], mw], [ms, mw, b[2], b[3]]]
            cells[key] = time.time()  # split cells too: their quarters are searched straight after
            sc["done"] += 1
            if sc["done"] % 10 == 0:
                _save_segments()
                _write(CELLS_FILE, cells)
                _wake.set()
    except Exception as ex:
        sc["error"] = str(ex)[:200]
    finally:
        _save_segments()
        _write(CELLS_FILE, cells)
        sc.update(running=False, queued=len(queue))
        _wake.set()


def start_scan(bbox):
    s, w, n, e = bbox
    if not (n > s and e > w) or (n - s) * (e - w) > MAX_SCAN_AREA:
        raise ValueError("zoom in: one search covers at most about 50 x 50 km")
    if state["scan"]["running"]:
        return False
    threading.Thread(target=scan, args=(bbox,), daemon=True).start()
    return True


# ---------- adding by hand ----------
def parse_id(text):
    m = re.search(r"segments/(\d+)", text or "") or re.match(r"^\s*(\d{3,})\s*$", text or "")
    return m.group(1) if m else None


def add_segment(text):
    sid = parse_id(text)
    if not sid:
        raise ValueError("paste a Strava segment link (strava.com/segments/123...) or its number")
    seg = refresh_one(sid)
    if not seg.get("coords"):
        with lock:
            segments.pop(sid, None)
        _save_segments()
        raise ValueError("couldn't get that segment's shape (VeloViewer doesn't know it yet: open it on veloviewer.com once, then try again)")
    seg["manual"] = True
    wanted[sid] = time.time()
    _save_segments()
    return public(seg)


def hide(sid, hidden=True):
    with lock:
        if str(sid) in segments:
            segments[str(sid)]["hidden"] = hidden
    _save_segments()


# ---------- what the app sees ----------
def public(seg):
    return {k: seg.get(k) for k in ("id", "name", "place", "distance", "grade", "climb", "coords", "has_ele",
                                     "top", "target", "target_rank", "lb_at", "hazardous", "manual", "hidden")}


def in_bbox(bbox):
    s, w, n, e = bbox
    out = []
    now = time.time()
    with lock:
        for sid, seg in segments.items():
            c = seg.get("coords")
            if not c:
                continue
            if any(s <= p[1] <= n and w <= p[0] <= e for p in (c[0], c[-1])):
                out.append(public(seg))
                wanted[sid] = now
    _wake.set()
    return out


def status():
    tok = _token() if configured() else {}
    with lock:
        n = sum(1 for s in segments.values() if s.get("coords"))
        with_lb = sum(1 for s in segments.values() if s.get("lb_at"))
        now = time.time()
        due = sum(1 for s in wanted if s in segments and now - (segments[s].get("lb_at") or 0) > LB_TTL)
    return {"configured": configured(), "connected": connected(), "athlete": tok.get("athlete"),
            "segments": n, "with_times": with_lb, "times_queued": due, "times_error": state["lb_error"],
            "scan": state["scan"]}


def start():
    threading.Thread(target=lb_worker, daemon=True).start()
