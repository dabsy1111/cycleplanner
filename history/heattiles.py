"""Popularity heatmap tiles: fetch from your heatmap proxy and keep them on disk.

Shared by the map overlay (served to the browser through nginx at /tiles/heat/...) and, later,
by the routing weights, which read the same cached PNGs. Standard library only.

Env:
  HEATMAP_URL   tile URL template of your heatmap proxy, e.g.
                http://host.docker.internal:8080/{activity}/{color}/{z}/{x}/{y}.png
                Empty = heatmap off.
  HEATMAP_DAYS  keep cached tiles this many days before asking the proxy again (default 90).
                The heatmap is built from years of rides, so it barely changes. Older tiles are
                still served if the proxy is down, and nothing is ever deleted.
  HEATMAP_GAP   seconds between requests to the proxy (default 0.3), so it never gets a burst.
  DATA_DIR      tiles go in DATA_DIR/heat/tiles/<activity>/<color>/<z>/<x>/<y>.png
"""
import os
import re
import struct
import threading
import time
import urllib.error
import urllib.request
import zlib

URL = os.environ.get("HEATMAP_URL", "").strip()
TTL = float(os.environ.get("HEATMAP_DAYS", "90")) * 86400
GAP = float(os.environ.get("HEATMAP_GAP", "0.3"))
CACHE = os.path.join(os.environ.get("DATA_DIR", "/data"), "heat", "tiles")
MIN_Z, MAX_Z = 0, 20

# A tile with no heat (proxy said 404/204, or sent nothing) is remembered as an empty marker
# file just as long, so nothing keeps asking for ocean and bush.
EMPTY_TTL = TTL
PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _blank_png():
    """1x1 transparent PNG, sent in place of tiles with no data so MapLibre draws nothing."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)  # 1x1, 8-bit RGBA
    return PNG_SIG + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00\x00")) + chunk(b"IEND", b"")


BLANK_PNG = _blank_png()

NAME = re.compile(r"^[A-Za-z0-9_-]{1,24}$")

# At most 2 requests to the proxy at once, and at least GAP seconds between starting them.
upstream_slots = threading.BoundedSemaphore(2)
_gap_lock = threading.Lock()
_last_start = [0.0]


def _wait_turn():
    with _gap_lock:
        wait = _last_start[0] + GAP - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_start[0] = time.monotonic()
# One fetch per tile at a time: a second request for the same tile waits for the first.
_key_locks = {}
_key_locks_guard = threading.Lock()
# After a failed fetch (proxy down, refused, timed out) don't try again for 30 s; serve what's
# cached instead. Stops a screenful of tile requests each waiting out its own timeout.
# A proxy that answers but refuses one activity/colour (e.g. HTTP 500 for a scheme it doesn't
# have) only backs off that layer, so the other layers keep loading.
BACKOFF = 30
state = {"down_until": 0.0, "last_error": None, "last_ok": None, "fetched": 0, "served": 0,
         "layer_down": {}, "layer_error": {}}


class LayerRefused(RuntimeError):
    """The proxy is up but won't serve this activity/colour."""


def configured():
    return bool(URL)


def valid(activity, color, z, x, y):
    if not (NAME.match(activity) and NAME.match(color)):
        return False
    if not MIN_Z <= z <= MAX_Z:
        return False
    n = 1 << z
    return 0 <= x < n and 0 <= y < n


def tile_path(activity, color, z, x, y):
    return os.path.join(CACHE, activity, color, str(z), str(x), f"{y}.png")


def _lock_for(key):
    with _key_locks_guard:
        lk = _key_locks.get(key)
        if lk is None:
            lk = _key_locks[key] = threading.Lock()
        return lk


def _read_cached(path):
    """(body, age_seconds) from disk, or (None, None). body is b'' for a known-empty tile."""
    for p, is_empty in ((path, False), (path + ".empty", True)):
        try:
            age = time.time() - os.stat(p).st_mtime
        except OSError:
            continue
        if is_empty:
            return b"", age
        with open(p, "rb") as f:
            return f.read(), age
    return None, None


