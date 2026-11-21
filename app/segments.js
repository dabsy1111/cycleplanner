'use strict';
/* Segment hunter: Strava segments where your power, your weight and the forecast wind add up to
   a top-10 time, and a route through the ones you pick.
   Segments and their top-10 times come from the history service (history/strava.py). */

const HUNT_CDA = 0.30;        // flat out, on the drops (the ride-time model uses 0.32 on the hoods)
const HUNT_WIND = 0.7;        // forecast wind is at 10 m; at rider height it's about 70% of that
const HUNT_MAX_KMH = 75;
const HUNT_VIA_EVERY = 400;   // metres between the points that hold a route on a segment
const HUNT_COLOURS = { beat: '#2f9e44', close: '#f59f00', far: '#e8590c', none: '#868e96' };

let huntSegs = [];            // segments in view, from the server
let huntStatusData = null;
let huntCurve = null;         // {secs, watts} best power over 90 days, from intervals.icu
const huntPicked = new Set(store.get('cp.hunt.picked', []));
let huntPoll = 0;

function huntOpen() { const d = document.querySelector('details[data-key="hunt"]'); return d && d.open; }
function huntSay(t) { $('hunt-status').textContent = t || ''; }

// ---------- your power for a given effort length ----------
// From your 90-day power curve if intervals.icu gave one, otherwise FTP plus a typical
// 16 kJ of anaerobic work (fits a 250 W FTP rider's own 1, 5 and 20 min bests within a few %).
function huntPower(secs) {
  const eff = (+$('hunt-effort').value || 100) / 100;
  let p;
  if (huntCurve && huntCurve.secs.length > 4) {
    const s = huntCurve.secs, w = huntCurve.watts;
    if (secs <= s[0]) p = w[0];
    else if (secs >= s[s.length - 1]) p = w[w.length - 1] * Math.pow(s[s.length - 1] / secs, 0.07);
    else {
      let i = 0; while (s[i + 1] < secs) i++;
      const f = Math.log(secs / s[i]) / Math.log(s[i + 1] / s[i]);
      p = w[i] + f * (w[i + 1] - w[i]);
    }
  } else {
    p = Math.min(athlete.ftp + 16000 / Math.max(secs, 20), athlete.ftp * 3);
    if (secs > 3600) p = athlete.ftp * Math.pow(3600 / secs, 0.07);
  }
  return p * eff;
}

