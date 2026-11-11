"""Cycle Planner history service.

Syncs GPS tracks of outdoor rides from intervals.icu and serves them to the web app.
Standard library only.

Env:
  ICU_API_KEY      intervals.icu API key (Settings > Developer Settings). Without it the service idles.
  ICU_ATHLETE_ID   defaults to 0 (the athlete the key belongs to)
  HISTORY_SINCE    first date to sync, default 2015-01-01
  SYNC_HOURS       automatic sync interval, default 6 (0 = only when asked)
  DATA_DIR         default /data
"""
import base64
import datetime as dt
import json
import math
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API_KEY = os.environ.get("ICU_API_KEY", "").strip()
ATHLETE = os.environ.get("ICU_ATHLETE_ID", "0").strip() or "0"
SINCE = os.environ.get("HISTORY_SINCE", "2015-01-01")
SYNC_HOURS = float(os.environ.get("SYNC_HOURS", "6"))
BASE = os.environ.get("ICU_BASE", "https://intervals.icu").rstrip("/")
DATA = os.path.join(os.environ.get("DATA_DIR", "/data"), "history")
TRACKS = os.path.join(DATA, "tracks")
STATE = os.path.join(DATA, "state.json")

RIDE_TYPES = {"Ride", "GravelRide", "MountainBikeRide", "EBikeRide", "EMountainBikeRide"}

lock = threading.Lock()
status = {"syncing": False, "progress": "", "error": None, "last_sync": None}


def api(path):
    req = urllib.request.Request(BASE + path)
    token = base64.b64encode(f"API_KEY:{API_KEY}".encode()).decode()
    req.add_header("Authorization", f"Basic {token}")
    req.add_header("Accept", "application/json")
    # intervals.icu sits behind Cloudflare, which blocks Python's default user agent (error 1010).
    req.add_header("User-Agent", "cycleplanner-history/1.0 (+https://github.com/dabsy1111/cycleplanner)")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise RuntimeError("intervals.icu rejected the API key (401). Check ICU_API_KEY.") from e
        raise


def simplify(points, min_gap=12.0):
    """Drop points closer than min_gap metres to the last kept one (keeps files small)."""
    out = []
    for lng, lat in points:
        if out:
            plng, plat = out[-1]
            dx = (lng - plng) * 111320 * math.cos(math.radians(lat))
            dy = (lat - plat) * 110574
            if dx * dx + dy * dy < min_gap * min_gap:
                continue
        out.append((round(lng, 5), round(lat, 5)))
    return out


def rdp(points, tol_m=6.0):
    """Douglas-Peucker: keep only the points needed to stay within tol_m of the original line."""
    if len(points) < 3:
        return points
    lat0 = math.radians(points[0][1])
    kx, ky = 111320 * math.cos(lat0), 110574
    xy = [(p[0] * kx, p[1] * ky) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    tol2 = tol_m * tol_m
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        worst, wi = -1.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            if len2:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len2))
                ex, ey = ax + t * dx - px, ay + t * dy - py
            else:
                ex, ey = px - ax, py - ay
            d2 = ex * ex + ey * ey
            if d2 > worst:
                worst, wi = d2, i
        if worst > tol2:
            keep[wi] = True
            stack.append((a, wi))
            stack.append((wi, b))
    return [p for p, k in zip(points, keep) if k]


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(s):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, STATE)


