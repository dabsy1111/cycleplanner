'use strict';
/* Roads you like and dislike: tap a road on the base map to mark it.
   Disliked roads go to BRouter as weighted no-go lines; liked roads steer the loop generator. */

// A disliked road goes to BRouter as a chain of small soft no-go circles along it (15 m radius every
// 20 m, weight 4). Tested on Perth data: a road with a short way round gets avoided, one where the
// way round is km longer (the Narrows) is still used. (BRouter's weighted lines and polygons
// don't work for this: lines miss roads drawn a few metres off, weighted polygons error.)
const DISLIKE_R = 15, DISLIKE_STEP = 20, DISLIKE_WEIGHT = 4;
const FOLLOW_M = 2000;     // how far to follow a tapped road each way
let markedRoads = [];      // [{kind: 'like'|'dislike', name, line: [[lng,lat],...]}]
let markingKind = null;
let likedCells = null;

function dislikedParam() {
  const out = [];
  for (const r of markedRoads) {
    if (r.kind !== 'dislike') continue;
    out.push(r.line[0]);
    let carry = 0;
    for (let i = 1; i < r.line.length; i++) {
      const a = r.line[i - 1], b = r.line[i], d = haversine(a, b);
      for (let t = DISLIKE_STEP - carry; t <= d; t += DISLIKE_STEP) out.push([a[0] + ((b[0] - a[0]) * t) / d, a[1] + ((b[1] - a[1]) * t) / d]);
      carry = (carry + d) % DISLIKE_STEP;
    }
    out.push(r.line[r.line.length - 1]);
  }
  return out.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${DISLIKE_R},${DISLIKE_WEIGHT}`).join('|');
}

// ---------- picking a road off the base map ----------
function featureLines(f) {
  const g = f.geometry;
  return g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
}
function pointSegDist(p, a, b) {
  const k = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110574;
  const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function pickRoad(e) {
  const box = [[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]];
  const p = [e.lngLat.lng, e.lngLat.lat];
  const near = map.queryRenderedFeatures(box).filter((f) => f.sourceLayer === 'transportation' && /Line/.test(f.geometry.type));
  let best = null, bestD = Infinity;
  for (const f of near) {
    for (const line of featureLines(f)) {
      for (let i = 1; i < line.length; i++) {
        const d = pointSegDist(p, line[i - 1], line[i]);
        if (d < bestD) { bestD = d; best = { f, line }; }
      }
    }
  }
  if (!best) return null;
  const cls = best.f.properties.class;
  // Name: the nearest named piece of road in the label layer.
  let name = `${cls || 'unnamed'} road`, nameD = 40;
  for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation_name' })) {
    if (!f.properties.name) continue;
    for (const ln of featureLines(f)) for (let i = 1; i < ln.length; i++) {
      const d = pointSegDist(p, ln[i - 1], ln[i]);
      if (d < nameD) { nameD = d; name = f.properties.name; }
    }
  }
  // Follow the road: tiles cut roads into overlapping pieces, so join any same-class piece that
  // passes within 15 m of the current end and carries on in roughly the same direction.
  const pool = map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation', filter: ['==', ['get', 'class'], cls] })
    .flatMap(featureLines).filter((l) => l.length > 1);
  let line = best.line.slice();
  const length = (l) => l.reduce((acc, q, i) => (i ? acc + haversine(l[i - 1], q) : 0), 0);
  const extend = (atEnd) => {
    for (let guard = 0; guard < 80 && length(line) < FOLLOW_M * 2; guard++) {
      const end = atEnd ? line[line.length - 1] : line[0];
      const prev = atEnd ? line[line.length - 2] : line[1];
      const heading = bearing(prev, end);
      let best2 = null;
      for (const cand of pool) {
        let j = -1, dj = 15;
        for (let i = 0; i < cand.length; i++) { const d = haversine(cand[i], end); if (d < dj) { dj = d; j = i; } }
        if (j < 0) continue;
        for (const rest of [cand.slice(j), cand.slice(0, j + 1).reverse()]) {
          if (rest.length < 2 || length(rest) < 15) continue;
          let turn = Math.abs(bearing(rest[0], rest[1]) - heading);
          if (turn > 180) turn = 360 - turn;
          // must lead somewhere new
          const tip = rest[rest.length - 1];
          if (turn < 40 && !line.some((q) => haversine(q, tip) < 10) && (!best2 || turn < best2.turn)) best2 = { rest, turn };
        }
      }
      if (!best2) break;
      const add = best2.rest.slice(1);
      line = atEnd ? line.concat(add) : add.reverse().concat(line);
    }
  };
  extend(true);
  extend(false);
  // Keep about FOLLOW_M each side of where you tapped.
  const ti = nearestIndex(line, p, 0);
  let i0 = ti, i1 = ti, d0 = 0, d1 = 0;
  while (i0 > 0 && d0 < FOLLOW_M) { d0 += haversine(line[i0 - 1], line[i0]); i0--; }
  while (i1 < line.length - 1 && d1 < FOLLOW_M) { d1 += haversine(line[i1], line[i1 + 1]); i1++; }
  return { name, line: simplifyLine(line.slice(i0, i1 + 1), 6) };
}

function simplifyLine(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) { const d = pointSegDist(pts[i], pts[a], pts[b]); if (d > worst) { worst = d; wi = i; } }
    if (worst > tol) { keep[wi] = true; stack.push([a, wi], [wi, b]); }
  }
  return pts.filter((_, i) => keep[i]).map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]);
}

// ---------- liked-road share of a route ----------
const LCELL = 0.0002;
function buildLikedCells() {
  likedCells = new Set();
  for (const r of markedRoads) {
    if (r.kind !== 'like') continue;
    for (let i = 1; i < r.line.length; i++) {
      const a = r.line[i - 1], b = r.line[i];
      const n = Math.max(1, Math.ceil(haversine(a, b) / 10));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        likedCells.add(`${Math.floor((a[0] + t * (b[0] - a[0])) / LCELL)}:${Math.floor((a[1] + t * (b[1] - a[1])) / LCELL)}`);
      }
    }
  }
}
function onLiked(p) {
  const cx = Math.floor(p[0] / LCELL), cy = Math.floor(p[1] / LCELL);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (likedCells.has(`${cx + dx}:${cy + dy}`)) return true;
  return false;
}
function likedShare(rt) {
  if (!likedCells || !likedCells.size) return null;
  let on = 0;
  for (const p of routePieces(rt, 50)) if (onLiked(rt.coords[p.i1])) on += rt.cum[p.i1] - rt.cum[p.i0];
  return { metres: on, pct: (100 * on) / (rt.length || 1) };
}
function likedVertices() {
  return markedRoads.filter((r) => r.kind === 'like').flatMap((r) => r.line);
}

// ---------- UI ----------
function renderRoads() {
  const src = map.getSource('marked-roads');
  if (src) {
    src.setData({
      type: 'FeatureCollection',
      features: markedRoads.map((r) => ({ type: 'Feature', properties: { kind: r.kind }, geometry: { type: 'LineString', coordinates: r.line } })),
    });
  }
  const ul = $('roads');
  ul.innerHTML = '';
  markedRoads.forEach((r, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(r.name)}</span><span class="badge ${r.kind}">${r.kind === 'like' ? 'liked' : 'avoid'}</span><button class="x" title="Delete">✕</button>`;
    li.querySelector('span').onclick = () => {
      const b = new maplibregl.LngLatBounds();
      r.line.forEach((p) => b.extend(p));
      map.fitBounds(b, { padding: 80, maxZoom: 16 });
    };
    li.querySelector('button').onclick = () => { markedRoads.splice(i, 1); saveRoads(); };
    ul.appendChild(li);
  });
  renderRoadSummary();
}

