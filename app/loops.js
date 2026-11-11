'use strict';
/* Loop generator: waypoints on a circle through the start, resized until BRouter's distance matches,
   then filtered and ranked by the switches in the Loop generator section. */

let loopResults = [];
let loopPicked = -1; // index of the loop on the map; the list stays so you can swap
let lastLoop = null; // how the current route was generated, for problem reports
let loopBusy = false;

const lp = (id) => $(id).checked;
const loopOver = () => (lp('lp-quiet') ? { traffic: 'avoid' } : {});
function fetchRoute(points, profile) { return brouterRoute(points, profile, undefined, 0, loopOver()); }

function circlePoints(start, brg, radius) {
  const centre = destination(start, brg, radius);
  const back = (brg + 180) % 360; // bearing from the centre back to the start
  return [start, ...[90, 180, 270].map((d) => destination(centre, (back + d) % 360, radius)), start];
}

// ---------- snapping waypoints to bike paths ----------
let pathIndex = null; // {key, cells: Map(cell -> [[lng,lat],...])}
const SNAP_CELL = 0.005;
async function loadPathIndex(start, radius) {
  const pad = (radius * 2.6) / 111000;
  const k = Math.cos(start[1] * Math.PI / 180);
  const s = start[1] - pad, n = start[1] + pad, w = start[0] - pad / k, e = start[0] + pad / k;
  const key = [s, w, n, e].map((v) => v.toFixed(2)).join(',');
  if (pathIndex && pathIndex.key === key) return pathIndex;
  const b = `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
  // The server keeps a weekly copy of every bike path around Perth: instant, no Overpass wait.
  try {
    const res = await fetch(`/api/bikepaths?bbox=${b}`);
    if (res.ok) {
      const d = await res.json();
      if (d.covered) {
        pathIndex = { key, cells: new Map(Object.entries(d.cells)), updated: d.updated };
        return pathIndex;
      }
    }
  } catch { /* fall back to Overpass below */ }
  const data = await overpass(`[out:json][timeout:60];
(
  way["highway"="cycleway"](${b});
  way["highway"~"^(path|footway)$"]["bicycle"="designated"](${b});
);
out skel geom;`);
  const cells = new Map();
  for (const el of data.elements || []) {
    for (const g of el.geometry || []) {
      const ck = `${Math.floor(g.lon / SNAP_CELL)}:${Math.floor(g.lat / SNAP_CELL)}`;
      if (!cells.has(ck)) cells.set(ck, []);
      cells.get(ck).push([g.lon, g.lat]);
    }
  }
  pathIndex = { key, cells };
  return pathIndex;
}
function addLikedToPathIndex() {
  if (!pathIndex || typeof likedVertices !== 'function') return;
  for (const [lng, lat] of likedVertices()) {
    const ck = `${Math.floor(lng / SNAP_CELL)}:${Math.floor(lat / SNAP_CELL)}`;
    if (!pathIndex.cells.has(ck)) pathIndex.cells.set(ck, []);
    pathIndex.cells.get(ck).push([lng, lat]);
  }
}
function snapPoint(p, maxM = 600) {
  if (!pathIndex) return p;
  const cx = Math.floor(p[0] / SNAP_CELL), cy = Math.floor(p[1] / SNAP_CELL);
  let best = null, bestD = maxM;
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
    for (const q of pathIndex.cells.get(`${cx + dx}:${cy + dy}`) || []) {
      const d = haversine(p, q);
      if (d < bestD) { bestD = d; best = q; }
    }
  }
  return best || p;
}

// ---------- how much of a loop rides the same road twice ----------
function repeatShare(rt) {
  const C = 0.00018; // ~20 m
  const first = new Map();
  const start = rt.coords[0];
  let total = 0, rep = 0;
  for (let i = 1; i < rt.coords.length; i++) {
    const a = rt.coords[i - 1], b = rt.coords[i];
    const steps = Math.max(1, Math.round((rt.cum[i] - rt.cum[i - 1]) / 25));
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      const ch = rt.cum[i - 1] + t * (rt.cum[i] - rt.cum[i - 1]);
      if (haversine(p, start) < 400) continue; // leaving and coming home on the same street is fine
      total++;
      const cx = Math.floor(p[0] / C), cy = Math.floor(p[1] / C);
      let seen = false;
      for (let dx = -1; dx <= 1 && !seen; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const f = first.get(`${cx + dx}:${cy + dy}`);
          if (f != null && f < ch - 300) { seen = true; break; }
        }
      }
      if (seen) rep++;
      const key = `${cx}:${cy}`;
      if (!first.has(key)) first.set(key, ch);
    }
  }
  return total ? (100 * rep) / total : 0;
}

// ---------- dead-end spikes ----------
// A loop point that lands in a side street makes the route ride in to touch it and straight back out.
// Measure that spike at each point (how far the way in and the way out run together) ...
function pointAt(rt, m) {
  m = Math.max(0, Math.min(rt.cum[rt.cum.length - 1], m));
  let lo = 0, hi = rt.cum.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rt.cum[mid] <= m) lo = mid; else hi = mid - 1; }
  const i = lo;
  const span = rt.cum[i + 1] - rt.cum[i] || 1, t = (m - rt.cum[i]) / span;
  return [rt.coords[i][0] + t * (rt.coords[i + 1][0] - rt.coords[i][0]), rt.coords[i][1] + t * (rt.coords[i + 1][1] - rt.coords[i][1])];
}
function spikes(rt, pts) {
  const out = [];
  let from = 0;
  for (let n = 1; n < pts.length - 1; n++) {
    const iw = nearestIndex(rt.coords, pts[n], from);
    from = iw;
    let d = 0;
    while (d < 5000 && haversine(pointAt(rt, rt.cum[iw] - d - 10), pointAt(rt, rt.cum[iw] + d + 10)) < 25) d += 10;
    out.push({ n, at: rt.cum[iw], len: d });
  }
  return out;
}
// U-turns anywhere on the route (e.g. riding up a path to a crossing and back down the other side).
function uturns(rt, minLen = 100) {
  const out = [];
  const L = rt.cum[rt.cum.length - 1];
  let s = 50;
  while (s < L - 50) {
    let d = 0;
    while (d < 3000 && haversine(pointAt(rt, s - d - 10), pointAt(rt, s + d + 10)) < 25) d += 10;
    if (d >= minLen) { out.push({ at: s, len: d }); s += d + 50; } else s += 20;
  }
  return out;
}
const uturnMetres = (rt) => uturns(rt).reduce((a, u) => a + u.len, 0);

// ... and move the point back to where its spike leaves the through road, then reroute.
async function trimSpikes(pts, rt, profile, fixed = []) {
  for (let round = 0; round < 2; round++) {
    const sp = spikes(rt, pts).filter((s) => s.len > 40 && !fixed.includes(s.n));
    if (!sp.length) break;
    pts = pts.slice();
    for (const s of sp) pts[s.n] = pointAt(rt, s.at - s.len);
    rt = await fetchRoute(pts, profile);
  }
  return { pts, rt };
}

// ---------- building one loop ----------
async function routeCircle(start, brg, radius, profile) {
  let pts = circlePoints(start, brg, radius);
  if (lp('lp-snap')) pts = [pts[0], ...pts.slice(1, -1).map((p) => snapPoint(p)), pts[pts.length - 1]];
  return trimSpikes(pts, await fetchRoute(pts, profile), profile);
}

// ---------- loops through a chosen point ----------
// Start A, turnaround B, and a point out to each side of the line A-B, so you ride out one way
// and home another. A shape is [f1, f2, s]: how far along A-B each side point sits, and how
// the width is split between the two sides.
const THROUGH_SHAPES = [[0.5, 0.5, 0.5], [0.5, 0.5, 0.2], [0.5, 0.5, 0.8], [0.35, 0.65, 0.5],
  [0.65, 0.35, 0.5], [0.35, 0.35, 0.5], [0.65, 0.65, 0.5], [0.5, 0.5, 0.05]];

function throughPoints(A, B, shape, width) {
  const brg = bearing(A, B), c = haversine(A, B), [f1, f2, s] = shape;
  const side = (f, w, dir) => destination(destination(A, brg, c * f), (brg + dir + 360) % 360, w);
  return [A, side(f1, width * s, 90), B, side(f2, width * (1 - s), -90), A];
}
function pathLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += haversine(pts[i - 1], pts[i]); return L; }
// Width that makes the straight-line shape this long (it only grows with width, so bisect).
function widthFor(A, B, shape, len) {
  let lo = 0, hi = len;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (pathLength(throughPoints(A, B, shape, mid)) < len) lo = mid; else hi = mid; }
  return lo;
}
async function routeThrough(A, B, shape, width, profile) {
  let pts = throughPoints(A, B, shape, width);
  if (lp('lp-snap')) pts = pts.map((p, i) => (i === 1 || i === 3 ? snapPoint(p) : p));
  return trimSpikes(pts, await fetchRoute(pts, profile), profile, [2]);
}
async function makeThroughLoop(A, B, shape, target, profile) {
  const c = haversine(A, B);
  const minWidth = c * 0.3; // narrower than this and out and back share the same roads
  let len = target / 1.3; // roads are ~30% longer than straight lines
  let best = null;
  const badness = (x) => x.err * 100 + (lp('lp-noback') ? x.repeat : 0) + x.uturn / 20;
  for (let attempt = 0; attempt < 3; attempt++) {
    const width = Math.max(minWidth, widthFor(A, B, shape, len));
    const l = await routeThrough(A, B, shape, width, profile);
    l.err = Math.abs(l.rt.length - target) / target;
    l.repeat = repeatShare(l.rt);
    l.uturn = uturnMetres(l.rt);
    l.brg = bearing(A, l.pts[1]);
    l.through = true;
    if (!best || badness(l) < badness(best)) best = l;
    if (l.err < 0.07 || (width === minWidth && l.rt.length > target)) break;
    len *= target / l.rt.length;
  }
  return best;
}

async function makeLoop(start, brg, target, profile) {
  let radius = target / (2 * Math.PI * 1.3); // roads are ~30% longer than the circle
  let best = null;
  const badness = (x) => x.err * 100 + (lp('lp-noback') ? x.repeat : 0) + x.uturn / 20;
  const consider = (c) => {
    c.err = Math.abs(c.rt.length - target) / target;
    c.repeat = repeatShare(c.rt);
    c.uturn = uturnMetres(c.rt);
    c.brg = brg;
    if (!best || badness(c) < badness(best)) best = c;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await routeCircle(start, brg, radius, profile);
    consider(c);
    if (c.err < 0.07) break;
    radius *= target / c.rt.length;
  }
  // Doubling back: try the circle turned a little either way.
  if (lp('lp-noback') && best.repeat > 12) {
    for (const turn of [25, -25]) {
      if (best.repeat <= 12) break;
      try { consider(await routeCircle(start, (brg + turn + 360) % 360, radius, profile)); }
      catch { /* that variation hit the sea or similar */ }
    }
  }
  // U-turns: try the circle turned a little each way and keep the cleanest.
  for (const turn of [12, -12, 25, -25]) {
    if (best.uturn === 0) break;
    try { consider(await routeCircle(start, (brg + turn + 360) % 360, radius, profile)); }
    catch { /* that variation hit the sea or similar */ }
  }
  return best;
}

function mainRoadPct(rt) {
  let main = 0;
  for (const s of rt.segs) if (wayClass(s.tags) === 'main') main += rt.cum[s.i1] - rt.cum[s.i0];
  return (100 * main) / (rt.length || 1);
}

// ---------- ranking ----------
function loopScore(l) {
  let s = l.err * 100;
  if (lp('lp-quiet')) s += l.mainPct * 0.3;
  if (lp('lp-noback')) s += l.repeat * 0.5;
  s += l.uturn / 20; // every 100 m of U-turn costs as much as 5% off the target distance
  if (lp('lp-climb')) { const t = +$('lp-climb-m').value || 400; s += (Math.abs(l.rt.ascend - t) / t) * 40; }
  const nov = $('lp-novelty').value;
  if (nov !== 'off' && l.newPct != null) s += (nov === 'new' ? -1 : 1) * l.newPct * 0.3;
  if (l.wind) s += l.wind.second * 0.5;
  if (l.interval) s -= Math.min(l.interval.mins, 30) * 0.5;
  if (lp('lp-liked') && l.liked) s -= l.liked.pct * 0.3;
  return s;
}

function showLoopPreview(highlight = -1) {
  const src = map.getSource('loops');
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    // Once one is picked, only show another when you hover it.
    features: loopResults.map((l, k) => ({
      type: 'Feature', properties: { hl: k === highlight ? 1 : 0 },
      geometry: { type: 'LineString', coordinates: l.rt.coords.map((c) => [c[0], c[1]]) },
    })).filter((f, k) => loopPicked < 0 || (k === highlight && k !== loopPicked)),
  });
  const iv = map.getSource('loop-interval');
  if (iv) {
    const l = loopResults[highlight];
    iv.setData(l && l.interval
      ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l.rt.coords.slice(l.interval.i0, l.interval.i1 + 1).map((c) => [c[0], c[1]]) } }
      : emptyFC());
  }
}

function renderLoops() {
  const ul = $('loops');
  ul.innerHTML = '';
  loopResults.forEach((l, k) => {
    const li = document.createElement('li');
    if (k === loopPicked) li.classList.add('picked');
    const bits = [`${Math.round(l.rt.ascend)} m up`, `${Math.round(l.mainPct)}% main road`];
    if (l.repeat >= 3) bits.push(`${Math.round(l.repeat)}% repeated`);
    if (l.uturn) bits.push(`<span class="badge warn">${l.uturn} m of U-turns</span>`);
    if (l.newPct != null) bits.push(`${Math.round(l.newPct)}% new`);
    if (l.interval) bits.push(`${l.interval.mins} min stretch`);
    if (l.liked && l.liked.pct >= 1) bits.push(`${Math.round(l.liked.pct)}% liked roads`);
    li.innerHTML = `<span class="km">${fmtKm(l.rt.length)}</span>` +
      `<span>${k === 0 ? '<span class="tag">best match</span> ' : ''}${l.through ? `Out via the ${compass(l.brg)} side` : `Heads ${compass(l.brg)}`} · ${bits.join(' · ')}</span>` +
      `<span class="off">${l.wind ? fmtWind(l.wind.second).replace('wind', 'wind home') : ''}</span>`;
    li.onmouseenter = () => showLoopPreview(k);
    li.onmouseleave = () => showLoopPreview(-1);
    li.onclick = () => {
      loopPicked = k;
      renderLoops();
      showLoopPreview();
      $('loop-status').textContent = 'Tap another loop to swap. Generate again for new ones.';
      if (lp('lp-quiet') && $('opt-traffic').value !== 'avoid') { $('opt-traffic').value = 'avoid'; store.set('cp.traffic', 'avoid'); }
      const last = l.pts.length - 1;
      // The point you chose to loop through stays exactly where you put it.
      setWaypoints(l.pts.map(([lng, lat], i) => (i > 0 && i < last && !(l.through && i === 2) ? { lng, lat, auto: true } : { lng, lat })), { fit: true });
      lastLoop = {
        targetKm: +$('loop-km').value, heading: compass(l.brg), bearing: l.brg, rank: k + 1,
        switches: Object.fromEntries(['lp-noback', 'lp-quiet', 'lp-snap', 'lp-climb', 'lp-interval', 'lp-liked', 'lp-through'].map((id) => [id, lp(id)])),
        climbTarget: +$('lp-climb-m').value, intervalMin: +$('lp-interval-min').value, novelty: $('lp-novelty').value,
        stats: { km: +fmtKm(l.rt.length), up: Math.round(l.rt.ascend), mainPct: Math.round(l.mainPct), repeatPct: Math.round(l.repeat), uturnM: l.uturn, newPct: l.newPct == null ? null : Math.round(l.newPct) },
        waypoints: l.pts,
      };
    };
    ul.appendChild(li);
  });
}

async function generateLoops() {
  if (loopBusy) return;
  loopBusy = true;
  const km = +$('loop-km').value || 50;
  store.set('cp.loopkm', km);
  const target = km * 1000;
  const start = waypoints.length ? [waypoints[0].lng, waypoints[0].lat] : [map.getCenter().lng, map.getCenter().lat];
  const profile = $('profile').value;
  const st = $('loop-status');
  $('loop-go').disabled = true;
  loopResults = [];
  loopPicked = -1;
  renderLoops();
  showLoopPreview();
  try {
    try { await loadWind(start[0], start[1]); } catch { /* wind is optional */ }
    if (lp('lp-snap')) {
      st.textContent = 'Looking up bike paths…';
      try { await loadPathIndex(start, target / (2 * Math.PI)); } catch { pathIndex = { key: '', cells: new Map() }; }
      if (lp('lp-liked')) addLikedToPathIndex();
    }
    let note = '';
    // With a second point and "through my point" on, every loop goes out to that point and back another way.
    // (Points a generated loop placed don't count, so you can regenerate after picking one.)
    const own = waypoints.slice(1).find((w) => !w.auto && haversine(start, [w.lng, w.lat]) > 30);
    const B = lp('lp-through') && own ? [own.lng, own.lat] : null;
    if (B && haversine(start, B) < 300) { st.textContent = 'Your second point is too close to the start to loop through. Move it, or untick "Loop through my second point".'; return; }
    if (B && haversine(start, B) * 2 * 1.2 > target) {
      $('loop-km').value = Math.ceil((haversine(start, B) * 2 * 1.45) / 5000) * 5;
      note = `Your point is ${fmtKm(haversine(start, B))} km away, so loops through it are about ${$('loop-km').value} km.`;
    }
    const tgt = B ? Math.max(target, haversine(start, B) * 2 * 1.45) : target;
    const bearings = B ? THROUGH_SHAPES : lp('lp-climb') ? [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] : [0, 45, 90, 135, 180, 225, 270, 315];
    const found = [];
    let done = 0;
    st.textContent = `Working… 0 of ${bearings.length}`;
    const queue = [...bearings];
    const worker = async () => {
      while (queue.length) {
        const brg = queue.shift();
        try {
          const l = B ? await makeThroughLoop(start, B, brg, tgt, profile) : await makeLoop(start, brg, target, profile);
          // Ride it whichever way puts the wind behind you on the way home.
          if (wind) {
            const fwd = windStats(l.rt), rev = windStats(l.rt, true);
            if (rev.second < fwd.second - 1) {
              l.pts = [...l.pts].reverse();
              l.rt = await fetchRoute(l.pts, profile);
              l.err = Math.abs(l.rt.length - tgt) / tgt;
              l.wind = windStats(l.rt);
            } else l.wind = fwd;
          }
          if (l.err < 0.25) found.push(l);
        } catch { /* usually a circle point out at sea */ }
        done++;
        st.textContent = `Working… ${done} of ${bearings.length}`;
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    for (const l of found) {
      l.mainPct = mainRoadPct(l.rt);
      l.newPct = typeof newRoadShare === 'function' ? newRoadShare(l.rt) : null;
      l.liked = typeof likedShare === 'function' ? likedShare(l.rt) : null;
    }
    let list = found;
    if (lp('lp-interval') && found.length) {
      st.textContent = 'Checking lights and crossings for interval stretches…';
      const mins = +$('lp-interval-min').value || 8;
      try {
        // One lookup covering every loop.
        const nodes = await routeNodes({ coords: found.flatMap((l) => l.rt.coords.filter((_, i) => i % 10 === 0)) });
        for (const l of found) {
          const s = findStretches(l.rt, interruptions(l.rt, nodes), mins * 60 * riderSpeedMs(), 'any')[0];
          if (s) l.interval = { ...s, mins: Math.round(s.len / riderSpeedMs() / 60) };
        }
        list = found.filter((l) => l.interval);
        if (!list.length) note = `None of the loops has an uninterrupted ${mins} min stretch. Try a shorter interval or a longer loop.`;
      } catch (e) { note = 'Could not check interval stretches: ' + e.message; list = found; }
    }
    loopResults = list.sort((a, b) => loopScore(a) - loopScore(b)).slice(0, 6);
    renderLoops();
    showLoopPreview();
    if (loopResults.length) {
      const b = new maplibregl.LngLatBounds();
      loopResults.forEach((l) => l.rt.coords.forEach((c) => b.extend([c[0], c[1]])));
      map.fitBounds(b, { padding: 50 });
      st.textContent = (note ? note + ' ' : '') + `${loopResults.length} loops, best match first. Hover to highlight one, tap to use it.`;
    } else {
      st.textContent = note || 'No loops found. Try a different distance or start point.';
    }
  } finally {
    loopBusy = false;
    $('loop-go').disabled = false;
  }
}

function updateLoopTime() {
  const km = +$('loop-km').value || 0;
  $('loop-time').textContent = km ? `(about ${fmtDuration(km / speedKmh())})` : '';
}

map.on('load', () => {
  map.addSource('loops', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'loops', type: 'line', source: 'loops',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['case', ['==', ['get', 'hl'], 1], '#1971c2', '#495057'],
      'line-width': ['case', ['==', ['get', 'hl'], 1], 5, 2.5],
      'line-opacity': ['case', ['==', ['get', 'hl'], 1], 0.95, 0.5],
    } }, 'route-casing');
  map.addSource('loop-interval', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'loop-interval', type: 'line', source: 'loop-interval',
    layout: { 'line-cap': 'round' }, paint: { 'line-color': '#fcc419', 'line-width': 12, 'line-opacity': 0.8 } }, 'loops');
});

// Remember the loop switches.
for (const id of ['lp-noback', 'lp-quiet', 'lp-snap', 'lp-climb', 'lp-interval', 'lp-liked', 'lp-through']) {
  $(id).checked = store.get('cp.' + id, $(id).checked);
  $(id).addEventListener('change', () => store.set('cp.' + id, $(id).checked));
}
for (const id of ['lp-climb-m', 'lp-interval-min', 'lp-novelty']) {
  $(id).value = store.get('cp.' + id, $(id).value);
  $(id).addEventListener('change', () => store.set('cp.' + id, $(id).value));
}
$('loop-km').value = store.get('cp.loopkm', 50);
updateLoopTime();
$('loop-km').addEventListener('input', updateLoopTime);
$('speed').addEventListener('input', updateLoopTime);
$('loop-go').onclick = generateLoops;
