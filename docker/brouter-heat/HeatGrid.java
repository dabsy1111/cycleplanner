package btools.router;

import java.io.File;
import java.nio.file.Files;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.Inflater;

/**
 * Popularity heat for BRouter (Cycle Planner patch, not part of upstream BRouter).
 *
 * Reads the heat grid the history service writes to /data/heat/grid/ride/14 (one file per z14
 * tile: x/y.a = 2-byte width + zlib-compressed alpha bytes, x/y.empty = tile known to have no
 * rides). Alpha 0 = nobody rides here, 143 = faintest track, 255 = busiest road.
 *
 * OsmPath multiplies each way section's cost by multiplier(), so with heat_strength = s a road
 * nobody rides costs (1 + s) times as much as the busiest road. Multipliers never go below 1, which
 * keeps BRouter's straight-line estimate a lower bound, so the search still finds the cheapest route.
 */
final class HeatGrid {
  static final String DIR = System.getenv().getOrDefault("HEAT_GRID", "/data/heat/grid/ride/14");
  static final int Z = 14;
  static final int SIZE = 256;          // tiles are max-pooled to 256 px: ~8 m per pixel around Perth
  static final float FLOOR = 143f;      // faintest track -> heat 0
  // Where there's no heat data (not downloaded yet, or outside the area) we assume middling
  // popularity rather than none. Treating it as heat 1 would make the router prefer unknown
  // ground over every road it knows about; treating it as heat 0 would make it avoid it.
  static final double UNKNOWN_HEAT = 0.5;
  static final int MAX_TILES = 800;     // ~50 MB of 64 KB tiles
  static final long RECHECK_MS = 10 * 60 * 1000L;  // look again for tiles that weren't there

  private static final class Tile {
    final byte[] px;      // SIZE*SIZE pooled alpha, or null
    final boolean empty;  // known: nobody rides here
    final long checked;
    Tile(byte[] px, boolean empty) { this.px = px; this.empty = empty; this.checked = System.currentTimeMillis(); }
    boolean missing() { return px == null && !empty; }
  }

  private static final ConcurrentHashMap<Long, Tile> tiles = new ConcurrentHashMap<>();

  private HeatGrid() {}

  /** Cost multiplier for a section between two BRouter points (ilon = (lon+180)*1e6, ilat = (lat+90)*1e6). */
  static double multiplier(int ilon1, int ilat1, int ilon2, int ilat2, int dist, double strength) {
    int n = Math.max(1, Math.min(8, dist / 25)); // one sample per ~25 m, at most 8 a section
    double sum = 0.;
    for (int i = 0; i < n; i++) {
      double t = (i + 0.5) / n;
      double lon = (ilon1 + t * (ilon2 - ilon1)) / 1e6 - 180.;
      double lat = (ilat1 + t * (ilat2 - ilat1)) / 1e6 - 90.;
      double h = heat(lon, lat);
      sum += h < 0. ? UNKNOWN_HEAT : h;
    }
    return 1. + strength * (1. - sum / n);
  }

  /** Heat 0..1 at a point (strongest within ~8 m), or -1 if there's no data there. */
  static double heat(double lon, double lat) {
    lat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    double n = 1 << Z;
    double gx = (lon + 180.) / 360. * n;
    double gy = (1. - Math.log(Math.tan(Math.toRadians(lat)) + 1. / Math.cos(Math.toRadians(lat))) / Math.PI) / 2. * n;
    int tx = ((int) Math.floor(gx) % (1 << Z) + (1 << Z)) % (1 << Z);
    int ty = (int) Math.floor(gy);
    Tile t = tile(tx, ty);
    if (t.empty) return 0.;
    if (t.px == null) return -1.;
    int x = (int) ((gx - Math.floor(gx)) * SIZE), y = (int) ((gy - Math.floor(gy)) * SIZE);
    int best = 0;
    for (int yy = Math.max(0, y - 1); yy <= Math.min(SIZE - 1, y + 1); yy++) {
      for (int xx = Math.max(0, x - 1); xx <= Math.min(SIZE - 1, x + 1); xx++) {
        int v = t.px[yy * SIZE + xx] & 0xff;
        if (v > best) best = v;
      }
    }
    if (best == 0) return 0.;
    return Math.max(0., Math.min(1., (best - FLOOR) / (255f - FLOOR)));
  }

  private static Tile tile(int x, int y) {
    Long key = ((long) x << 32) | (y & 0xffffffffL);
    Tile t = tiles.get(key);
    if (t != null && !(t.missing() && System.currentTimeMillis() - t.checked > RECHECK_MS)) return t;
    t = load(x, y);
    if (tiles.size() >= MAX_TILES) evictSome();
    tiles.put(key, t);
    return t;
  }

  private static void evictSome() {
    // Crude but lock-free: drop about a tenth. They reload from disk in under a millisecond.
    int drop = MAX_TILES / 10;
    for (Iterator<Long> it = tiles.keySet().iterator(); it.hasNext() && drop > 0; drop--) {
      it.next();
      it.remove();
    }
  }

  private static Tile load(int x, int y) {
    File base = new File(DIR, Integer.toString(x));
    File a = new File(base, y + ".a");
    try {
      if (a.isFile()) {
        byte[] d = Files.readAllBytes(a.toPath());
        int w = ((d[0] & 0xff) << 8) | (d[1] & 0xff);
        byte[] raw = new byte[w * w];
        Inflater inf = new Inflater();
        inf.setInput(d, 2, d.length - 2);
        int got = 0;
        while (got < raw.length && !inf.finished()) {
          int k = inf.inflate(raw, got, raw.length - got);
          if (k == 0 && (inf.needsInput() || inf.needsDictionary())) break;
          got += k;
        }
        inf.end();
        return new Tile(pool(raw, w), false);
      }
      if (new File(base, y + ".empty").isFile()) return new Tile(null, true);
    } catch (Exception e) {
      System.out.println("heat grid: can't read tile " + x + "/" + y + ": " + e);
    }
    return new Tile(null, false);
  }

  /** Shrink a w x w alpha tile to SIZE x SIZE keeping the strongest value of each block. */
  private static byte[] pool(byte[] raw, int w) {
    if (w == SIZE) return raw;
    byte[] out = new byte[SIZE * SIZE];
    for (int y = 0; y < w; y++) {
      int oy = y * SIZE / w;
      for (int x = 0; x < w; x++) {
        int o = oy * SIZE + x * SIZE / w;
        if ((raw[y * w + x] & 0xff) > (out[o] & 0xff)) out[o] = raw[y * w + x];
      }
    }
    return out;
  }
}
