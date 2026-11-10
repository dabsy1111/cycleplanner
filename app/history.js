'use strict';
/* Ride history from intervals.icu (via the history service): map layer and new-roads share. */

const HISTORY_API = '/api/history';
const CELL_LAT = 0.0002, CELL_LNG = 0.00024; // ~22 m around Perth
let ridden = null; // Set of grid cells you've ridden through
let historyPoll = null;

const cellKey = (lng, lat) => `${Math.floor(lng / CELL_LNG)}:${Math.floor(lat / CELL_LAT)}`;

function buildIndex(fc) {
  const set = new Set();
  for (const f of fc.features) {
    const c = f.geometry.coordinates;
    for (let i = 1; i < c.length; i++) {
      const steps = Math.max(1, Math.ceil(haversine(c[i - 1], c[i]) / 10));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        set.add(cellKey(c[i - 1][0] + t * (c[i][0] - c[i - 1][0]), c[i - 1][1] + t * (c[i][1] - c[i - 1][1])));
      }
    }
  }
  return set;
}

function isRidden(lng, lat) {
  if (!ridden) return false;
  const cx = Math.floor(lng / CELL_LNG), cy = Math.floor(lat / CELL_LAT);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (ridden.has(`${cx + dx}:${cy + dy}`)) return true;
  return false;
}

// Share of a route (0–100) that you haven't ridden before, sampled every 25 m.
function newRoadShare(rt) {
  if (!ridden || !ridden.size) return null;
  let total = 0, fresh = 0;
  for (let i = 1; i < rt.coords.length; i++) {
    const a = rt.coords[i - 1], b = rt.coords[i];
    const steps = Math.max(1, Math.round((rt.cum[i] - rt.cum[i - 1]) / 25));
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      total++;
      if (!isRidden(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))) fresh++;
    }
  }
  return total ? (100 * fresh) / total : null;
}

colourers.new = (rt) => routePieces(rt, 100).map((p) => {
  let fresh = 0, n = 0;
  for (let i = p.i0; i <= p.i1; i++) { n++; if (!isRidden(rt.coords[i][0], rt.coords[i][1])) fresh++; }
  return { ...p, color: !ridden ? ROUTE_COLOR : fresh / n > 0.5 ? '#7048e8' : '#adb5bd' };
});

function renderNewShare() {
  const el = $('hist-new');
  const pct = route ? newRoadShare(route) : null;
  el.textContent = pct == null ? '' : `${Math.round(pct)}% of this route (${fmtKm(route.length * pct / 100)} km) is road you haven't ridden.`;
}

async function loadTracks() {
  const res = await fetch(`${HISTORY_API}/tracks`);
  if (!res.ok) return;
  const fc = await res.json();
  ridden = buildIndex(fc);
  if (map.getSource('history')) map.getSource('history').setData(fc);
  renderNewShare();
  if ($('colour-by').value === 'new') refreshRouteColours();
}

async function checkHistory(reloadTracks) {
  const st = $('hist-status'), btn = $('hist-sync');
  let s;
  try {
    const res = await fetch(`${HISTORY_API}/status`);
    if (!res.ok) throw new Error();
    s = await res.json();
  } catch {
    st.textContent = 'The history service isn\'t running. Add it to the stack (see the README).';
    btn.disabled = true;
    return;
  }
  btn.disabled = !s.configured || s.syncing;
  if (!s.configured) {
    st.textContent = 'Not connected yet: add your intervals.icu API key as ICU_API_KEY in the stack, then redeploy.';
    return;
  }
  const when = s.last_sync ? new Date(s.last_sync * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'never';
  st.textContent = s.syncing
    ? `Syncing… ${s.progress || ''}`
    : `${s.rides} outdoor rides with GPS · last sync ${when}` + (s.error ? ` · last error: ${s.error}` : '');
  clearTimeout(historyPoll);
  if (s.syncing) historyPoll = setTimeout(() => checkHistory(true), 3000);
  else if (reloadTracks) loadTracks();
}

map.on('load', () => {
  map.addSource('history', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'history', type: 'line', source: 'history',
    layout: { 'line-join': 'round', 'line-cap': 'round', visibility: store.get('cp.hist', true) ? 'visible' : 'none' },
    paint: { 'line-color': '#1f2f5c', 'line-opacity': histOpacity(), 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 16, 4] } }, 'route-casing');
  checkHistory(true);
});

function histOpacity() { return (+$('hist-opacity').value || 45) / 100; }
$('hist-opacity').value = store.get('cp.histop', 45);
$('hist-opacity').addEventListener('input', () => {
  store.set('cp.histop', +$('hist-opacity').value);
  $('hist-opacity-val').textContent = `${$('hist-opacity').value}%`;
  if (map.getLayer('history')) map.setPaintProperty('history', 'line-opacity', histOpacity());
});
$('hist-opacity-val').textContent = `${$('hist-opacity').value}%`;
$('hist-show').checked = store.get('cp.hist', true);
$('hist-show').onchange = (e) => {
  store.set('cp.hist', e.target.checked);
  map.setLayoutProperty('history', 'visibility', e.target.checked ? 'visible' : 'none');
};
$('hist-sync').onclick = async () => {
  $('hist-sync').disabled = true;
  try { await fetch(`${HISTORY_API}/sync`, { method: 'POST' }); } catch { /* status shows the error */ }
  setTimeout(() => checkHistory(true), 500);
};
routeHooks.push(renderNewShare);
