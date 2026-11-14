"""Popularity heat as numbers, for scoring routes (Part 2a: rank BRouter's routes, no BRouter changes).

The heatmap PNGs carry popularity in their transparency: every colour scheme from the proxy has
the same alpha channel, 0 where nobody rides, 143 on the faintest track, 255 on the busiest road.
So we keep just that channel, one byte per pixel, and ignore the colours.

Pipeline:
  1. build()  walks every z14 'ride' tile over BIKEPATH_BBOX (Mandurah to Two Rocks), nearest to
     the middle first. Tiles come through heattiles, so they're throttled, shared with the map
     overlay, and only re-downloaded after HEATMAP_DAYS (90). Runs at start, then checks daily.
  2. Each PNG is decoded to its alpha channel and kept as data/heat/grid/ride/14/<x>/<y>.a
     (zlib-compressed, 2-byte width header). Mostly-empty tiles compress to a few KB. Tiles with
     no rides at all get an <y>.empty marker instead. The patched BRouter reads the same files.
  3. score(route) samples the route every few metres, reads the brightest pixel within ~8 m of
     each sample (heat lines and road lines are often a few metres apart), and reports how much
     of the route has data and how popular it is.

Routes outside the downloaded area fetch the tiles they cross on demand (up to a cap per request);
anything still missing counts as 'no data' and is left out of the averages.
"""
import math
import os
import struct
import threading
import time
import zlib
from collections import OrderedDict

import heattiles

ACTIVITY = "ride"
COLOR = os.environ.get("HEATMAP_GRID_COLOR", "hot")  # any scheme works: alpha is the same in all
Z = 14
GRID = os.path.join(os.environ.get("DATA_DIR", "/data"), "heat", "grid", ACTIVITY, str(Z))
ALPHA_FLOOR = 143      # faintest track in the proxy's tiles; scaled to heat 0
POPULAR = 0.5          # heat at or above this counts as a 'popular' road (alpha ~199)
WINDOW_M = 8           # look this far either side of the route for the heat line
ON_DEMAND_CAP = 40     # tiles a single score request may download

_mem = OrderedDict()   # (x, y) -> (width, alpha bytes) | None (no heat); most recent last
_mem_lock = threading.Lock()
MEM_TILES = 128        # 512x512 tiles are 256 KB decoded: ~32 MB at most

progress = {"running": False, "total": 0, "done": 0, "with_heat": 0, "fetched": 0,
            "missing": 0, "started": None, "finished": None}


# ---------- tile maths ----------