function renderRoadSummary() {
  const el = $('road-sum');
  if (!route) { el.textContent = ''; return; }
  const s = likedShare(route);
  el.textContent = s ? `This route uses ${fmtKm(s.metres)} km of your liked roads (${Math.round(s.pct)}%).` : '';
}

async function saveRoads() {
  buildLikedCells();
  renderRoads();
  store.set('cp.roads', markedRoads);
  try { await fetch('/api/settings/roads', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(markedRoads) }); }
  catch { /* kept in this browser */ }
  requestRoute(false);
}

function setMarking(kind) {
  if (kind && typeof placingNogo !== 'undefined' && placingNogo) setPlacing(false); // one thing at a time
  markingKind = markingKind === kind ? null : kind;
  document.body.classList.toggle('placing', !!markingKind);
  $('road-like').textContent = markingKind === 'like' ? 'Tap a road (tap here to cancel)' : 'Like a road';
  $('road-dislike').textContent = markingKind === 'dislike' ? 'Tap a road (tap here to cancel)' : 'Avoid a road';
}

const roadClick = (e) => {
  if (!markingKind) return false;
  const r = pickRoad(e);
  if (!r) { showMsg('No road there. Zoom in and tap right on the road.'); setTimeout(() => showMsg(''), 3000); return true; }
  markedRoads.push({ kind: markingKind, ...r });
  setMarking(null);
  saveRoads();
  return true;
};
roadClick.busy = () => !!markingKind;
clickHandlers.push(roadClick);
$('road-like').onclick = () => setMarking('like');
$('road-dislike').onclick = () => setMarking('dislike');

map.on('load', async () => {
  map.addSource('marked-roads', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'marked-roads', type: 'line', source: 'marked-roads',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['match', ['get', 'kind'], 'like', '#2f9e44', '#e03131'], 'line-width': 7, 'line-opacity': 0.45 } }, 'route-casing');
  try {
    const res = await fetch('/api/settings/roads');
    if (!res.ok) throw new Error();
    const v = await res.json();
    markedRoads = Array.isArray(v) ? v : store.get('cp.roads', []);
  } catch { markedRoads = store.get('cp.roads', []); }
  buildLikedCells();
  renderRoads();
  if (markedRoads.some((r) => r.kind === 'dislike') && waypoints.length > 1) requestRoute(false);
});
routeHooks.push(renderRoadSummary);
