'use strict';
/* Alternative routes for A-to-B: BRouter alternativeidx 1-3, drawn in grey, tap to switch. */

let altRoutes = [];   // [{idx, rt}]
let altSeq = 0;

function renderAlts() {
  const src = map.getSource('alts');
  if (src) {
    src.setData({
      type: 'FeatureCollection',
      features: altRoutes.filter((a) => a.idx !== altIndex).map((a) => ({
        type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: a.rt.coords.map((c) => [c[0], c[1]]) },
      })),
    });
  }
  const ul = $('alts');
  ul.innerHTML = '';
  if (!altRoutes.length) return;
  const base = altRoutes.find((a) => a.idx === 0);
  for (const a of altRoutes) {
    const li = document.createElement('li');
    if (a.idx === altIndex) li.classList.add('active');
    const diff = base ? (a.rt.length - base.rt.length) / 1000 : 0;
    li.innerHTML = `<span class="km">${fmtKm(a.rt.length)}</span><span>${a.idx === 0 ? 'Best' : `Option ${a.idx + 1}`} · ${Math.round(a.rt.ascend)} m up` +
      `${a.idx ? ` · ${diff >= 0 ? '+' : ''}${diff.toFixed(1)} km` : ''}</span>${a.idx === altIndex ? '<span class="off">riding this</span>' : ''}`;
    li.onclick = () => { altIndex = a.idx; requestRoute(false); };
    ul.appendChild(li);
  }
}

async function loadAlternatives() {
  const seq = ++altSeq;
  const keep = altIndex;
  altRoutes = [];
  renderAlts();
  if (!$('opt-alts').checked || waypoints.length < 2 || !route) return;
  const pts = waypoints.map((w) => [w.lng, w.lat]);
  const prof = $('profile').value;
  const found = [];
  for (let idx = 0; idx <= 3; idx++) {
    try {
      const rt = idx === keep ? route : await brouterRoute(pts, prof, undefined, idx);
      if (seq !== altSeq) return;
      // BRouter sometimes returns the same route twice; keep distinct ones.
      if (!found.some((f) => Math.abs(f.rt.length - rt.length) < 30)) found.push({ idx, rt });
    } catch { break; }
  }
  altRoutes = found;
  renderAlts();
}

map.on('load', () => {
  map.addSource('alts', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'alts', type: 'line', source: 'alts',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#495057', 'line-opacity': 0.55, 'line-width': 4, 'line-dasharray': [1.5, 1] } }, 'route-casing');
});

$('opt-alts').checked = store.get('cp.opt-alts', false);
$('opt-alts').addEventListener('change', () => { store.set('cp.opt-alts', $('opt-alts').checked); loadAlternatives(); });
// Reload alternatives when the route's waypoints or options change (not when switching between them).
let altKey = '';
routeHooks.push(() => {
  const key = JSON.stringify([waypoints, $('profile').value, getOptions(), typeof nogoParam === 'function' ? nogoParam() : '']);
  if (key !== altKey) { altKey = key; loadAlternatives(); } else renderAlts();
});
