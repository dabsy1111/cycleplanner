'use strict';
/* No-go areas: circles BRouter must stay out of ("hard") or should go around if it's not a big detour ("soft"). */

const SOFT_NOGO_WEIGHT = 10; // BRouter cost per metre ridden inside a soft area
let nogoAreas = [];
let placingNogo = false;

function nogoParam() {
  return nogoAreas.map((a) => `${a.lng.toFixed(6)},${a.lat.toFixed(6)},${a.r}${a.mode === 'soft' ? ',' + SOFT_NOGO_WEIGHT : ''}`).join('|');
}

function circlePolygon(a) {
  const ring = [];
  for (let k = 0; k <= 48; k++) ring.push(destination([a.lng, a.lat], (k * 360) / 48, a.r));
  return ring;
}

function renderNogos() {
  const src = map.getSource('nogos');
  if (src) {
    src.setData({
      type: 'FeatureCollection',
      features: nogoAreas.map((a) => ({ type: 'Feature', properties: { mode: a.mode }, geometry: { type: 'Polygon', coordinates: [circlePolygon(a)] } })),
    });
  }
  const ul = $('nogos');
  ul.innerHTML = '';
  nogoAreas.forEach((a, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>Area ${i + 1} · ${a.r} m</span>` +
      `<span class="badge ${a.mode}">${a.mode === 'hard' ? 'avoid completely' : 'prefer to avoid'}</span>` +
      '<button class="x" title="Switch hard/soft">⇄</button><button class="x" title="Delete">✕</button>';
    const [swap, del] = li.querySelectorAll('button');
    li.querySelector('span').onclick = () => map.flyTo({ center: [a.lng, a.lat], zoom: Math.max(map.getZoom(), 15) });
    swap.onclick = () => { a.mode = a.mode === 'hard' ? 'soft' : 'hard'; saveNogos(); };
    del.onclick = () => { nogoAreas.splice(i, 1); saveNogos(); };
    ul.appendChild(li);
  });
}

async function saveNogos() {
  renderNogos();
  store.set('cp.nogos', nogoAreas);
  try { await fetch('/api/settings/nogos', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nogoAreas) }); }
  catch { /* kept in this browser */ }
  requestRoute(false);
}

async function loadNogos() {
  try {
    const res = await fetch('/api/settings/nogos');
    if (!res.ok) throw new Error();
    const v = await res.json();
    nogoAreas = Array.isArray(v) ? v : store.get('cp.nogos', []);
  } catch { nogoAreas = store.get('cp.nogos', []); }
  renderNogos();
  if (nogoAreas.length && waypoints.length > 1) requestRoute(false);
}

function setPlacing(on) {
  if (on && typeof markingKind !== 'undefined' && markingKind) setMarking(null); // one thing at a time
  placingNogo = on;
  document.body.classList.toggle('placing', on);
  $('nogo-add').textContent = on ? 'Tap the map (tap here to cancel)' : 'Avoid an area';
}

const nogoClick = (e) => {
  if (!placingNogo) return false;
  nogoAreas.push({ lng: e.lngLat.lng, lat: e.lngLat.lat, r: +$('nogo-radius').value, mode: $('nogo-mode').value });
  setPlacing(false);
  saveNogos();
  return true;
};
nogoClick.busy = () => placingNogo;
clickHandlers.push(nogoClick);

$('nogo-add').onclick = () => setPlacing(!placingNogo);

map.on('load', () => {
  map.addSource('nogos', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'nogos-fill', type: 'fill', source: 'nogos',
    paint: { 'fill-color': ['match', ['get', 'mode'], 'hard', '#e03131', '#f59f00'], 'fill-opacity': 0.18 } }, 'route-casing');
  map.addLayer({ id: 'nogos-line', type: 'line', source: 'nogos',
    paint: { 'line-color': ['match', ['get', 'mode'], 'hard', '#e03131', '#f59f00'], 'line-width': 2, 'line-dasharray': [2, 1.5] } }, 'route-casing');
  loadNogos();
});
