'use strict';
/* Climbs on the planned route: start where the road starts going up, end at the top. */

const CLIMB_MIN_GAIN = 15;   // metres
const CLIMB_MIN_GRADE = 3;   // percent, average
let climbList = [];

// Smooth elevation over ~60 m so GPS/DEM noise doesn't split one climb into many.
function smoothedElevation(rt) {
  const n = rt.coords.length, out = new Array(n);
  let a = 0, b = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    while (b < n && rt.cum[b] - rt.cum[i] <= 30) { sum += rt.coords[b][2] ?? 0; b++; }
    while (rt.cum[i] - rt.cum[a] > 30) { sum -= rt.coords[a][2] ?? 0; a++; }
    out[i] = sum / (b - a);
  }
  return out;
}

function findClimbs(rt) {
  if (rt.coords[0].length < 3) return [];
  const e = smoothedElevation(rt);
  const L = rt.cum[rt.cum.length - 1];
  const STEP = 100;
  const n = Math.floor(L / STEP);
  if (n < 2) return [];
  // Elevation every 100 m along the route.
  const E = [];
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const d = k * STEP;
    while (j < rt.cum.length - 2 && rt.cum[j + 1] < d) j++;
    const span = rt.cum[j + 1] - rt.cum[j];
    const t = span ? Math.min(1, Math.max(0, (d - rt.cum[j]) / span)) : 0;
    E.push(e[j] + t * (e[j + 1] - e[j]));
  }
  const g = E.slice(1).map((v, k) => v - E[k]); // % grade of each 100 m step
  // A step is "climbing" if the 300 m around it averages 1.5% or more.
  const up = g.map((_, k) => {
    const a = Math.max(0, k - 1), b = Math.min(g.length - 1, k + 1);
    let s = 0; for (let q = a; q <= b; q++) s += g[q];
    return s / (b - a + 1) >= 1.5;
  });
  const climbs = [];
  let k = 0;
  while (k < g.length) {
    if (!up[k]) { k++; continue; }
    let end = k;
    while (end + 1 < g.length && (up[end + 1] || (end + 2 < g.length && up[end + 2] && g[end + 1] > -1))) end++;
    // Trim flat bits off both ends.
    let a = k, b = end;
    while (a < b && g[a] < 1) a++;
    while (b > a && g[b] < 1) b--;
    const gain = E[b + 1] - E[a], len = (b - a + 1) * STEP;
    if (gain >= CLIMB_MIN_GAIN && (100 * gain) / len >= CLIMB_MIN_GRADE) {
      const i0 = indexAt(rt, a * STEP), i1 = indexAt(rt, Math.min(L, (b + 1) * STEP));
      climbs.push({ i0, i1, len, gain, avg: (100 * gain) / len, max: Math.max(...g.slice(a, b + 1)) });
    }
    k = end + 1;
  }
  return climbs;
}

function renderClimbs() {
  const ul = $('climbs');
  ul.innerHTML = '';
  const src = map.getSource('climb-hl');
  if (src) src.setData(emptyFC());
  if (!route) return;
  if (!climbList.length) { ul.innerHTML = '<li class="small">No climbs on this route.</li>'; return; }
  climbList.forEach((c) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="km">${(route.cum[c.i0] / 1000).toFixed(1)}</span>` +
      `<i class="dot" style="background:${gradeColour(c.avg)}"></i>` +
      `<span>${fmtKm(c.len)} km at ${c.avg.toFixed(1)}% (max ${c.max.toFixed(0)}%)</span><span class="off">+${Math.round(c.gain)} m</span>`;
    li.onclick = () => {
      const coords = route.coords.slice(c.i0, c.i1 + 1).map((p) => [p[0], p[1]]);
      if (map.getSource('climb-hl')) map.getSource('climb-hl').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
      const b = new maplibregl.LngLatBounds();
      coords.forEach((p) => b.extend(p));
      map.fitBounds(b, { padding: 80, maxZoom: 16 });
    };
    ul.appendChild(li);
  });
}

map.on('load', () => {
  map.addSource('climb-hl', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'climb-hl', type: 'line', source: 'climb-hl',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#c92a2a', 'line-opacity': 0.5, 'line-width': 16 } }, 'route-casing');
});
routeHooks.push((rt) => { climbList = rt ? findClimbs(rt) : []; renderClimbs(); });
