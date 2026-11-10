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
tracks_cache = {"mtime": None, "body": b'{"type":"FeatureCollection","features":[]}'}


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
    except Exception as e:  # report and carry on; the next sync retries
        status["error"] = str(e)[:200]
    finally:
        status.update(syncing=False, progress="")


def ride_count():
    try:
        return len([f for f in os.listdir(TRACKS) if f.endswith(".json")])
    except OSError:
        return 0


def tracks_body():
    try:
        mtime = os.stat(TRACKS).st_mtime
    except OSError:
        return tracks_cache["body"]
    if mtime != tracks_cache["mtime"]:
        feats = []
        for fn in sorted(os.listdir(TRACKS)):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(TRACKS, fn)) as f:
                    r = json.load(f)
            except (OSError, ValueError):
                continue
            feats.append({"type": "Feature", "properties": {"id": r["id"], "name": r["name"], "date": r["date"]},
                          "geometry": {"type": "LineString", "coordinates": rdp(r["coords"])}})
        tracks_cache.update(mtime=mtime, body=json.dumps({"type": "FeatureCollection", "features": feats},
                                                         separators=(",", ":")).encode())
    return tracks_cache["body"]


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

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path == "/api/history/status":
            if status["last_sync"] is None:
                status["last_sync"] = load_state().get("last_sync")
            body = {"configured": bool(API_KEY), "rides": ride_count(), **status}
            self.send(200, json.dumps(body).encode())
        elif path == "/api/history/tracks":
            self.send(200, tracks_body())
        else:
            self.send(404, b'{"error":"not found"}')

    def do_POST(self):
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
    threading.Thread(target=scheduler, daemon=True).start()
    print(f"History service on :8000 ({'connected to intervals.icu' if API_KEY else 'no ICU_API_KEY set'})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