function huntSpeed(P, grade, head, mass) {
  const th = Math.atan(grade), Pw = P * DRIVETRAIN;
  const resist = (v) => (CRR * mass * G * Math.cos(th) + mass * G * Math.sin(th)) * v + 0.5 * RHO * HUNT_CDA * (v + head) * Math.abs(v + head) * v;
  let lo = 0.3, hi = HUNT_MAX_KMH / 3.6;
  if (resist(hi) < Pw) return hi;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (resist(m) < Pw) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

// Pieces of ~100 m: length, gradient, bearing.
function huntPieces(seg) {
  if (seg._pieces) return seg._pieces;
  const c = seg.coords, out = [];
  const flatGrade = (seg.grade || 0) / 100;
  let a = 0, len = 0;
  for (let i = 1; i < c.length; i++) {
    len += haversine(c[i - 1], c[i]);
    if (len >= 100 || i === c.length - 1) {
      const dz = seg.has_ele && c[i][2] != null && c[a][2] != null ? c[i][2] - c[a][2] : null;
      out.push({ len, grade: Math.max(-0.2, Math.min(0.2, dz != null && len > 20 ? dz / len : flatGrade)), brg: bearing(c[a], c[i]) });
      a = i; len = 0;
    }
  }
  return (seg._pieces = out);
}

// Your predicted time: the power you can hold for t seconds has to carry you over the segment in t seconds.
function huntPredict(seg, w) {
  const pcs = huntPieces(seg), mass = athlete.weight + BIKE_KG, r = Math.PI / 180;
  const head = pcs.map((p) => (w ? (w.speed / 3.6) * HUNT_WIND * Math.cos((w.dir - p.brg) * r) : 0));
  const ride = (P) => pcs.reduce((t, p, i) => t + p.len / huntSpeed(P, p.grade, head[i], mass), 0);
  let t = ride(athlete.ftp);
  for (let k = 0; k < 8; k++) t = ride(huntPower(t));
  const total = pcs.reduce((s, p) => s + p.len, 0) || 1;
  const avgHead = pcs.reduce((s, p, i) => s + head[i] * p.len, 0) / total * 3.6 / HUNT_WIND; // as forecast, km/h
  return { secs: t, watts: huntPower(t), head: avgHead };
}

function fmtSecs(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

function huntClass(s) {
  if (!s.pred || !s.target) return 'none';
  return s.pct <= 0 ? 'beat' : s.pct <= 5 ? 'close' : 'far';
}

// ---------- data ----------
async function huntLoadStatus() {
  try {
    const r = await fetch('/api/strava/status');
    if (!r.ok) throw new Error();
    huntStatusData = await r.json();
  } catch { huntStatusData = null; }
  renderHuntStatus();
  const busy = huntStatusData && (huntStatusData.scan.running || huntStatusData.times_queued > 0);
  clearTimeout(huntPoll);
  if (busy && huntOpen()) huntPoll = setTimeout(() => { huntLoadStatus(); huntLoadSegs(); }, 5000);
}

function renderHuntStatus() {
  const s = huntStatusData;
  $('hunt-connect').hidden = !(s && s.configured && !s.connected);
  $('hunt-scan').hidden = !(s && s.connected);
  $('hunt-disconnect').hidden = !(s && s.connected);
  if (!s) { $('hunt-server').textContent = 'The history service isn\'t answering, and it\'s what looks up segments.'; return; }
  const bits = [];
  if (!s.configured) bits.push('Strava API not set up, so segments can only be added by link (see the README to search whole areas).');
  else if (!s.connected) bits.push('Connect Strava to search the map for segments.');
  else bits.push(`Strava: ${s.athlete || 'connected'}.`);
  const sc = s.scan;
  if (sc.running) bits.push(`Searching… ${sc.done} areas checked, ${sc.found} segments${sc.waiting ? `, waiting ${Math.ceil(sc.waiting / 60)} min for Strava's rate limit` : ''}.`);
  else if (sc.error) bits.push(`Search stopped: ${sc.error}`);
  if (s.times_queued) bits.push(`Getting top-10 times: ${s.times_queued} to go (one every few seconds).`);
  if (s.times_error) bits.push(`Last problem: ${s.times_error}`);
  $('hunt-server').textContent = bits.join(' ');
}

function huntBbox() {
  const b = map.getBounds();
  return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
}

async function huntLoadSegs() {
  if (!huntOpen()) return;
  const [s, w, n, e] = huntBbox();
  if ((n - s) * (e - w) > 3.5) { huntSegs = []; huntSay('Zoom in to see segments.'); huntRender(); return; }
  try {
    const r = await fetch(`/api/strava/segments?bbox=${[s, w, n, e].map((v) => v.toFixed(4)).join(',')}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const fresh = await r.json();
    const old = new Map(huntSegs.map((x) => [x.id, x]));
    huntSegs = fresh.map((x) => { const o = old.get(x.id); return o && o.coords.length === x.coords.length ? Object.assign(o, x) : x; });
  } catch (err) { huntSay(`Couldn't load segments: ${err.message}`); return; }
  huntRecompute();
}

async function huntEnsureWind() {
  if (typeof wind !== 'undefined' && wind) return;
  const c = map.getCenter();
  try { await loadWind(c.lng, c.lat); } catch { /* predictions run in still air */ }
}

function huntRecompute() {
  const w = typeof windAt === 'function' ? windAt(departureMs()) : null;
  const maxKm = +$('hunt-maxkm').value || 999;
  for (const s of huntSegs) {
    s.pred = s.coords && s.coords.length > 1 && athlete ? huntPredict(s, w) : null;
    s.pct = s.pred && s.target ? (100 * (s.pred.secs - s.target)) / s.target : null;
    s.tooLong = (s.distance || 0) / 1000 > maxKm;
  }
  const dep = new Date(departureMs());
  $('hunt-when').textContent = `${dep.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` +
    (w ? `, wind ${compass(w.dir)} ${Math.round(w.speed)} km/h` : ', no wind forecast (still air)');
  huntRender();
}

// ---------- drawing ----------
function huntFeatures() {
  const feats = [];
  for (const s of huntSegs) {
    if (s.hidden || s.tooLong || !s.coords) continue;
    const cls = huntClass(s);
    const props = { id: s.id, cls, color: HUNT_COLOURS[cls], picked: huntPicked.has(s.id) ? 1 : 0 };
    feats.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: s.coords.map((p) => [p[0], p[1]]) } });
    feats.push({ type: 'Feature', properties: { ...props, start: 1 }, geometry: { type: 'Point', coordinates: [s.coords[0][0], s.coords[0][1]] } });
  }
  return { type: 'FeatureCollection', features: feats };
}

function huntRender() {
  if (map.getSource('hunt')) map.getSource('hunt').setData(huntOpen() ? huntFeatures() : emptyFC());
  const ul = $('hunt-list');
  ul.innerHTML = '';
  const shown = huntSegs.filter((s) => !s.hidden && !s.tooLong);
  const ranked = shown.filter((s) => s.pct != null).sort((a, b) => a.pct - b.pct);
  const waiting = shown.filter((s) => s.pct == null && !s.lb_at);
  const noBoard = shown.filter((s) => s.lb_at && !s.target).length;
  const hiddenN = huntSegs.filter((s) => s.hidden).length, longN = huntSegs.filter((s) => s.tooLong && !s.hidden).length;
  if (!huntSegs.length) huntSay(huntStatusData && huntStatusData.connected ? 'No segments known here yet: press "Find segments in this view".' : 'No segments here yet. Add one by link below.');
  else huntSay(`${ranked.filter((s) => s.pct <= 0).length} of ${ranked.length} within top-10 reach` +
    (waiting.length ? `, ${waiting.length} waiting for times` : '') + (noBoard ? `, ${noBoard} with no public leaderboard` : '') + (longN ? `, ${longN} longer than ${$('hunt-maxkm').value} km left out` : '') +
    (hiddenN ? `, ${hiddenN} hidden` : '') + '.');
  for (const s of ranked.slice(0, 40)) {
    const li = document.createElement('li');
    const cls = huntClass(s);
    const head = s.pred.head;
    li.innerHTML = `<input type="checkbox" ${huntPicked.has(s.id) ? 'checked' : ''} title="Include in the route">` +
      `<span class="hunt-dot" style="background:${HUNT_COLOURS[cls]}"></span>` +
      `<span><b>${escapeHtml(s.name || 'Segment ' + s.id)}</b><br><small>${fmtKm(s.distance || 0)} km · ${(s.grade ?? 0).toFixed(1)}% · ` +
      `you ${fmtSecs(s.pred.secs)} at ${Math.round(s.pred.watts)} W vs ${s.target_rank === 10 ? '10th' : s.target_rank === 9 ? '#9 (10th hidden)' : `#${s.target_rank} (${s.target_rank + 1}–10 hidden)`} ${fmtSecs(s.target)} · ` +
      `${Math.abs(head) < 2 ? 'little wind' : `${head < 0 ? 'tailwind' : 'headwind'} ${Math.abs(head).toFixed(0)} km/h`}</small></span>` +
      `<span class="off">${s.pct <= 0 ? '−' : '+'}${Math.abs(s.pct).toFixed(1)}%</span>`;
    li.querySelector('input').onclick = (ev) => { ev.stopPropagation(); huntTogglePick(s.id, ev.target.checked); };
    li.onclick = () => huntShow(s);
    ul.appendChild(li);
  }
  $('hunt-route').disabled = !huntPicked.size;
  $('hunt-route').textContent = huntPicked.size ? `Route through ${huntPicked.size} ticked segment${huntPicked.size > 1 ? 's' : ''}` : 'Tick segments to route through them';
}

function huntTogglePick(id, on) {
  if (on) huntPicked.add(id); else huntPicked.delete(id);
  store.set('cp.hunt.picked', [...huntPicked]);
  huntRender();
}

function huntShow(s) {
  const xs = s.coords.map((p) => p[0]), ys = s.coords.map((p) => p[1]);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 60, maxZoom: 16 });
  huntPopup(s, [s.coords[0][0], s.coords[0][1]]);
}