def sync():
    with lock:
        if status["syncing"]:
            return
        status.update(syncing=True, progress="listing activities", error=None)
    try:
        os.makedirs(TRACKS, exist_ok=True)
        state = load_state()
        skipped = set(state.get("skipped", []))
        today = (dt.date.today() + dt.timedelta(days=1)).isoformat()
        acts = api(f"/api/v1/athlete/{ATHLETE}/activities?oldest={SINCE}&newest={today}")
        todo = []
        for a in acts:
            aid = str(a.get("id", ""))
            if not aid or aid in skipped or os.path.exists(os.path.join(TRACKS, aid + ".json")):
                continue
            # Indoor, virtual and non-cycling activities have no real route.
            if a.get("type") not in RIDE_TYPES or a.get("trainer"):
                continue
            todo.append(a)
        for n, a in enumerate(todo, 1):
            aid = str(a["id"])
            status["progress"] = f"{n} of {len(todo)} new rides"
            try:
                streams = api(f"/api/v1/activity/{aid}/streams.json?types=latlng")
            except urllib.error.HTTPError as e:
                if e.code in (403, 404, 422):  # e.g. Strava-sourced rides the API can't share
                    skipped.add(aid)
                    continue
                raise
            ll = next((s for s in streams if s.get("type") == "latlng"), None) if isinstance(streams, list) else None
            pts = []
            if ll and ll.get("data") and ll.get("data2"):
                pts = [(lng, lat) for lat, lng in zip(ll["data"], ll["data2"])
                       if lat is not None and lng is not None and (lat or lng)]
            pts = simplify(pts)
            if len(pts) < 2:
                skipped.add(aid)
                continue
            rec = {"id": aid, "name": a.get("name") or "", "date": (a.get("start_date_local") or "")[:10],
                   "distance": a.get("distance"), "coords": pts}
            with open(os.path.join(TRACKS, aid + ".json"), "w") as f:
                json.dump(rec, f)
            time.sleep(0.2)  # be polite to intervals.icu
        state["skipped"] = sorted(skipped)
        state["last_sync"] = time.time()
        save_state(state)
        status["last_sync"] = state["last_sync"]
        update_network()
    except Exception as e:  # report and carry on; the next sync retries
        status["error"] = str(e)[:200]
    finally:
        status.update(syncing=False, progress="")


def ride_count():
    try:
        return len([f for f in os.listdir(TRACKS) if f.endswith(".json")])
    except OSError:
        return 0


# ---------- merged "ridden roads" network ----------
# Every road you've ridden is stored once: a ride only adds the parts that aren't
# already within ~15 m of something ridden before. 750 overlapping rides become one layer.
NETWORK = os.path.join(DATA, "network.json")
NETWORK_VERSION = 1
CELL_LAT, CELL_LNG = 0.0001, 0.000118  # ~11 m cells around Perth
net = {"rides": set(), "lines": [], "cells": set(), "body": None}
net_lock = threading.Lock()


def _cell(lng, lat):
    return (int(math.floor(lng / CELL_LNG)), int(math.floor(lat / CELL_LAT)))


def _covered(lng, lat):
    cx, cy = _cell(lng, lat)
    cells = net["cells"]
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if (cx + dx, cy + dy) in cells:
                return True
    return False


def _densify(coords, step=8.0):
    out = []
    for i, (lng, lat) in enumerate(coords):
        if i:
            plng, plat = coords[i - 1]
            d = math.hypot((lng - plng) * 111320 * math.cos(math.radians(lat)), (lat - plat) * 110574)
            n = int(d // step)
            for k in range(1, n + 1):
                t = k / (n + 1)
                out.append((plng + t * (lng - plng), plat + t * (lat - plat)))
        out.append((lng, lat))
    return out


def _mark(coords):
    for lng, lat in _densify(coords):
        net["cells"].add(_cell(lng, lat))


def _add_ride(coords):
    pts = _densify(coords)
    pending = []      # this ride's own points, marked once we're 40 m past them
    seg, new_lines = [], []
    travelled = 0.0
    for i, (lng, lat) in enumerate(pts):
        if i:
            plng, plat = pts[i - 1]
            travelled += math.hypot((lng - plng) * 111320 * math.cos(math.radians(lat)), (lat - plat) * 110574)
        while pending and travelled - pending[0][0] > 40:
            net["cells"].add(_cell(*pending.pop(0)[1]))
        if _covered(lng, lat):
            if seg:
                seg.append((lng, lat))  # join onto the road already ridden
                if len(seg) >= 3:
                    new_lines.append(seg)
                seg = []
        else:
            if not seg and i:
                seg.append(pts[i - 1])
            seg.append((lng, lat))
        pending.append((travelled, (lng, lat)))
    if len(seg) >= 2:
        new_lines.append(seg)
    for _, p in pending:
        net["cells"].add(_cell(*p))
    for line in new_lines:
        simple = rdp([(round(a, 5), round(b, 5)) for a, b in line])
        if len(simple) >= 2:
            net["lines"].append(simple)


def _save_network():
    tmp = NETWORK + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"version": NETWORK_VERSION, "rides": sorted(net["rides"]), "lines": net["lines"]}, f,
                  separators=(",", ":"))
    os.replace(tmp, NETWORK)


