"""Segment hunter: Strava segments, their top-10 times, and their shape. Standard library only.

Where each piece comes from (none of it needs a Strava login or API key):
  - The list of segments: bikeclimbs.com, which lists every Strava ride segment with an uphill
    average (even 0.1%) by council and suburb, with its Strava ID, start point, length and grade.
    Each area page carries up to 1,000 of them as JSON, so the whole Perth area is a few hundred
    page loads. Imported once in the background (pages GAP seconds apart), refreshed every
    BIKECLIMBS_DAYS, and only for areas that turned out to have segments inside BIKEPATH_BBOX.
    Downhill segments aren't on bikeclimbs; add those by link.
  - Top 10: Strava's public segment widget (strava.com/segments/<id>/embed), the same one
    VeloViewer shows on its Leaderboard tab. Athletes who hide themselves are left out of it, so a
    rank can be missing (1, 2, 4, 5, 8...).
  - Shape and elevation: VeloViewer's segment streams.
  Top 10 and shape are fetched only for segments you look at (in the map view, up to your
  length limit), one every few seconds, and the top 10 again weekly.

(Strava's own segment search, segments/explore, has been closed to everyone but approved
"Extended Access" apps since 1 Sep 2026, and the rest of its API needs a paid subscription.)

Everything is kept under DATA_DIR/strava.

Env:
  STRAVA_LB_DAYS     refresh top-10 times this often (default 7)
  STRAVA_GAP         seconds between requests to bikeclimbs, Strava and VeloViewer (default 3)
  BIKECLIMBS_DAYS    refresh the segment list this often (default 90; 0 = don't build it)
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

LB_TTL = float(os.environ.get("STRAVA_LB_DAYS", "7")) * 86400
GAP = float(os.environ.get("STRAVA_GAP", "3"))
BC_TTL = float(os.environ.get("BIKECLIMBS_DAYS", "90")) * 86400
DIR = os.path.join(os.environ.get("DATA_DIR", "/data"), "strava")
SEG_FILE = os.path.join(DIR, "segments.json")
AREAS_FILE = os.path.join(DIR, "bikeclimbs-areas.json")

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 cycleplanner"
BC = "https://bikeclimbs.com/climb/australia/western-australia"

lock = threading.RLock()
state = {
    "import": {"running": False, "done": 0, "total": 0, "error": None},
    "lb_error": None, "lb_last": None,
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
areas = _read(AREAS_FILE, {})    # bikeclimbs area slug -> {"at": time fetched, "inside": segments in the bbox}
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


# ---------- the segment list, from bikeclimbs ----------
def _bc_page(path):
    body, _ = _get(f"{BC}/{path}" if path else BC, timeout=60)
    return body.decode("utf-8", "replace")


def _bc_segments(text):
    """The mapSegments list on a bikeclimbs area page -> (list of dicts, truncated?).
    It sits inside a JavaScript string (a Next.js data chunk): find that string, unescape it,
    then parse the list where it starts."""
    k = text.find('\\"mapSegments\\":')
    if k < 0:
        return [], False
    lo = text.rfind('push([1,"', 0, k)
    hi = text.find('"])', k)
    if lo < 0 or hi < 0:
        return [], False
    try:
        chunk = json.loads(text[lo + 8:hi + 1])
        at = chunk.index('"mapSegments":') + len('"mapSegments":')
        segs, _ = json.JSONDecoder().raw_decode(chunk, at)
        trunc = re.search(r'"isMapTruncated":(true|false)', chunk)
    except ValueError:
        return [], False
    return segs, bool(trunc and trunc.group(1) == "true")


def _inside(lat, lon, bbox):
    s, w, n, e = bbox
    return s <= lat <= n and w <= lon <= e


def _add_bc(x):
    sid = str(x["stravaId"])
    with lock:
        seg = segments.get(sid) or {"id": x["stravaId"]}
        seg.update(name=x.get("name") or seg.get("name"), distance=x.get("distance"),
                   grade=round(x.get("averageGrade") or 0, 2), start=[x["startLongitude"], x["startLatitude"]],
                   place=seg.get("place") or (x.get("suburbDisplay") or x.get("suburb") or "").replace("-", " ").title() or None)
        segments[sid] = seg


def import_bikeclimbs(bbox):
    """Walk bikeclimbs' WA areas, keep segments starting inside bbox. Areas known to be outside
    the bbox (no segments in it last time) are skipped until the next full refresh a year on."""
    st = state["import"]
    st.update(running=True, done=0, error=None)
    try:
        index = _bc_page("")
        slugs = sorted(set(re.findall(r'href="/climb/australia/western-australia/([a-z0-9-]+)"', index)))
        now = time.time()
        todo = [x for x in slugs if now - areas.get(x, {}).get("at", 0) > (BC_TTL if areas.get(x, {}).get("inside") else 365 * 86400)]
        st["total"] = len(todo)
        while todo:
            slug = todo.pop(0)
            time.sleep(GAP)
            try:
                text = _bc_page(slug)
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(600)
                    todo.insert(0, slug)
                    continue
                areas[slug] = {"at": time.time(), "inside": 0, "error": e.code}
                st["done"] += 1
                continue
            segs, trunc = _bc_segments(text)
            inside = [x for x in segs if x.get("startLatitude") is not None and _inside(x["startLatitude"], x["startLongitude"], bbox)]
            for x in inside:
                _add_bc(x)
            if trunc and (inside or not segs):
                # More than 1,000 segments here: its suburbs (one level down) each get their own page.
                subs = sorted(set(re.findall(rf'href="/climb/australia/western-australia/{re.escape(slug)}/([a-z0-9-]+)"', text)))
                todo[0:0] = [f"{slug}/{x}" for x in subs if now - areas.get(f"{slug}/{x}", {}).get("at", 0) > BC_TTL]
                st["total"] += len(subs)
            areas[slug] = {"at": time.time(), "inside": len(inside)}
            st["done"] += 1
            if st["done"] % 10 == 0:
                _save_segments()
                _write(AREAS_FILE, areas)
    except Exception as ex:
        st["error"] = str(ex)[:200]
    finally:
        _save_segments()
        _write(AREAS_FILE, areas)
        st["running"] = False
        st["at"] = time.time()


def import_scheduler(bbox):
    """Import the segment list at start-up if it's due, then check daily."""
    while True:
        if not state["import"]["running"]:
            import_bikeclimbs(bbox)
        time.sleep(86400)


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
    out = {k: seg.get(k) for k in ("id", "name", "place", "distance", "grade", "start", "coords", "has_ele",
                                    "top", "target", "target_rank", "lb_at", "hazardous", "manual", "hidden")}
    if not out["start"] and seg.get("coords"):
        out["start"] = seg["coords"][0][:2]
    return out