def _write(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if body:
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, path)
        try:
            os.remove(path + ".empty")
        except OSError:
            pass
    else:
        with open(path + ".empty", "wb"):
            pass


def _fetch(activity, color, z, x, y):
    """Ask the proxy for one tile. Returns PNG bytes, or b'' if the proxy has no data there.
    Raises on anything that looks like the proxy being down or misconfigured."""
    url = URL.format(activity=activity, color=color, z=z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": "cycleplanner-heat/1.0"})
    try:
        with upstream_slots:
            _wait_turn()
            with urllib.request.urlopen(req, timeout=15) as r:
                body = r.read()
                if r.status == 204 or not body:
                    return b""
    except urllib.error.HTTPError as e:
        if e.code in (204, 404):
            return b""
        raise LayerRefused(f"heatmap proxy answered HTTP {e.code} for {url}") from e
    if not body.startswith(PNG_SIG):
        raise LayerRefused(f"heatmap proxy sent something that isn't a PNG for {url}")
    return body


def get_tile(activity, color, z, x, y, allow_fetch=True):
    """Returns (body, cache_state). body is PNG bytes, b'' for 'no heat here', or None if the
    tile isn't cached and the proxy can't be reached. cache_state: hit | miss | stale | empty | down."""
    path = tile_path(activity, color, z, x, y)
    body, age = _read_cached(path)
    fresh = body is not None and age < (EMPTY_TTL if body == b"" else TTL)
    if fresh:
        state["served"] += 1
        return body, "empty" if body == b"" else "hit"
    layer = f"{activity}/{color}"
    now = time.time()
    if not allow_fetch or not configured() or now < state["down_until"] or now < state["layer_down"].get(layer, 0):
        return body, "stale" if body is not None else "down"

    with _lock_for(path):
        # Someone else may have fetched it while we waited for the lock.
        body2, age2 = _read_cached(path)
        if body2 is not None and age2 < (EMPTY_TTL if body2 == b"" else TTL):
            return body2, "hit"
        try:
            new = _fetch(activity, color, z, x, y)
        except LayerRefused as e:
            state["layer_down"][layer] = time.time() + BACKOFF
            state["layer_error"][layer] = str(e)[:300]
            return body, "stale" if body is not None else "down"
        except Exception as e:  # connection refused, timeout, DNS: the proxy itself is down
            state["down_until"] = time.time() + BACKOFF
            state["last_error"] = str(e)[:300]
            return body, "stale" if body is not None else "down"
        _write(path, new)
        state["fetched"] += 1
        state["last_ok"] = time.time()
        state["last_error"] = None
        state["down_until"] = 0.0
        state["layer_error"].pop(layer, None)
        return new, "empty" if new == b"" else "miss"


def layer_error(activity, color):
    return state["layer_error"].get(f"{activity}/{color}")


def status(activity=None, color=None):
    return {
        "layer_error": layer_error(activity, color) if activity else None,
        "configured": configured(),
        # Only the host part, so the UI can say where it's looking without showing a full URL.
        "upstream": re.sub(r"^(\w+://[^/]+).*$", r"\1", URL) if URL else None,
        "reachable": None if not URL else (state["last_error"] is None),
        "last_error": state["last_error"],
        "last_ok": state["last_ok"],
        "fetched": state["fetched"],
    }


def probe():
    """Ask the proxy for one low-zoom tile (z5 over Perth) to find out whether it's up.
    Any answer, even 'no data' or a refused layer, counts as up."""
    if not configured():
        return
    state["down_until"] = 0.0
    # Read past the cache: the point is to talk to the proxy.
    try:
        _fetch(PROBE[0], PROBE[1], 5, 26, 18)
        state["last_error"], state["last_ok"] = None, time.time()
    except LayerRefused:
        state["last_error"], state["last_ok"] = None, time.time()  # it answered, so it's up
    except Exception as e:
        state["down_until"] = time.time() + BACKOFF
        state["last_error"] = str(e)[:300]


PROBE = ("ride", "hot")