def update_network():
    """Add any synced rides that aren't in the network yet (all of them on the first run)."""
    with net_lock:
        if not net["rides"] and os.path.exists(NETWORK):
            try:
                with open(NETWORK) as f:
                    saved = json.load(f)
                if saved.get("version") == NETWORK_VERSION:
                    net["rides"] = set(saved["rides"])
                    net["lines"] = saved["lines"]
                    for line in net["lines"]:
                        _mark(line)
            except (OSError, ValueError, KeyError):
                pass
        try:
            files = sorted(f for f in os.listdir(TRACKS) if f.endswith(".json"))
        except OSError:
            files = []
        todo = [f for f in files if f[:-5] not in net["rides"]]
        for n, fn in enumerate(todo, 1):
            status["progress"] = f"merging rides into one layer, {n} of {len(todo)}"
            try:
                with open(os.path.join(TRACKS, fn)) as f:
                    _add_ride([tuple(c) for c in json.load(f)["coords"]])
            except (OSError, ValueError, KeyError):
                pass
            net["rides"].add(fn[:-5])
        if todo or net["body"] is None:
            if todo:
                _save_network()
            net["body"] = json.dumps({"type": "FeatureCollection", "features": [{
                "type": "Feature", "properties": {"rides": len(net["rides"])},
                "geometry": {"type": "MultiLineString", "coordinates": net["lines"]}}]},
                separators=(",", ":")).encode()
        status["progress"] = ""


def tracks_body():
    if net["body"] is None:
        update_network()
    return net["body"]


# ---------- saved routes, short links and shared settings ----------
ROUTES = os.path.join(os.environ.get("DATA_DIR", "/data"), "routes")
SETTINGS = os.path.join(os.environ.get("DATA_DIR", "/data"), "settings.json")
routes_lock = threading.Lock()
ID_CHARS = "abcdefghijkmnpqrstuvwxyz23456789"  # no lookalikes (l/1, o/0)


def _new_id():
    import secrets
    while True:
        rid = "".join(secrets.choice(ID_CHARS) for _ in range(6))
        if not os.path.exists(os.path.join(ROUTES, rid + ".json")):
            return rid


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def route_list():
    out = []
    try:
        names = os.listdir(ROUTES)
    except OSError:
        return out
    for fn in names:
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(ROUTES, fn)) as f:
                r = json.load(f)
        except (OSError, ValueError):
            continue
        if r.get("saved"):
            out.append({k: r.get(k) for k in ("id", "name", "km", "profile", "created")})
    return sorted(out, key=lambda r: r.get("created") or 0, reverse=True)


def route_create(body):
    wp = body.get("wp")
    if not isinstance(wp, list) or len(wp) < 2 or len(wp) > 200:
        raise ValueError("a route needs 2-200 waypoints")
    rec = {
        "id": _new_id(), "created": time.time(),
        "name": str(body.get("name") or "")[:120], "saved": bool(body.get("saved")),
        "profile": str(body.get("profile") or "fastbike")[:40],
        "km": body.get("km"), "options": body.get("options") if isinstance(body.get("options"), dict) else {},
        "wp": [{"lng": float(p["lng"]), "lat": float(p["lat"])} for p in wp],
    }
    with routes_lock:
        os.makedirs(ROUTES, exist_ok=True)
        # Saving under an existing name replaces that route.
        if rec["saved"]:
            for old in route_list():
                if old["name"] == rec["name"]:
                    rec["id"] = old["id"]
        _write_json(os.path.join(ROUTES, rec["id"] + ".json"), rec)
    return rec