def in_bbox(bbox, max_m=None):
    """Segments starting in the view. Those within the length limit go to the front of the queue
    for top-10 times and shape."""
    s, w, n, e = bbox
    out = []
    now = time.time()
    with lock:
        for sid, seg in segments.items():
            st = seg.get("start") or (seg["coords"][0] if seg.get("coords") else None)
            if not st or not (s <= st[1] <= n and w <= st[0] <= e):
                continue
            out.append(public(seg))
            if not seg.get("hidden") and (max_m is None or (seg.get("distance") or 0) <= max_m):
                wanted[sid] = now
    _wake.set()
    return out


def status():
    with lock:
        n = len(segments)
        with_lb = sum(1 for s in segments.values() if s.get("lb_at"))
        now = time.time()
        due = sum(1 for s in wanted if s in segments and now - (segments[s].get("lb_at") or 0) > LB_TTL
                  and now - (segments[s].get("lb_fail") or 0) > 3600)
    return {"segments": n, "with_times": with_lb, "times_queued": due, "times_error": state["lb_error"],
            "import": state["import"], "areas": sum(1 for a in areas.values() if a.get("inside"))}


def start(bbox):
    threading.Thread(target=lb_worker, daemon=True).start()
    if BC_TTL > 0:  # BIKECLIMBS_DAYS=0 turns the list import off (segments by link only)
        threading.Thread(target=import_scheduler, args=(bbox,), daemon=True).start()