function huntPopup(s, at) {
  const top = (s.top || []).filter((t) => t[0] <= 10).map((t) => `${t[0]}. ${fmtSecs(t[1])}${t[2] ? ` (${t[2]} W)` : ''}`).join('<br>');
  const p = new maplibregl.Popup({ offset: 8, maxWidth: '260px' }).setLngLat(at).setHTML(
    `<b>${escapeHtml(s.name || 'Segment')}</b><br><small>${fmtKm(s.distance || 0)} km, ${(s.grade ?? 0).toFixed(1)}%. Starts at the dot.</small>` +
    (s.pred ? `<br>You: <b>${fmtSecs(s.pred.secs)}</b> at ${Math.round(s.pred.watts)} W` : '') +
    (top ? `<br><small>Top 10 (hidden athletes left out):<br>${top}</small>` : '<br><small>Top-10 times not fetched yet.</small>') +
    `<br><label class="check"><input type="checkbox" class="pick" ${huntPicked.has(s.id) ? 'checked' : ''}> Include in route</label>` +
    `<br><a href="https://www.strava.com/segments/${s.id}" target="_blank" rel="noopener">Strava</a> · ` +
    `<a href="https://veloviewer.com/segments/${s.id}" target="_blank" rel="noopener">VeloViewer</a> · <button class="linkbtn hide">Hide</button>`).addTo(map);
  const el = p.getElement();
  el.querySelector('.pick').onchange = (ev) => huntTogglePick(s.id, ev.target.checked);
  el.querySelector('.hide').onclick = async () => {
    p.remove(); s.hidden = true; huntTogglePick(s.id, false);
    try { await fetch('/api/strava/hide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id }) }); } catch { /* shown again next load */ }
  };
}

// ---------- routing through the ticked segments ----------
function pointsAlong(coords, every) {
  const out = [coords[0]];
  let since = 0;
  for (let i = 1; i < coords.length; i++) {
    since += haversine(coords[i - 1], coords[i]);
    if (since >= every && i < coords.length - 1) { out.push(coords[i]); since = 0; }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

function permutations(a) {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
}

function huntRoute() {
  const segs = huntSegs.filter((s) => huntPicked.has(s.id) && s.coords);
  const missing = huntPicked.size - segs.length;
  const startPt = waypoints[0] || home;
  if (!startPt) { showMsg('Put your start point down (or set Home) first, then route through the segments.'); return; }
  if (!segs.length) { showMsg('The ticked segments are outside this map view: zoom out so they show, then try again.'); return; }
  const S = [startPt.lng, startPt.lat];
  // Best order: shortest straight-line hops between segments (every order tried for up to 7, else nearest next).
  let order;
  const cost = (o) => { let at = S, d = 0; for (const s of o) { d += haversine(at, s.coords[0]) + (s.distance || 0); at = s.coords[s.coords.length - 1]; } return d + haversine(at, S); };
  if (segs.length <= 7) order = permutations(segs).reduce((b, o) => (cost(o) < cost(b) ? o : b));
  else {
    order = []; let left = [...segs], at = S;
    while (left.length) { left.sort((a, b) => haversine(at, a.coords[0]) - haversine(at, b.coords[0])); const n = left.shift(); order.push(n); at = n.coords[n.coords.length - 1]; }
  }
  const pts = [{ lng: S[0], lat: S[1] }];
  for (const s of order) for (const p of pointsAlong(s.coords, HUNT_VIA_EVERY)) pts.push({ lng: p[0], lat: p[1] });
  pts.push({ lng: S[0], lat: S[1] });
  setWaypoints(pts, { fit: true });
  huntRouteMsg = (`Routed through ${order.length} segment${order.length > 1 ? 's' : ''} in the right direction` +
    (missing ? ` (${missing} ticked one${missing > 1 ? 's are' : ' is'} outside the map view and left out)` : '') +
    '. Points along each segment keep the route on it.');
}
let huntRouteMsg = null; // shown once the route arrives (routing clears the message line)
routeHooks.push(() => { if (huntRouteMsg) { showMsg(huntRouteMsg); huntRouteMsg = null; } });

// ---------- controls ----------
map.on('load', () => {
  map.addSource('hunt', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'hunt-line', type: 'line', source: 'hunt', filter: ['!=', ['get', 'start'], 1],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'picked'], 1], 7, 4], 'line-opacity': 0.85 } }, 'route-casing');
  map.addLayer({ id: 'hunt-start', type: 'circle', source: 'hunt', filter: ['==', ['get', 'start'], 1],
    paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  clickHandlers.unshift((e) => {
    if (!huntOpen()) return false;
    const f = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ['hunt-line', 'hunt-start'] })[0];
    if (!f) return false;
    const s = huntSegs.find((x) => x.id === f.properties.id);
    if (s) huntPopup(s, e.lngLat);
    return true;
  });
  map.on('mouseenter', 'hunt-line', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'hunt-line', () => { map.getCanvas().style.cursor = ''; });
  map.on('moveend', debounce(() => { if (huntOpen()) huntLoadSegs(); }, 700));

  const q = new URLSearchParams(location.search).get('strava');
  if (q) {
    showMsg({ connected: 'Strava connected. Open Segment hunter and press "Find segments in this view".',
      denied: 'Strava connection cancelled.', failed: 'Strava connection failed: check STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.' }[q] || '');
    history.replaceState(null, '', location.pathname + location.hash);
  }
});

