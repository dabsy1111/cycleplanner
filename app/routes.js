'use strict';
/* Saved routes and short links on the server (shared by every device), GPX sharing, route options. */

const ROUTES_API = '/api/routes';
let serverRoutes = null; // null = server not reachable, use this browser's storage

// ---------- route options (top row + Route options section) ----------
function getOptions() {
  return {
    footpaths: $('opt-footpaths').checked, traffic: $('opt-traffic').value,
    lights: $('opt-lights').checked, turns: $('opt-turns').checked, popular: $('opt-popular').value,
  };
}
function applyOptions(o) {
  if (!o) return;
  if ('footpaths' in o) $('opt-footpaths').checked = !!o.footpaths;
  if ('traffic' in o) $('opt-traffic').value = o.traffic;
  if ('lights' in o) $('opt-lights').checked = !!o.lights;
  if ('turns' in o) $('opt-turns').checked = !!o.turns;
  if ('popular' in o) $('opt-popular').value = o.popular;
}
for (const id of ['opt-lights', 'opt-turns']) {
  $(id).checked = store.get('cp.' + id, false);
  $(id).addEventListener('change', () => { store.set('cp.' + id, $(id).checked); requestRoute(false); });
}

// ---------- server calls ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

function routeRecord(saved) {
  return {
    name: routeName(), saved, wp: waypoints, profile: $('profile').value,
    km: route ? fmtKm(route.length) : null, options: getOptions(),
  };
}

function loadRoute(r, fit = true) {
  $('profile').value = r.profile === 'fastbike-lowtraffic' ? 'fastbike' : (r.profile || 'fastbike');
  applyOptions(r.options);
  if (r.name) $('route-name').value = r.name;
  setWaypoints(r.wp, { fit });
}

async function refreshSaved() {
  try {
    serverRoutes = await api(ROUTES_API);
    $('saved-status').textContent = 'Saved on your server, shared by all your devices.';
  } catch {
    serverRoutes = null;
    $('saved-status').textContent = 'Server unavailable: saving in this browser only.';
  }
  renderSaved();
}

function renderSaved() {
  const ul = $('saved');
  ul.innerHTML = '';
  const list = serverRoutes ?? store.get('cp.routes', []);
  list.forEach((r, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(r.name || 'Untitled')} <small class="small">${r.km ?? ''} km</small></span><button title="Delete">✕</button>`;
    li.querySelector('span').onclick = async () => {
      if (serverRoutes) {
        try { loadRoute(await api(`${ROUTES_API}/${r.id}`)); } catch { showMsg('Could not load that route.'); }
      } else loadRoute(r);
    };
    li.querySelector('button').onclick = async () => {
      if (serverRoutes) { try { await api(`${ROUTES_API}/${r.id}`, { method: 'DELETE' }); } catch { /* shown on refresh */ } refreshSaved(); }
      else { const l = store.get('cp.routes', []); l.splice(i, 1); store.set('cp.routes', l); renderSaved(); }
    };
    ul.appendChild(li);
  });
}

$('save').onclick = async () => {
  if (waypoints.length < 2) { showMsg('Plan a route first.'); return; }
  const rec = routeRecord(true);
  if (serverRoutes) {
    try { await api(ROUTES_API, { method: 'POST', body: JSON.stringify(rec) }); }
    catch { showMsg('Saving to the server failed.'); return; }
    await refreshSaved();
  } else {
    const list = store.get('cp.routes', []);
    const i = list.findIndex((r) => r.name === rec.name);
    if (i >= 0) list[i] = rec; else list.unshift(rec);
    store.set('cp.routes', list);
    renderSaved();
  }
  showMsg(`Saved “${rec.name}”.`);
  setTimeout(() => showMsg(''), 3000);
};

$('share').onclick = async () => {
  if (waypoints.length < 2) { showMsg('Plan a route first.'); return; }
  let url = location.href;
  try {
    const rec = await api(ROUTES_API, { method: 'POST', body: JSON.stringify(routeRecord(false)) });
    url = `${location.origin}${location.pathname}#r=${rec.id}`;
  } catch { /* server down: fall back to the long link */ }
  try { await navigator.clipboard.writeText(url); showMsg(`Link copied: ${url}`); }
  catch { showMsg(url); } // clipboard needs https; show it to copy by hand
  setTimeout(() => showMsg(''), 8000);
};

// Short link: #r=<id>
async function openShortLink() {
  const id = new URLSearchParams(location.hash.slice(1)).get('r');
  if (!id) return;
  try { loadRoute(await api(`${ROUTES_API}/${encodeURIComponent(id)}`)); }
  catch { showMsg('That link has expired or the server is unavailable.'); }
}

// One-off: move routes saved in this browser before server storage existed.
async function migrateLocalRoutes() {
  if (!serverRoutes || store.get('cp.routesMigrated', false)) return;
  const local = store.get('cp.routes', []);
  for (const r of local) {
    try { await api(ROUTES_API, { method: 'POST', body: JSON.stringify({ ...r, saved: true }) }); } catch { return; }
  }
  store.set('cp.routesMigrated', true);
  if (local.length) refreshSaved();
}

map.on('load', async () => {
  await refreshSaved();
  migrateLocalRoutes();
  openShortLink();
});
window.addEventListener('hashchange', openShortLink);

// ---------- GPX via the phone's share sheet ----------
function gpxFile() {
  return new File([buildGpx()], routeName().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_') + '.gpx', { type: 'application/gpx+xml' });
}
try {
  const probe = new File(['x'], 'x.gpx', { type: 'application/gpx+xml' });
  if (navigator.canShare && navigator.canShare({ files: [probe] })) $('gpx-share').hidden = false;
} catch { /* sharing files not supported here */ }
$('gpx-share').onclick = async () => {
  if (!route) { showMsg('Plan a route first.'); return; }
  try { await navigator.share({ files: [gpxFile()], title: routeName() }); }
  catch (e) { if (e.name !== 'AbortError') showMsg('Sharing failed: ' + e.message); }
};
