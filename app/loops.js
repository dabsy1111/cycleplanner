'use strict';
/* Loop generator: waypoints on a circle through the start, resized until BRouter's distance matches,
   then filtered and ranked by the switches in the Loop generator section. */

let loopResults = [];
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

// ---------- building one loop ----------
async function routeCircle(start, brg, radius, profile) {
  let pts = circlePoints(start, brg, radius);
  if (lp('lp-snap')) pts = [pts[0], ...pts.slice(1, -1).map((p) => snapPoint(p)), pts[pts.length - 1]];
  return { pts, rt: await fetchRoute(pts, profile) };
}

async function makeLoop(start, brg, target, profile) {
  let radius = target / (2 * Math.PI * 1.3); // roads are ~30% longer than the circle
  let best = null;
  const badness = (x) => x.err * 100 + (lp('lp-noback') ? x.repeat : 0);
  const consider = (c) => {
    c.err = Math.abs(c.rt.length - target) / target;
    c.repeat = repeatShare(c.rt);
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
    features: loopResults.map((l, k) => ({
      type: 'Feature', properties: { hl: k === highlight ? 1 : 0 },
      geometry: { type: 'LineString', coordinates: l.rt.coords.map((c) => [c[0], c[1]]) },
    })),
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
    const bits = [`${Math.round(l.rt.ascend)} m up`, `${Math.round(l.mainPct)}% main road`];
    if (l.repeat >= 3) bits.push(`${Math.round(l.repeat)}% repeated`);
    if (l.newPct != null) bits.push(`${Math.round(l.newPct)}% new`);
    if (l.interval) bits.push(`${l.interval.mins} min stretch`);
    if (l.liked && l.liked.pct >= 1) bits.push(`${Math.round(l.liked.pct)}% liked roads`);
    li.innerHTML = `<span class="km">${fmtKm(l.rt.length)}</span>` +
      `<span>${k === 0 ? '<span class="tag">best match</span> ' : ''}Heads ${compass(l.brg)} · ${bits.join(' · ')}</span>` +
      `<span class="off">${l.wind ? fmtWind(l.wind.second).replace('wind', 'wind home') : ''}</span>`;
    li.onmouseenter = () => showLoopPreview(k);
    li.onmouseleave = () => showLoopPreview(-1);
    li.onclick = () => {
      loopResults = [];
      showLoopPreview();
      ul.innerHTML = '';
      $('loop-status').textContent = '';
      if (lp('lp-quiet') && $('opt-traffic').value !== 'avoid') { $('opt-traffic').value = 'avoid'; store.set('cp.traffic', 'avoid'); }
      setWaypoints(l.pts.map(([lng, lat]) => ({ lng, lat })), { fit: true });
      lastLoop = {
        targetKm: +$('loop-km').value, heading: compass(l.brg), bearing: l.brg, rank: k + 1,
        switches: Object.fromEntries(['lp-noback', 'lp-quiet', 'lp-snap', 'lp-climb', 'lp-interval', 'lp-liked'].map((id) => [id, lp(id)])),
        climbTarget: +$('lp-climb-m').value, intervalMin: +$('lp-interval-min').value, novelty: $('lp-novelty').value,
        stats: { km: +fmtKm(l.rt.length), up: Math.round(l.rt.ascend), mainPct: Math.round(l.mainPct), repeatPct: Math.round(l.repeat), newPct: l.newPct == null ? null : Math.round(l.newPct) },
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
  renderLoops();
  showLoopPreview();
  try {
    try { await loadWind(start[0], start[1]); } catch { /* wind is optional */ }
    if (lp('lp-snap')) {
      st.textContent = 'Looking up bike paths…';
      try { await loadPathIndex(start, target / (2 * Math.PI)); } catch { pathIndex = { key: '', cells: new Map() }; }
      if (lp('lp-liked')) addLikedToPathIndex();
    }
    const bearings = lp('lp-climb') ? [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] : [0, 45, 90, 135, 180, 225, 270, 315];
    const found = [];
    let done = 0;
    st.textContent = `Working… 0 of ${bearings.length}`;
    const queue = [...bearings];
    const worker = async () => {
      while (queue.length) {
        const brg = queue.shift();
        try {
          const l = await makeLoop(start, brg, target, profile);
          // Ride it whichever way puts the wind behind you on the way home.
          if (wind) {
            const fwd = windStats(l.rt), rev = windStats(l.rt, true);
            if (rev.second < fwd.second - 1) {
              l.pts = [...l.pts].reverse();
              l.rt = await fetchRoute(l.pts, profile);
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
    let note = '';
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
for (const id of ['lp-noback', 'lp-quiet', 'lp-snap', 'lp-climb', 'lp-interval', 'lp-liked']) {
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