def route_get(rid):
    if not rid.isalnum():
        return None
    try:
        with open(os.path.join(ROUTES, rid + ".json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def route_delete(rid):
    if rid.isalnum():
        try:
            os.remove(os.path.join(ROUTES, rid + ".json"))
        except OSError:
            pass


def settings_get():
    try:
        with open(SETTINGS) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def settings_put(key, value):
    with routes_lock:
        s = settings_get()
        s[key] = value
        _write_json(SETTINGS, s)


# ---------- athlete (FTP and weight for ride-time estimates) ----------
athlete_cache = {"at": 0, "data": None}


def athlete_info():
    if not API_KEY:
        return None
    if athlete_cache["data"] and time.time() - athlete_cache["at"] < 6 * 3600:
        return athlete_cache["data"]
    a = api(f"/api/v1/athlete/{ATHLETE}")
    weight = a.get("icu_weight") or a.get("weight")
    ftp = None
    for s in a.get("sportSettings") or []:
        if "Ride" in (s.get("types") or []):
            ftp = s.get("ftp") or s.get("indoor_ftp")
            break
    data = {"ftp": ftp, "weight": weight}
    athlete_cache.update(at=time.time(), data=data)
    return data


# ---------- Overpass proxy with a disk cache ----------
# Toilets, water, cafés, lights and paths change slowly: answers are kept for a week, and an
# old answer is served if every Overpass server is down or rate-limiting.
OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
                 "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
OVERPASS_CACHE = os.path.join(os.environ.get("DATA_DIR", "/data"), "overpass")
OVERPASS_TTL = 7 * 86400


def overpass_query(q):
    import hashlib
    os.makedirs(OVERPASS_CACHE, exist_ok=True)
    path = os.path.join(OVERPASS_CACHE, hashlib.sha256(q.encode()).hexdigest()[:32] + ".json")
    try:
        if time.time() - os.stat(path).st_mtime < OVERPASS_TTL:
            with open(path, "rb") as f:
                return f.read(), "hit"
    except OSError:
        pass
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for url in OVERPASS_URLS:
        try:
            req = urllib.request.Request(url, data=data, headers={
                "User-Agent": "cycleplanner/1.0 (+https://github.com/dabsy1111/cycleplanner)",
                "Content-Type": "application/x-www-form-urlencoded"})
            with urllib.request.urlopen(req, timeout=90) as r:
                body = r.read()
            json.loads(body)  # only cache real answers
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(body)
            os.replace(tmp, path)
            return body, "miss"
        except Exception as e:
            last = e
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read(), "stale"
    raise RuntimeError(f"Overpass unavailable: {last}")


# ---------- bike paths: a local copy for the loop generator ----------
# One Overpass download of every bike path in the area, refreshed weekly, so the loop
# generator doesn't wait on Overpass every time it snaps points to paths.
BIKEPATHS = os.path.join(os.environ.get("DATA_DIR", "/data"), "bikepaths.json")
BIKEPATH_BBOX = os.environ.get("BIKEPATH_BBOX", "-32.80,115.55,-31.40,116.30")  # south,west,north,east: Mandurah to Two Rocks, coast to the hills
BIKEPATH_DAYS = float(os.environ.get("BIKEPATH_DAYS", "7"))
BP_CELL = 0.005  # must match SNAP_CELL in app/loops.js
bikepaths = {"cells": None, "updated": None, "error": None}


def _load_bikepaths():
    try:
        with open(BIKEPATHS) as f:
            d = json.load(f)
        bikepaths["cells"], bikepaths["updated"] = d["cells"], d["updated"]
    except (OSError, ValueError, KeyError):
        pass


def _overpass_ways(bbox):
    q = f"""[out:json][timeout:180];
(
  way["highway"="cycleway"]({bbox});
  way["highway"~"^(path|footway)$"]["bicycle"="designated"]({bbox});
);
out skel geom;"""
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for attempt in range(6):
        for url in OVERPASS_URLS:
            try:
                req = urllib.request.Request(url, data=data, headers={
                    "User-Agent": "cycleplanner/1.0 (+https://github.com/dabsy1111/cycleplanner)",
                    "Content-Type": "application/x-www-form-urlencoded"})
                with urllib.request.urlopen(req, timeout=240) as r:
                    return json.loads(r.read()).get("elements") or []
            except Exception as e:
                last = e
        time.sleep(30 * 2 ** attempt)  # Overpass is busy: back off (30 s up to 16 min)
    raise RuntimeError(str(last))


def refresh_bikepaths():
    # The whole area in one query is too big for Overpass, so fetch it in ~25 km tiles.
    s, w, n, e = [float(v) for v in BIKEPATH_BBOX.split(",")]
    STEP = 0.25
    cells, ways = {}, 0
    lat = s
    try:
        while lat < n:
            lng = w
            while lng < e:
                tile = f"{lat:.4f},{lng:.4f},{min(n, lat + STEP):.4f},{min(e, lng + STEP):.4f}"
                for el in _overpass_ways(tile):
                    ways += 1
                    for g in el.get("geometry") or []:
                        k = f"{math.floor(g['lon'] / BP_CELL)}:{math.floor(g['lat'] / BP_CELL)}"
                        cells.setdefault(k, []).append([round(g["lon"], 5), round(g["lat"], 5)])
                time.sleep(2)  # be polite to the public server
                lng += STEP
            lat += STEP
    except RuntimeError as err:
        bikepaths["error"] = f"download failed: {err}"[:200]
        print(f"bike paths: download failed ({err}), keeping the old copy", flush=True)
        return
    if ways < 100:  # a broken answer: keep the copy we have
        bikepaths["error"] = f"only {ways} paths returned"
        return
    updated = time.strftime("%Y-%m-%d %H:%M", time.localtime())
    _write_json(BIKEPATHS, {"updated": updated, "bbox": BIKEPATH_BBOX, "cells": cells})
    bikepaths.update(cells=cells, updated=updated, error=None)
    print(f"bike paths: {ways} ways, {len(cells)} cells", flush=True)


def bikepath_scheduler():
    _load_bikepaths()
    while True:
        try:
            fresh = os.path.exists(BIKEPATHS) and time.time() - os.stat(BIKEPATHS).st_mtime < BIKEPATH_DAYS * 86400
            if not fresh:
                refresh_bikepaths()
        except Exception as e:
            bikepaths["error"] = str(e)[:200]
        time.sleep(3600)  # checks hourly; it only downloads once the copy is a week old (or missing)


def bikepaths_in(bbox):
    cells = bikepaths["cells"]
    if cells is None:
        return None
    s, w, n, e = bbox
    out = {}
    for cx in range(math.floor(w / BP_CELL), math.floor(e / BP_CELL) + 1):
        for cy in range(math.floor(s / BP_CELL), math.floor(n / BP_CELL) + 1):
            pts = cells.get(f"{cx}:{cy}")
            if pts:
                out[f"{cx}:{cy}"] = pts
    return out


def scheduler():
    if not API_KEY:
        return
    while True:
        sync()
        if SYNC_HOURS <= 0:
            return
        time.sleep(SYNC_HOURS * 3600)


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            raise ValueError("too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path == "/api/routes":
            self.send(200, json.dumps(route_list()).encode())
        elif path == "/api/athlete":
            try:
                info = athlete_info()
            except Exception as e:
                self.send(502, json.dumps({"error": str(e)[:200]}).encode())
                return
            self.send(200 if info else 404, json.dumps(info or {"error": "ICU_API_KEY not set"}).encode())
        elif path.startswith("/api/routes/"):
            r = route_get(path.rsplit("/", 1)[1])
            self.send(200 if r else 404, json.dumps(r or {"error": "not found"}).encode())
        elif path.startswith("/api/settings/"):
            key = path.rsplit("/", 1)[1]
            self.send(200, json.dumps(settings_get().get(key)).encode())
        elif path == "/api/history/status":
            if status["last_sync"] is None:
                status["last_sync"] = load_state().get("last_sync")
            body = {"configured": bool(API_KEY), "rides": ride_count(), **status}
            self.send(200, json.dumps(body).encode())
        elif path == "/api/bikepaths":
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            try:
                bbox = [float(v) for v in (qs.get("bbox") or [""])[0].split(",")]
                assert len(bbox) == 4 and (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) < 4
            except (ValueError, AssertionError):
                self.send(400, b'{"error":"bbox=s,w,n,e"}')
                return
            cells = bikepaths_in(bbox)
            if cells is None:
                self.send(503, json.dumps({"error": bikepaths["error"] or "still downloading"}).encode())
                return
            s, w, n, e = [float(v) for v in BIKEPATH_BBOX.split(",")]
            covered = bbox[0] >= s and bbox[1] >= w and bbox[2] <= n and bbox[3] <= e
            self.send(200, json.dumps({"updated": bikepaths["updated"], "covered": covered, "cells": cells}, separators=(",", ":")).encode())
        elif path == "/api/history/tracks":
            self.send(200, tracks_body())
        else:
            self.send(404, b'{"error":"not found"}')

    def do_DELETE(self):
        path = self.path.split("?")[0].rstrip("/")
        if path.startswith("/api/routes/"):
            route_delete(path.rsplit("/", 1)[1])
            self.send(204, b"")
        else:
            self.send(404, b'{"error":"not found"}')

    def do_PUT(self):
        path = self.path.split("?")[0].rstrip("/")
        if path.startswith("/api/settings/"):
            try:
                settings_put(path.rsplit("/", 1)[1][:40], self.body_json())
            except ValueError as e:
                self.send(400, json.dumps({"error": str(e)}).encode())
                return
            self.send(204, b"")
        else:
            self.send(404, b'{"error":"not found"}')

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") == "/api/overpass":
            n = int(self.headers.get("Content-Length") or 0)
            form = urllib.parse.parse_qs(self.rfile.read(min(n, 100_000)).decode())
            q = (form.get("data") or [""])[0]
            if not q:
                self.send(400, b'{"error":"no query"}')
                return
            try:
                body, state = overpass_query(q)
            except RuntimeError as e:
                self.send(502, json.dumps({"error": str(e)[:300]}).encode())
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Cache", state)
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.split("?")[0].rstrip("/") == "/api/routes":
            try:
                rec = route_create(self.body_json())
            except (ValueError, KeyError, TypeError) as e:
                self.send(400, json.dumps({"error": str(e)}).encode())
                return
            self.send(201, json.dumps(rec).encode())
            return
        if self.path.split("?")[0].rstrip("/") == "/api/history/sync":
            if not API_KEY:
                self.send(400, b'{"error":"ICU_API_KEY is not set"}')
                return
            threading.Thread(target=sync, daemon=True).start()
            self.send(202, b'{"started":true}')
        else:
            self.send(404, b'{"error":"not found"}')

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.makedirs(TRACKS, exist_ok=True)
    threading.Thread(target=update_network, daemon=True).start()
    threading.Thread(target=scheduler, daemon=True).start()
    threading.Thread(target=bikepath_scheduler, daemon=True).start()
    print(f"History service on :8000 ({'connected to intervals.icu' if API_KEY else 'no ICU_API_KEY set'})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