def lonlat_to_px(lon, lat, z, size):
    """Global pixel position at zoom z for tiles `size` px wide. Wraps longitude, clamps
    latitude to what Web Mercator can show (±85.0511°)."""
    lon = ((lon + 180.0) % 360.0) - 180.0
    lat = max(-85.05112878, min(85.05112878, lat))
    n = (1 << z) * size
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def tiles_in_bbox(s, w, n, e, z):
    x0, y0 = (int(v) for v in lonlat_to_px(w, n, z, 1))
    x1, y1 = (int(v) for v in lonlat_to_px(e, s, z, 1))
    return [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


# ---------- PNG -> alpha ----------

def png_alpha(data):
    """Alpha channel of an 8-bit PNG as (width, bytes of width*height). Standard library only.
    PNG filters work byte by byte against the same channel of the pixel to the left / above, so
    for RGBA we only undo the filter on the alpha bytes: a quarter of the work."""
    if not data.startswith(heattiles.PNG_SIG):
        raise ValueError("not a PNG")
    pos, idat, trns = 8, [], None
    while pos < len(data):
        ln, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + ln]
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"tRNS":
            trns = body
        elif kind == b"IEND":
            break
        pos += 12 + ln
    if depth != 8 or interlace:
        raise ValueError(f"unsupported PNG: depth {depth}, interlace {interlace}")
    bpp = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    if ctype in (0, 2):
        raise ValueError("PNG has no alpha channel, so it carries no heat values")
    raw = zlib.decompress(b"".join(idat))
    ch = bpp - 1 if ctype in (4, 6) else 0  # alpha byte; palette images: the index byte
    stride = w * bpp
    out = bytearray(w * h)
    prev = bytearray(w)  # previous row, this channel only
    for row in range(h):
        base = row * (stride + 1)
        ft = raw[base]
        line = raw[base + 1 + ch: base + 1 + stride: bpp]  # this channel's bytes, still filtered
        cur = bytearray(line)
        if ft == 1:      # Sub
            for i in range(1, w):
                cur[i] = (cur[i] + cur[i - 1]) & 255
        elif ft == 2:    # Up
            cur = bytearray((a + b) & 255 for a, b in zip(cur, prev))
        elif ft == 3:    # Average
            cur[0] = (cur[0] + (prev[0] >> 1)) & 255
            for i in range(1, w):
                cur[i] = (cur[i] + ((cur[i - 1] + prev[i]) >> 1)) & 255
        elif ft == 4:    # Paeth
            cur[0] = (cur[0] + prev[0]) & 255
            for i in range(1, w):
                a, b, c = cur[i - 1], prev[i], prev[i - 1]
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                cur[i] = (cur[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out[row * w:(row + 1) * w] = cur
        prev = cur
    if ctype == 3:  # palette index -> alpha from tRNS (missing entries are opaque)
        table = bytes(trns or b"") + b"\xff" * 256
        out = out.translate(table[:256])
    return w, bytes(out)


# ---------- grid files ----------

def grid_path(x, y):
    return os.path.join(GRID, str(x), f"{y}.a")


def _save_grid(x, y, width, alpha):
    p = grid_path(x, y)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "wb") as f:
        f.write(struct.pack(">H", width) + zlib.compress(alpha, 6))
    os.replace(tmp, p)
    try:
        os.remove(p[:-2] + ".empty")  # it has heat now
    except OSError:
        pass


def _load_grid(x, y):
    with open(grid_path(x, y), "rb") as f:
        d = f.read()
    return struct.unpack(">H", d[:2])[0], zlib.decompress(d[2:])


def _cached_color(x, y):
    """A colour scheme this tile is already cached in (any will do: the alpha is the same in all),
    so tiles you've looked at on the map, in whatever colours, aren't downloaded again."""
    try:
        colors = os.listdir(os.path.join(heattiles.CACHE, ACTIVITY))
    except OSError:
        return COLOR
    for c in [COLOR] + sorted(c for c in colors if c != COLOR):
        body, age = heattiles._read_cached(heattiles.tile_path(ACTIVITY, c, Z, x, y))
        if body is not None and age < heattiles.TTL:
            return c
    return COLOR


def ensure_tile(x, y, allow_fetch=True):
    """Make sure grid tile (x, y) is up to date with the cached PNG.
    Returns 'heat' | 'empty' | 'missing'. 'missing' means we don't know (not downloaded)."""
    color = _cached_color(x, y)
    tile, cache = heattiles.get_tile(ACTIVITY, color, Z, x, y, allow_fetch=allow_fetch)
    if tile is None:
        return "missing"
    if tile == b"":
        # Marker for the patched BRouter: nobody rides here (vs no file at all = not downloaded).
        marker = grid_path(x, y)[:-2] + ".empty"
        if not os.path.exists(marker):
            os.makedirs(os.path.dirname(marker), exist_ok=True)
            open(marker, "wb").close()
        return "empty"
    png = heattiles.tile_path(ACTIVITY, color, Z, x, y)
    gp = grid_path(x, y)
    try:
        if os.stat(gp).st_mtime >= os.stat(png).st_mtime:
            return "heat"
    except OSError:
        pass
    width, alpha = png_alpha(tile)
    _save_grid(x, y, width, alpha)
    with _mem_lock:
        _mem.pop((x, y), None)
    return "heat"


def _tile_alpha(x, y, budget):
    """(width, alpha) for a tile, None if it has no heat, 'missing' if unknown.
    `budget` is a one-item list: downloads this request may still make."""
    key = (x, y)
    with _mem_lock:
        if key in _mem:
            _mem.move_to_end(key)
            return _mem[key]
    allow = budget[0] > 0
    before = heattiles.state["fetched"]
    state = ensure_tile(x, y, allow_fetch=allow)
    budget[0] -= heattiles.state["fetched"] - before
    if state == "missing":
        return "missing"  # not cached in memory: it may arrive later
    val = _load_grid(x, y) if state == "heat" else None
    with _mem_lock:
        _mem[key] = val
        while len(_mem) > MEM_TILES:
            _mem.popitem(last=False)
    return val


# ---------- background download ----------

def build(bbox):
    """Bring every tile over bbox ('south,west,north,east') up to date. Safe to re-run: fresh
    tiles are skipped without touching the proxy, so a daily check costs almost nothing."""
    if not heattiles.configured() or progress["running"]:
        return
    s, w, n, e = (float(v) for v in bbox.split(","))
    tiles = tiles_in_bbox(s, w, n, e, Z)
    cx, cy = lonlat_to_px((w + e) / 2, (s + n) / 2, Z, 1)
    tiles.sort(key=lambda t: (t[0] - cx) ** 2 + (t[1] - cy) ** 2)  # middle outwards
    progress.update(running=True, total=len(tiles), done=0, with_heat=0, fetched=0, missing=0,
                    started=time.time(), finished=None)
    before = heattiles.state["fetched"]
    try:
        for x, y in tiles:
            try:
                st = ensure_tile(x, y)
            except Exception as ex:  # a broken PNG shouldn't stop the rest
                print(f"heat grid: tile {Z}/{x}/{y}: {ex}", flush=True)
                st = "missing"
            progress["done"] += 1
            progress["with_heat"] += st == "heat"
            progress["missing"] += st == "missing"
            progress["fetched"] = heattiles.state["fetched"] - before
            if st == "missing" and time.time() < heattiles.state["down_until"]:
                time.sleep(heattiles.BACKOFF)  # proxy down: wait it out rather than skim the list
    finally:
        progress.update(running=False, finished=time.time())
        print(f"heat grid: {progress['done']} tiles checked, {progress['fetched']} downloaded, "
              f"{progress['with_heat']} with heat, {progress['missing']} missing", flush=True)


def scheduler(bbox):
    time.sleep(20)  # let the service settle first
    while True:
        try:
            build(bbox)
        except Exception as ex:
            print(f"heat grid: build failed: {ex}", flush=True)
        time.sleep(86400)


# ---------- scoring ----------

def _dlon(a, b):
    """Longitude change from a to b the short way, so a line crossing ±180° stays short."""
    d = b - a
    return d - 360.0 if d > 180.0 else d + 360.0 if d < -180.0 else d


def _resample(coords, step):
    """Points every `step` metres along a [[lon, lat], ...] line, with the distance each stands for."""
    out = []
    carry = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(coords, coords[1:]):
        k = math.cos(math.radians((lat1 + lat2) / 2)) * 111320.0
        dl = _dlon(lon1, lon2)
        seg = math.hypot(dl * k, (lat2 - lat1) * 110540.0)
        d = carry
        while d < seg:
            t = d / seg
            out.append((lon1 + t * dl, lat1 + t * (lat2 - lat1)))  # lonlat_to_px wraps past ±180
            d += step
        carry = d - seg
    if coords:
        out.append(tuple(coords[-1][:2]))
    return out


def heat_at(lon, lat, budget, cache):
    """Heat 0..1 at a point (brightest pixel within WINDOW_M), or None if there's no data."""
    gx, gy = lonlat_to_px(lon, lat, Z, 1)
    tx, ty = int(gx), int(gy)
    key = (tx, ty)
    if key not in cache:
        cache[key] = _tile_alpha(tx, ty, budget)
    t = cache[key]
    if t == "missing":
        return None
    if t is None:
        return 0.0
    width, alpha = t
    px, py = int((gx - tx) * width), int((gy - ty) * width)
    m_per_px = 40075016.686 * math.cos(math.radians(lat)) / ((1 << Z) * width)
    r = max(1, round(WINDOW_M / m_per_px))
    best = 0
    # Stay inside this tile; at a tile edge the window is a little smaller, which is fine.
    for yy in range(max(0, py - r), min(width, py + r + 1)):
        row = yy * width
        v = max(alpha[row + max(0, px - r): row + min(width, px + r + 1)], default=0)
        if v > best:
            best = v
    if best == 0:
        return 0.0
    return max(0.0, min(1.0, (best - ALPHA_FLOOR) / (255 - ALPHA_FLOOR)))


def score(routes):
    """routes: list of [[lon, lat], ...]. For each: share of distance with heat data ('covered'),
    average heat over the covered part ('mean', 0..1) and share of the covered part on popular
    roads ('popular', 0..1). Missing data is left out, not counted as unpopular."""
    budget = [ON_DEMAND_CAP]
    cache = {}
    out = []
    for coords in routes:
        coords = [c for c in coords if isinstance(c, (list, tuple)) and len(c) >= 2]
        if len(coords) < 2:
            out.append(None)
            continue
        length = sum(math.hypot(_dlon(a[0], b[0]) * math.cos(math.radians(a[1])) * 111320.0, (b[1] - a[1]) * 110540.0)
                     for a, b in zip(coords, coords[1:]))
        step = max(10.0, length / 3000)  # at most ~3000 samples a route
        pts = _resample(coords, step)
        known = hot = 0
        total = 0.0
        for lon, lat in pts:
            h = heat_at(lon, lat, budget, cache)
            if h is None:
                continue
            known += 1
            total += h
            hot += h >= POPULAR
        n = len(pts) or 1
        out.append({
            "covered": round(known / n, 3),
            "mean": round(total / known, 3) if known else None,
            "popular": round(hot / known, 3) if known else None,
        })
    return out


def status():
    return dict(progress)
