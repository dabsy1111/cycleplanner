'use strict';
/* GPX import: turn someone else's track into an editable route. The track is thinned to waypoints
   the router can follow, and the original stays on the map in grey so you can see where it differs. */

let importRef = null; // original track [[lng,lat],...]

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('not a valid GPX file');
  let pts = [...doc.getElementsByTagName('trkpt')];
  if (!pts.length) pts = [...doc.getElementsByTagName('rtept')];
  const coords = pts.map((p) => [+p.getAttribute('lon'), +p.getAttribute('lat')]).filter((c) => c.every(Number.isFinite));
  if (coords.length < 2) throw new Error('no track or route points in that file');
  const nameEl = doc.querySelector('trk > name, rte > name, metadata > name');
  return { coords, name: nameEl ? nameEl.textContent.trim() : '' };
}

// Waypoints that make the router reproduce the track: the shape points, no gap over 1.5 km, at most 120.
function waypointsFor(track) {
  let tol = 40, wps;
  for (;;) {
    const shape = simplifyLine(track, tol);
    wps = [shape[0]];
    for (let i = 1; i < shape.length; i++) {
      const a = shape[i - 1], b = shape[i];
      const n = Math.floor(haversine(a, b) / 1500);
      for (let k = 1; k <= n; k++) {
        // Use a real track point near the in-between spot so it sits on the road.
        const t = k / (n + 1), mid = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        wps.push(track[nearestIndex(track, mid, 0)]);
      }
      wps.push(b);
    }
    if (wps.length <= 120 || tol > 400) break;
    tol *= 1.6;
  }
  return wps.map(([lng, lat]) => ({ lng, lat }));
}

function matchShare(rt) {
  const C = 0.0003;
  const cells = new Set();
  for (let i = 1; i < importRef.length; i++) {
    const a = importRef[i - 1], b = importRef[i];
    const n = Math.max(1, Math.ceil(haversine(a, b) / 15));
    for (let k = 0; k <= n; k++) cells.add(`${Math.floor((a[0] + (k / n) * (b[0] - a[0])) / C)}:${Math.floor((a[1] + (k / n) * (b[1] - a[1])) / C)}`);
  }
  let on = 0;
  for (const p of routePieces(rt, 50)) {
    const c = rt.coords[p.i1], cx = Math.floor(c[0] / C), cy = Math.floor(c[1] / C);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1; dy++) if (cells.has(`${cx + dx}:${cy + dy}`)) { hit = true; break; }
    if (hit) on += rt.cum[p.i1] - rt.cum[p.i0];
  }
  return (100 * on) / (rt.length || 1);
}

function showRef() {
  const src = map.getSource('import-ref');
  if (src) src.setData(importRef ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: importRef } } : emptyFC());
}

function renderImportStatus() {
  const el = $('import-status');
  if (!importRef) { el.innerHTML = ''; return; }
  const pct = route ? matchShare(route) : null;
  el.innerHTML = `Original track shown in grey${pct != null ? `; this route follows ${Math.round(pct)}% of it` : ''}. ` +
    'Drag the line or the points to change it. <button class="linkbtn" id="import-hide">Hide original</button>';
  $('import-hide').onclick = () => { importRef = null; showRef(); renderImportStatus(); };
}

$('gpx-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { coords, name } = parseGpx(await file.text());
    importRef = coords;
    showRef();
    if (name) $('route-name').value = name;
    setWaypoints(waypointsFor(coords), { fit: true });
  } catch (err) {
    $('import-status').textContent = `Couldn't import that file: ${err.message}.`;
  }
});

map.on('load', () => {
  map.addSource('import-ref', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'import-ref', type: 'line', source: 'import-ref',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#495057', 'line-width': 7, 'line-opacity': 0.35 } }, 'route-casing');
});
routeHooks.push(renderImportStatus);