document.querySelector('details[data-key="hunt"]').addEventListener('toggle', async (ev) => {
  if (!ev.target.open) { huntRender(); return; }
  huntLoadStatus();
  if (!huntCurve) { try { const r = await fetch('/api/athlete/curve'); if (r.ok) huntCurve = await r.json(); } catch { /* model from FTP */ } }
  await huntEnsureWind();
  huntLoadSegs();
});

$('hunt-connect').onclick = async () => {
  try {
    const r = await fetch(`/api/strava/connect?redirect=${encodeURIComponent(location.origin + '/api/strava/callback')}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    location.href = j.url;
  } catch (e) { huntSay(`Can't connect: ${e.message}`); }
};
$('hunt-disconnect').onclick = async () => { await fetch('/api/strava/disconnect', { method: 'POST', body: '{}' }); huntLoadStatus(); };
$('hunt-scan').onclick = async () => {
  try {
    const r = await fetch('/api/strava/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bbox: huntBbox() }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    if (!j.started) huntSay('A search is already running.');
  } catch (e) { huntSay(`Can't search: ${e.message}`); }
  huntLoadStatus();
};
$('hunt-add').onclick = async () => {
  const v = $('hunt-add-id').value.trim();
  if (!v) return;
  $('hunt-add').disabled = true;
  huntSay('Looking it up on Strava and VeloViewer…');
  try {
    const r = await fetch('/api/strava/segments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: v }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    $('hunt-add-id').value = '';
    huntSegs = huntSegs.filter((x) => x.id !== j.id).concat([j]);
    huntRecompute();
    huntShow(j);
  } catch (e) { huntSay(`Couldn't add it: ${e.message}`); }
  $('hunt-add').disabled = false;
};
$('hunt-route').onclick = huntRoute;
$('hunt-effort').value = store.get('cp.hunt.effort', 100);
$('hunt-maxkm').value = store.get('cp.hunt.maxkm', 5);
$('hunt-effort').addEventListener('input', () => { store.set('cp.hunt.effort', +$('hunt-effort').value); huntRecompute(); });
$('hunt-maxkm').addEventListener('input', () => { store.set('cp.hunt.maxkm', +$('hunt-maxkm').value); huntRecompute(); });
$('wind-time').addEventListener('change', async () => { if (!huntOpen()) return; await huntEnsureWind(); setTimeout(huntRecompute, 800); });
