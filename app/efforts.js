'use strict';
/* Interval stretches: parts of the planned route you can hold an effort on without stopping. */

const LETTERS = 'ABCDEFGHIJ';
let effortCache = { key: null, nodes: [] };
let effortList = [];

function effortsQuery(s, w, n, e) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:25];
(
  node["highway"~"^(traffic_signals|stop|give_way|crossing)$"](${b});
  node["crossing"="traffic_signals"](${b});
  node["railway"~"^(level_crossing|crossing)$"](${b});
  node["barrier"~"^(gate|lift_gate|swing_gate|bollard|cycle_barrier|stile|kissing_gate)$"](${b});
);
out;`;
}

function interruptionKind(t) {
  if (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals') return 'lights';
  if (t.highway === 'stop' || t.highway === 'give_way') return 'give way';
  if (t.railway) return 'rail crossing';
  if (t.barrier) return 'barrier';
  return 'crossing';
}

async function routeNodes(rt) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const c of rt.coords) { s = Math.min(s, c[1]); n = Math.max(n, c[1]); w = Math.min(w, c[0]); e = Math.max(e, c[0]); }
  const pad = 0.002;
  [s, w, n, e] = [s - pad, w - pad, n + pad, e + pad].map((v) => +v.toFixed(3));
  const key = `${s},${w},${n},${e}`;
  // Reuse an earlier result if it already covers this route.
  const c = effortCache.key && effortCache.key.split(',').map(Number);
  if (c && c[0] <= s && c[1] <= w && c[2] >= n && c[3] >= e) return effortCache.nodes;
  const data = await overpass(effortsQuery(s, w, n, e));
  const nodes = (data.elements || []).map((el) => ({ lng: el.lon, lat: el.lat, kind: interruptionKind(el.tags || {}) }));
  effortCache = { key, nodes };
  return nodes;
}

// Where on the route you'd have to slow or stop, as chainages in metres.
function interruptions(rt, nodes) {
  const out = [];
  const segAt = (m) => rt.segs.find((s) => rt.cum[s.i0] <= m && m <= rt.cum[s.i1]);
  for (const hit of stopsAlong(rt, nodes, 12)) {
    const m = hit.km * 1000;
    if (hit.poi.kind === 'crossing') {
      // A zebra on the road you're riding rarely stops you; a path crossing a road does.
      const seg = segAt(m);
      const onPath = seg && ['bikepath', 'footpath', 'track', 'other'].includes(wayClass(seg.tags));
      if (!onPath) continue;
    }
    out.push({ at: m, kind: hit.poi.kind });
  }
  for (const s of rt.segs) if (s.tags.junction === 'roundabout') out.push({ at: rt.cum[s.i0], kind: 'roundabout' });
  // Sharp turns: direction change over 65° comparing 25 m before and after a point.
  let i = 0;
  const n = rt.coords.length;
  while (i < n) {
    let a = i, b = i;
    while (a > 0 && rt.cum[i] - rt.cum[a] < 25) a--;
    while (b < n - 1 && rt.cum[b] - rt.cum[i] < 25) b++;
    if (a < i && b > i) {
      let d = Math.abs(bearing(rt.coords[a], rt.coords[i]) - bearing(rt.coords[i], rt.coords[b]));
      if (d > 180) d = 360 - d;
      if (d > 65) {
        out.push({ at: rt.cum[i], kind: 'turn' });
        const skipTo = rt.cum[i] + 30;
        while (i < n - 1 && rt.cum[i] < skipTo) i++;
        continue;
      }
    }
    i++;
  }
  // One intersection often has several signal or crossing points mapped: count it once.
  out.sort((x, y) => x.at - y.at);
  const merged = [];
  for (const x of out) {
    const last = merged[merged.length - 1];
    if (last && x.at - last.at < 40) { if (x.kind === 'lights') last.kind = 'lights'; continue; }
    merged.push({ ...x });
  }
  return merged;
}

function eleAt(rt, m) {
  let lo = 0, hi = rt.cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rt.cum[mid] < m) lo = mid + 1; else hi = mid; }
  return rt.coords[lo][2] ?? 0;
}
function indexAt(rt, m) {
  let lo = 0, hi = rt.cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rt.cum[mid] < m) lo = mid + 1; else hi = mid; }
  return lo;
}

function findStretches(rt, stops, minMetres, terrain) {
  const L = rt.cum[rt.cum.length - 1];
  const marks = [0, ...stops.map((s) => s.at), L];
  const out = [];
  for (let k = 1; k < marks.length; k++) {
    // Leave 50 m after a stop to get going and 50 m before the next one.
    const a = marks[k - 1] + (k > 1 ? 50 : 0), b = marks[k] - (k < marks.length - 1 ? 50 : 0);
    const len = b - a;
    if (len < minMetres) continue;
    const i0 = indexAt(rt, a), i1 = indexAt(rt, b);
    let climb = 0;
    for (let i = i0 + 1; i <= i1; i++) climb += Math.max(0, (rt.coords[i][2] ?? 0) - (rt.coords[i - 1][2] ?? 0));
    const grade = (100 * (eleAt(rt, b) - eleAt(rt, a))) / len;
    const flat = Math.abs(grade) < 2 && climb / (len / 1000) < 15;
    if (terrain === 'flat' && !flat) continue;
    if (terrain === 'climb' && grade < 3) continue;
    out.push({ a, b, len, i0, i1, grade, climb });
  }
  out.sort((x, y) => (terrain === 'climb' ? y.grade * Math.sqrt(y.len) - x.grade * Math.sqrt(x.len) : y.len - x.len));
  return out.slice(0, LETTERS.length);
}

function renderEfforts() {
  const src = map.getSource('efforts');
  if (src) {
    src.setData({
      type: 'FeatureCollection',
      features: route ? effortList.map((s, k) => ({
        type: 'Feature', properties: { label: LETTERS[k] },
        geometry: { type: 'LineString', coordinates: route.coords.slice(s.i0, s.i1 + 1) },
      })) : [],
    });
  }
  const ul = $('efforts');
  ul.innerHTML = '';
  if (!route) return;
  const v = riderSpeedMs();
  effortList.forEach((s, k) => {
    const li = document.createElement('li');
    const g = s.grade >= 0 ? `+${s.grade.toFixed(1)}%` : `${s.grade.toFixed(1)}%`;
    li.innerHTML = `<span class="eff-letter">${LETTERS[k]}</span><span>${fmtKm(s.len)} km · ~${Math.round(s.len / v / 60)} min · ${g}, ${Math.round(s.climb)} m up</span>` +
      `<span class="off">km ${(s.a / 1000).toFixed(1)}–${(s.b / 1000).toFixed(1)}</span>`;
    li.onclick = () => {
      const bnd = new maplibregl.LngLatBounds();
      route.coords.slice(s.i0, s.i1 + 1).forEach((c) => bnd.extend([c[0], c[1]]));
      map.fitBounds(bnd, { padding: 60, maxZoom: 16 });
    };
    ul.appendChild(li);
  });
}

async function updateEfforts() {
  effortList = [];
  const st = $('eff-status');
  if (!route) { st.textContent = ''; renderEfforts(); return; }
  if (!$('eff-min').closest('details').open) { renderEfforts(); return; }
  const seq = routeSeq;
  st.textContent = 'Checking lights and crossings…';
  try {
    const nodes = await routeNodes(route);
    if (seq !== routeSeq || !route) return;
    const stops = interruptions(route, nodes);
    const minM = (+$('eff-min').value || 8) * 60 * riderSpeedMs();
    effortList = findStretches(route, stops, minM, $('eff-terrain').value);
    const counts = {};
    stops.forEach((s) => { counts[s.kind] = (counts[s.kind] || 0) + 1; });
    const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
    st.textContent = effortList.length
      ? `Interruptions on this route: ${summary}.`
      : `No stretch that long on this route (interruptions: ${summary}). Try a shorter time or a different terrain filter.`;
  } catch (e) {
    st.textContent = 'Could not load traffic lights and crossings: ' + e.message;
  }
  renderEfforts();
}

map.on('load', () => {
  map.addSource('efforts', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'efforts', type: 'line', source: 'efforts',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fcc419', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 10, 16, 18] } }, 'route-casing');
  map.addLayer({ id: 'efforts-label', type: 'symbol', source: 'efforts',
    layout: { 'symbol-placement': 'line-center', 'text-field': ['get', 'label'], 'text-size': 13, 'text-font': ['Noto Sans Bold'] },
    paint: { 'text-color': '#1d2125', 'text-halo-color': '#fcc419', 'text-halo-width': 3 } });
});

routeHooks.push(() => { updateEfforts(); });
['eff-min', 'eff-terrain'].forEach((id) => $(id).addEventListener('change', updateEfforts));
$('speed').addEventListener('change', updateEfforts);
$('eff-min').closest('details').addEventListener('toggle', (e) => { if (e.target.open) updateEfforts(); });
