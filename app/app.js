'use strict';
/* Cycle Planner: MapLibre frontend for a self-hosted BRouter. */

// ---------- config ----------
const BROUTER_URL = '/brouter';
const BASE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const START_VIEW = { center: [115.8605, -31.9505], zoom: 11 }; // Perth
const POI_MIN_ZOOM = 13;
const CELL = 0.05; // degrees, POI cache grid

const SURFACE = {
  sealed:   { label: 'Sealed', color: '#3366cc' },
  likely:   { label: 'Probably sealed (no surface tag)', color: '#8fb0ea' },
  unsealed: { label: 'Unsealed', color: '#c47a2c' },
  unknown:  { label: 'Unknown', color: '#9ca3af' },
};
const WAY = {
  bikepath: { label: 'Bike path', color: '#1a9850' },
  shared:   { label: 'Footpath / shared path', color: '#91cf60' },
  lane:     { label: 'Road with bike lane', color: '#4575b4' },
  minor:    { label: 'Minor road', color: '#f4a340' },
  main:     { label: 'Main road', color: '#d73027' },
  track:    { label: 'Track', color: '#8c510a' },
  other:    { label: 'Other', color: '#9ca3af' },
};
const ROUTE_COLOR = '#d6336c';

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
function haversine(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function parseTags(str) {
  const t = {};
  for (const kv of (str || '').split(' ')) {
    const i = kv.indexOf('=');
    if (i > 0) t[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return t;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtKm(m) { return (m / 1000).toFixed(m < 10000 ? 2 : 1); }
function fmtDuration(h) {
  const mins = Math.round(h * 60);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

const SEALED = new Set(['asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett', 'chipseal', 'metal', 'wood', 'bricks']);
const UNSEALED = new Set(['unpaved', 'gravel', 'fine_gravel', 'compacted', 'dirt', 'earth', 'ground', 'grass', 'sand', 'mud', 'pebblestone', 'rock', 'woodchips', 'grass_paver']);
const ROADS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'road']);

function surfaceClass(t) {
  if (t.surface) {
    if (SEALED.has(t.surface)) return 'sealed';
    if (UNSEALED.has(t.surface)) return 'unsealed';
    return 'unknown';
  }
  if (ROADS.has(t.highway) || t.highway === 'cycleway') return 'likely';
  return 'unknown';
}
function wayClass(t) {
  const h = t.highway || '';
  if (h === 'cycleway' || ((h === 'path' || h === 'footway') && t.bicycle === 'designated')) return 'bikepath';
  if (['path', 'footway', 'pedestrian', 'bridleway', 'steps'].includes(h)) return 'shared';
  if (h === 'track') return 'track';
  if (!ROADS.has(h)) return 'other';
  const lane = ['cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both']
    .some((k) => ['lane', 'track', 'shared_lane', 'opposite_lane', 'opposite_track'].includes(t[k]));
  if (lane) return 'lane';
  if (/^(trunk|primary|secondary|motorway)/.test(h)) return 'main';
  return 'minor';
}

// ---------- state ----------
let waypoints = [];        // [{lng, lat}]
let markers = [];
let undoStack = [];
let route = null;          // {coords, cum, length, ascend, segs:[{i0,i1,tags}]}
let routeAbort = null;
let routeSeq = 0;
const pois = new Map();    // id -> {id, lng, lat, kind, hasWater, tags}
const fetchedCells = new Set();
let stopsOnRoute = [];     // [{poi, km, off}]

const map = new maplibregl.Map({
  container: 'map', style: BASE_STYLE, ...START_VIEW, attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const hoverMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'hover-dot' }) });

map.on('load', () => {
  // CyclOSM raster underneath the route, hidden by default.
  map.addSource('cyclosm', {
    type: 'raster', tileSize: 256, maxzoom: 19,
    tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`),
    attribution: '<a href="https://www.cyclosm.org">CyclOSM</a> | © OpenStreetMap contributors',
  });
  map.addLayer({ id: 'cyclosm', type: 'raster', source: 'cyclosm', layout: { visibility: 'none' } });

  map.addSource('route', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 16, 11] } });
  map.addLayer({ id: 'route', type: 'line', source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['coalesce', ['get', 'color'], ROUTE_COLOR], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 16, 7] } });
  // Wider invisible line so the route is easy to tap on a phone.
  map.addLayer({ id: 'route-hit', type: 'line', source: 'route', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 22 } });

  map.addSource('pois', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'pois', type: 'circle', source: 'pois', minzoom: 11,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3.5, 16, 7],
      'circle-color': ['match', ['get', 'kind'], 'water', '#1c7ed6', '#7048e8'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
    } });

  map.on('click', onMapClick);
  map.on('mouseenter', 'route-hit', () => { map.getCanvas().style.cursor = 'copy'; });
  map.on('mouseleave', 'route-hit', () => { map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', 'pois', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'pois', () => { map.getCanvas().style.cursor = ''; });
  map.on('moveend', debounce(loadViewportPois, 600));

  restoreSettings();
  const fromHash = readHash();
  if (fromHash) { setWaypoints(fromHash, { fit: true, record: false }); }
  loadViewportPois();
});

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

// ---------- map interaction ----------
function onMapClick(e) {
  const hits = map.queryRenderedFeatures(e.point, { layers: ['pois', 'route-hit'] });
  const poiHit = hits.find((f) => f.layer.id === 'pois');
  if (poiHit) { showPoiPopup(pois.get(poiHit.properties.id)); return; }
  const lngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
  if (hits.some((f) => f.layer.id === 'route-hit') && route && waypoints.length >= 2) {
    insertVia(lngLat);
  } else {
    setWaypoints([...waypoints, lngLat]);
  }
}

function insertVia(p) {
  // Find where on the route the tap was, then which leg that falls in.
  const ic = nearestIndex(route.coords, [p.lng, p.lat], 0);
  const wpIdx = [];
  let from = 0;
  for (const w of waypoints) { from = nearestIndex(route.coords, [w.lng, w.lat], from); wpIdx.push(from); }
  let leg = 0;
  for (let i = 0; i < wpIdx.length - 1; i++) if (wpIdx[i] <= ic) leg = i;
  const next = [...waypoints];
  next.splice(leg + 1, 0, p);
  setWaypoints(next);
}

function nearestIndex(coords, pt, from) {
  let best = from, bestD = Infinity;
  for (let i = from; i < coords.length; i++) {
    const d = (coords[i][0] - pt[0]) ** 2 + (coords[i][1] - pt[1]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function setWaypoints(next, { fit = false, record = true } = {}) {
  if (record) undoStack.push(waypoints.map((w) => ({ ...w })));
  if (undoStack.length > 100) undoStack.shift();
  waypoints = next.map((w) => ({ lng: +w.lng, lat: +w.lat }));
  renderMarkers();
  writeHash();
  requestRoute(fit);
}

function renderMarkers() {
  markers.forEach((m) => m.remove());
  markers = waypoints.map((w, i) => {
    const el = document.createElement('div');
    const last = i === waypoints.length - 1 && i > 0;
    el.className = 'wp ' + (i === 0 ? 'start' : last ? 'end' : 'via');
    el.textContent = i === 0 ? 'S' : last ? 'F' : '';
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const popup = new maplibregl.Popup({ offset: 14 })
        .setLngLat(w)
        .setHTML(`<b>${i === 0 ? 'Start' : last ? 'Finish' : 'Via point'}</b><button>Remove point</button>`)
        .addTo(map);
      popup.getElement().querySelector('button').onclick = () => {
        popup.remove();
        setWaypoints(waypoints.filter((_, j) => j !== i));
      };
    });
    const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(w).addTo(map);
    m.on('dragend', () => {
      const ll = m.getLngLat();
      const next = waypoints.map((x) => ({ ...x }));
      next[i] = { lng: ll.lng, lat: ll.lat };
      setWaypoints(next);
    });
    return m;
  });
}

// ---------- routing ----------
function showMsg(text) { const m = $('msg'); m.textContent = text || ''; m.hidden = !text; }

async function requestRoute(fit) {
  if (routeAbort) routeAbort.abort();
  if (waypoints.length < 2) { route = null; renderRoute(); return; }
  const seq = ++routeSeq;
  routeAbort = new AbortController();
  const lonlats = waypoints.map((w) => `${w.lng.toFixed(6)},${w.lat.toFixed(6)}`).join('|');
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${encodeURIComponent($('profile').value)}&alternativeidx=0&format=geojson`;
  showMsg('Routing…');
  try {
    const res = await fetch(url, { signal: routeAbort.signal });
    const text = await res.text();
    if (seq !== routeSeq) return;
    if ([502, 503, 504].includes(res.status)) throw new Error('the router is still starting up (first start downloads the map data). Try again in a minute.');
    if (!res.ok || !text.trim().startsWith('{')) throw new Error(text.trim().slice(0, 200) || `HTTP ${res.status}`);
    route = parseBRouter(JSON.parse(text));
    showMsg('');
    renderRoute();
    if (fit) fitRoute();
  } catch (err) {
    if (err.name === 'AbortError') return;
    showMsg('Routing failed: ' + err.message);
  }
}

function parseBRouter(gj) {
  const f = gj.features[0];
  const p = f.properties;
  const coords = f.geometry.coordinates;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));

  // messages: header row then one row per change of way tags; Longitude/Latitude are micro-degrees
  // and mark the END of each stretch.
  const segs = [];
  const msgs = p.messages || [];
  if (msgs.length > 1) {
    const h = msgs[0];
    const iLon = h.indexOf('Longitude'), iLat = h.indexOf('Latitude'), iTags = h.indexOf('WayTags');
    let j = 0;
    for (let r = 1; r < msgs.length; r++) {
      const lon = +msgs[r][iLon] / 1e6, lat = +msgs[r][iLat] / 1e6;
      let k = -1;
      for (let i = j; i < coords.length; i++) {
        if (Math.abs(coords[i][0] - lon) < 3e-6 && Math.abs(coords[i][1] - lat) < 3e-6) { k = i; break; }
      }
      if (k < 0) k = nearestIndex(coords, [lon, lat], j);
      if (r === msgs.length - 1) k = coords.length - 1;
      if (k > j) segs.push({ i0: j, i1: k, tags: parseTags(msgs[r][iTags]) });
      j = k;
    }
  }
  if (!segs.length) segs.push({ i0: 0, i1: coords.length - 1, tags: {} });
  return {
    coords, cum, segs,
    length: +p['track-length'] || cum[cum.length - 1],
    ascend: +p['filtered ascend'] || 0,
  };
}

function routeFeatures() {
  if (!route) return emptyFC();
  const mode = $('colour-by').value;
  if (mode === 'none') {
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.coords } }] };
  }
  const table = mode === 'surface' ? SURFACE : WAY;
  const cls = mode === 'surface' ? surfaceClass : wayClass;
  return {
    type: 'FeatureCollection',
    features: route.segs.map((s) => ({
      type: 'Feature',
      properties: { color: table[cls(s.tags)].color },
      geometry: { type: 'LineString', coordinates: route.coords.slice(s.i0, s.i1 + 1) },
    })),
  };
}

function renderRoute() {
  if (map.getSource('route')) map.getSource('route').setData(routeFeatures());
  renderStats();
  drawElevation();
  renderBreakdown('bd-surface', SURFACE, surfaceClass);
  renderBreakdown('bd-way', WAY, wayClass);
  updateStops();
}

function fitRoute() {
  if (!route) return;
  const b = new maplibregl.LngLatBounds();
  route.coords.forEach((c) => b.extend([c[0], c[1]]));
  const mobile = window.innerWidth < 760;
  map.fitBounds(b, { padding: mobile ? { top: 40, bottom: 260, left: 30, right: 30 } : { top: 40, bottom: 40, left: 400, right: 60 }, maxZoom: 15 });
}

function renderStats() {
  if (!route) { $('s-dist').textContent = '–'; $('s-asc').textContent = '–'; $('s-time').textContent = '–'; return; }
  $('s-dist').textContent = fmtKm(route.length);
  $('s-asc').textContent = Math.round(route.ascend);
  const speed = Math.max(5, +$('speed').value || 27);
  $('s-time').textContent = fmtDuration(route.length / 1000 / speed);
}

function renderBreakdown(id, table, cls) {
  const el = $(id);
  if (!route) { el.innerHTML = ''; return; }
  const tot = {};
  for (const s of route.segs) {
    const c = cls(s.tags);
    tot[c] = (tot[c] || 0) + (route.cum[s.i1] - route.cum[s.i0]);
  }
  const all = Object.values(tot).reduce((a, b) => a + b, 0) || 1;
  const keys = Object.keys(table).filter((k) => tot[k] > 0);
  el.innerHTML =
    `<div class="bar">${keys.map((k) => `<span style="width:${(100 * tot[k] / all).toFixed(2)}%;background:${table[k].color}"></span>`).join('')}</div>` +
    `<ul>${keys.map((k) => `<li><i style="background:${table[k].color}"></i>${table[k].label}<span class="v">${fmtKm(tot[k])} km · ${Math.round(100 * tot[k] / all)}%</span></li>`).join('')}</ul>`;
}

// ---------- elevation profile ----------
const elev = $('elev');
function drawElevation(hoverIdx) {
  const dpr = window.devicePixelRatio || 1;
  const w = elev.clientWidth, h = elev.clientHeight;
  if (!w) return;
  elev.width = w * dpr; elev.height = h * dpr;
  const ctx = elev.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!route || route.coords[0].length < 3) {
    ctx.fillStyle = '#9ca3af'; ctx.font = '12px system-ui';
    ctx.fillText(route ? 'No elevation data' : 'Add two points to see a profile', 8, 20);
    return;
  }
  const pad = { l: 34, r: 6, t: 8, b: 16 };
  const els = route.coords.map((c) => c[2]);
  let lo = Math.min(...els), hi = Math.max(...els);
  if (hi - lo < 40) { const mid = (hi + lo) / 2; lo = mid - 20; hi = mid + 20; }
  lo = Math.floor(lo / 10) * 10; hi = Math.ceil(hi / 10) * 10;
  const L = route.cum[route.cum.length - 1] || 1;
  const X = (d) => pad.l + (d / L) * (w - pad.l - pad.r);
  const Y = (e) => pad.t + (1 - (e - lo) / (hi - lo)) * (h - pad.t - pad.b);

  ctx.fillStyle = '#6b7280'; ctx.font = '10px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText(`${hi} m`, pad.l - 4, pad.t + 8);
  ctx.fillText(`${lo} m`, pad.l - 4, h - pad.b);
  ctx.textAlign = 'left';
  ctx.fillText('0', pad.l, h - 3);
  ctx.textAlign = 'right';
  ctx.fillText(`${fmtKm(L)} km`, w - pad.r, h - 3);

  ctx.beginPath();
  ctx.moveTo(X(0), Y(lo));
  route.coords.forEach((c, i) => ctx.lineTo(X(route.cum[i]), Y(c[2])));
  ctx.lineTo(X(L), Y(lo));
  ctx.closePath();
  ctx.fillStyle = 'rgba(214,51,108,.15)'; ctx.fill();
  ctx.beginPath();
  route.coords.forEach((c, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(route.cum[i]), Y(c[2])));
  ctx.strokeStyle = ROUTE_COLOR; ctx.lineWidth = 1.5; ctx.stroke();

  // toilet / water ticks along the bottom
  for (const s of stopsOnRoute) {
    ctx.fillStyle = s.poi.kind === 'water' ? '#1c7ed6' : '#7048e8';
    ctx.fillRect(X(s.km * 1000) - 1, h - pad.b - 5, 2, 5);
  }

  if (hoverIdx != null) {
    const x = X(route.cum[hoverIdx]);
    ctx.strokeStyle = '#1d2125'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
  }
  elev._X = { pad, w, L };
}

function elevHover(clientX) {
  if (!route || !elev._X) return;
  const { pad, w, L } = elev._X;
  const rect = elev.getBoundingClientRect();
  const d = Math.min(L, Math.max(0, ((clientX - rect.left - pad.l) / (w - pad.l - pad.r)) * L));
  let lo = 0, hi = route.cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (route.cum[mid] < d) lo = mid + 1; else hi = mid; }
  const c = route.coords[lo];
  hoverMarker.setLngLat([c[0], c[1]]).addTo(map);
  drawElevation(lo);
  const tip = $('elev-tip');
  tip.hidden = false;
  tip.style.left = `${Math.min(w - 50, Math.max(50, clientX - rect.left))}px`;
  tip.textContent = `${fmtKm(route.cum[lo])} km · ${Math.round(c[2] ?? 0)} m`;
}
function elevLeave() { hoverMarker.remove(); $('elev-tip').hidden = true; drawElevation(); }
elev.addEventListener('mousemove', (e) => elevHover(e.clientX));
elev.addEventListener('mouseleave', elevLeave);
elev.addEventListener('touchstart', (e) => elevHover(e.touches[0].clientX), { passive: true });
elev.addEventListener('touchmove', (e) => elevHover(e.touches[0].clientX), { passive: true });
elev.addEventListener('touchend', elevLeave);
window.addEventListener('resize', debounce(() => drawElevation(), 200));

// ---------- toilets & water (OpenStreetMap via Overpass) ----------
function overpassQuery(s, w, n, e) {
  const b = `${s},${w},${n},${e}`;
  // Everything inside a shopping centre is dropped: nowhere to leave the bike.
  return `[out:json][timeout:25];
(
  nwr["amenity"="toilets"](${b});
  nwr["amenity"="drinking_water"](${b});
  node["man_made"="water_tap"]["drinking_water"="yes"](${b});
)->.all;
(way["shop"="mall"](${b});relation["shop"="mall"](${b}););
map_to_area->.malls;
nwr.all(area.malls)->.inmall;
(.all; - .inmall;);
out center tags;`;
}

function usablePoi(t) {
  if (['yes', 'room', 'area', 'corridor'].includes(t.indoor)) return false;
  if (['indoor', 'underground'].includes(t.location)) return false;
  if (['private', 'no', 'customers', 'permit'].includes(t.access)) return false;
  if (t.disused === 'yes' || t['disused:amenity']) return false;
  return true;
}

async function overpass(q) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

let poiBusy = Promise.resolve();
function ensurePois(s, w, n, e) {
  // Snap to a grid and only fetch cells we haven't seen. Requests run one at a time.
  poiBusy = poiBusy.then(async () => {
    const c0 = Math.floor(w / CELL), c1 = Math.floor(e / CELL), r0 = Math.floor(s / CELL), r1 = Math.floor(n / CELL);
    let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) {
      if (!fetchedCells.has(`${c}:${r}`)) { minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
    }
    if (minC === Infinity) return;
    const data = await overpass(overpassQuery(minR * CELL, minC * CELL, (maxR + 1) * CELL, (maxC + 1) * CELL));
    for (let c = minC; c <= maxC; c++) for (let r = minR; r <= maxR; r++) fetchedCells.add(`${c}:${r}`);
    for (const el of data.elements || []) {
      const t = el.tags || {};
      const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
      if (lat == null || !usablePoi(t)) continue;
      const id = `${el.type}/${el.id}`;
      const kind = t.amenity === 'toilets' ? 'toilet' : 'water';
      pois.set(id, { id, lng, lat, kind, hasWater: kind === 'water' || t.drinking_water === 'yes', tags: t });
    }
    if (map.getSource('pois')) {
      map.getSource('pois').setData({
        type: 'FeatureCollection',
        features: [...pois.values()].map((p) => ({ type: 'Feature', properties: { id: p.id, kind: p.kind }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })),
      });
    }
  }).catch((e) => { console.warn('POI fetch failed', e); });
  return poiBusy;
}

function loadViewportPois() {
  if (!$('lyr-poi').checked || map.getZoom() < POI_MIN_ZOOM) return;
  const b = map.getBounds();
  ensurePois(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
}

function poiTitle(p) {
  const t = p.tags;
  const what = p.kind === 'toilet' ? (p.hasWater ? 'Toilet + water' : 'Toilet') : 'Drinking water';
  return t.name ? `${what}: ${t.name}` : what;
}

function showPoiPopup(p) {
  if (!p) return;
  const t = p.tags;
  const lines = [];
  if (t.opening_hours) lines.push(`Hours: ${escapeHtml(t.opening_hours)}`);
  if (t.fee) lines.push(`Fee: ${escapeHtml(t.fee)}`);
  if (t.description) lines.push(escapeHtml(t.description));
  const popup = new maplibregl.Popup({ offset: 8 })
    .setLngLat([p.lng, p.lat])
    .setHTML(`<b>${escapeHtml(poiTitle(p))}</b>${lines.join('<br>')}<br><button>Route via here</button>
      <div class="small"><a href="https://www.openstreetmap.org/${p.id}" target="_blank" rel="noopener">OSM ${escapeHtml(p.id)}</a></div>`)
    .addTo(map);
  popup.getElement().querySelector('button').onclick = () => {
    popup.remove();
    const pt = { lng: p.lng, lat: p.lat };
    if (route && waypoints.length >= 2) insertVia(pt); else setWaypoints([...waypoints, pt]);
  };
}

async function updateStops() {
  stopsOnRoute = [];
  renderStops();
  if (!route || !$('lyr-poi').checked) return;
  const seq = routeSeq;
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const c of route.coords) { s = Math.min(s, c[1]); n = Math.max(n, c[1]); w = Math.min(w, c[0]); e = Math.max(e, c[0]); }
  const pad = 0.01;
  $('gaps').innerHTML = '<div class="small">Looking up toilets and water…</div>';
  await ensurePois(s - pad, w - pad, n + pad, e + pad);
  if (seq !== routeSeq || !route) return;
  stopsOnRoute = stopsAlong(route, [...pois.values()], +$('poi-radius').value || 250);
  renderStops();
  drawElevation();
}

// All passes of each POI within `radius` metres of the route (an out-and-back sees a tap twice).
function stopsAlong(rt, list, radius) {
  const lat0 = rt.coords[0][1] * Math.PI / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110574;
  const xy = rt.coords.map((c) => [c[0] * kx, c[1] * ky]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of xy) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const out = [];
  for (const p of list) {
    const px = p.lng * kx, py = p.lat * ky;
    if (px < minX - radius || px > maxX + radius || py < minY - radius || py > maxY + radius) continue;
    let run = null;
    const flush = () => { if (run) out.push({ poi: p, km: run.ch / 1000, off: run.d }); run = null; };
    for (let i = 0; i < xy.length - 1; i++) {
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const u = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(ax + u * dx - px, ay + u * dy - py);
      if (d <= radius) {
        const ch = rt.cum[i] + u * (rt.cum[i + 1] - rt.cum[i]);
        if (!run || d < run.d) run = { d, ch };
      } else if (run && rt.cum[i] - run.ch > radius * 3) {
        flush();
      }
    }
    flush();
  }
  return out.sort((a, b) => a.km - b.km);
}

function gapsFor(kmList, totalKm, limit) {
  const pts = [0, ...kmList, totalKm];
  const gaps = [];
  for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] > limit) gaps.push([pts[i - 1], pts[i]]);
  return gaps;
}

function renderStops() {
  const ul = $('stops'), gapsEl = $('gaps');
  ul.innerHTML = '';
  gapsEl.innerHTML = '';
  if (!route) return;
  if (!$('lyr-poi').checked) { gapsEl.innerHTML = '<div class="small">Turn on “Toilets &amp; water” under Map.</div>'; return; }
  const total = route.length / 1000;
  const limit = +$('gap-km').value || 25;
  const water = gapsFor(stopsOnRoute.filter((s) => s.poi.hasWater).map((s) => s.km), total, limit);
  const loo = gapsFor(stopsOnRoute.filter((s) => s.poi.kind === 'toilet').map((s) => s.km), total, limit);
  const fmt = (g) => `km ${g[0].toFixed(1)}–${g[1].toFixed(1)} (${(g[1] - g[0]).toFixed(0)} km)`;
  gapsEl.innerHTML =
    water.map((g) => `<div class="gap">No drinking water ${fmt(g)}</div>`).join('') +
    loo.map((g) => `<div class="gap">No toilet ${fmt(g)}</div>`).join('');
  if (!stopsOnRoute.length) { ul.innerHTML = '<li class="small">None found near the route.</li>'; return; }
  for (const s of stopsOnRoute) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="km">${s.km.toFixed(1)}</span><i class="dot ${s.poi.kind}"></i>` +
      `<span>${escapeHtml(poiTitle(s.poi))}</span><span class="off">${Math.round(s.off)} m off</span>`;
    li.onclick = () => { map.flyTo({ center: [s.poi.lng, s.poi.lat], zoom: Math.max(map.getZoom(), 15) }); showPoiPopup(s.poi); };
    ul.appendChild(li);
  }
}

// ---------- search (Nominatim) ----------
const doSearch = debounce(async (q) => {
  const ul = $('results');
  if (q.length < 3) { ul.hidden = true; return; }
  const c = map.getCenter();
  const params = new URLSearchParams({
    q, format: 'jsonv2', limit: '6', countrycodes: 'au',
    viewbox: `${c.lng - 0.6},${c.lat + 0.6},${c.lng + 0.6},${c.lat - 0.6}`,
  });
  try {
    const res = await fetch(`${NOMINATIM}?${params}`);
    const items = await res.json();
    ul.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      li.textContent = it.display_name;
      li.onclick = () => {
        ul.hidden = true; $('search').value = '';
        const p = { lng: +it.lon, lat: +it.lat };
        setWaypoints([...waypoints, p]);
        map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 14) });
      };
      ul.appendChild(li);
    }
    ul.hidden = !items.length;
  } catch { ul.hidden = true; }
}, 400);
$('search').addEventListener('input', (e) => doSearch(e.target.value.trim()));
$('search').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('results').hidden = true; });

// ---------- GPX, sharing, saving ----------
function routeName() {
  return $('route-name').value.trim() || `Ride ${new Date().toISOString().slice(0, 10)} ${route ? fmtKm(route.length) + 'km' : ''}`.trim();
}
function buildGpx() {
  const name = escapeHtml(routeName());
  const wpts = $('gpx-wpt').checked
    ? stopsOnRoute.map((s) => `  <wpt lat="${s.poi.lat.toFixed(6)}" lon="${s.poi.lng.toFixed(6)}"><name>${escapeHtml(poiTitle(s.poi))}</name><sym>${s.poi.kind === 'toilet' ? 'Restroom' : 'Drinking Water'}</sym></wpt>`).join('\n')
    : '';
  const pts = route.coords.map((c) => `      <trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">${c[2] != null ? `<ele>${(+c[2]).toFixed(1)}</ele>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Cycle Planner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name></metadata>
${wpts}
  <trk>
    <name>${name}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
$('gpx').onclick = () => {
  if (!route) { showMsg('Plan a route first.'); return; }
  const blob = new Blob([buildGpx()], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = routeName().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_') + '.gpx';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

function writeHash() {
  const w = waypoints.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
  const h = w ? `#p=${encodeURIComponent($('profile').value)}&w=${w}` : '';
  window.history.replaceState(null, '', location.pathname + location.search + h);
}
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const prof = params.get('p');
  if (prof && [...$('profile').options].some((o) => o.value === prof)) $('profile').value = prof;
  const w = params.get('w');
  if (!w) return null;
  const pts = w.split(';').map((s) => s.split(',').map(Number)).filter((a) => a.length === 2 && a.every(Number.isFinite));
  return pts.length ? pts.map(([lng, lat]) => ({ lng, lat })) : null;
}
$('share').onclick = async () => {
  const url = location.href;
  try { await navigator.clipboard.writeText(url); showMsg('Link copied.'); }
  catch { showMsg(url); }
  setTimeout(() => showMsg(''), 4000);
};

function renderSaved() {
  const list = store.get('cp.routes', []);
  const ul = $('saved');
  ul.innerHTML = '';
  list.forEach((r, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(r.name)} <small class="small">${r.km ?? ''} km</small></span><button title="Delete">✕</button>`;
    li.querySelector('span').onclick = () => {
      $('profile').value = r.profile || 'fastbike';
      $('route-name').value = r.name;
      setWaypoints(r.wp, { fit: true });
    };
    li.querySelector('button').onclick = () => {
      const l = store.get('cp.routes', []); l.splice(i, 1); store.set('cp.routes', l); renderSaved();
    };
    ul.appendChild(li);
  });
}
$('save').onclick = () => {
  if (waypoints.length < 2) { showMsg('Plan a route first.'); return; }
  const list = store.get('cp.routes', []);
  const name = routeName();
  const entry = { name, wp: waypoints, profile: $('profile').value, km: route ? fmtKm(route.length) : null, saved: Date.now() };
  const i = list.findIndex((r) => r.name === name);
  if (i >= 0) list[i] = entry; else list.unshift(entry);
  store.set('cp.routes', list);
  renderSaved();
  showMsg(`Saved “${name}” in this browser.`);
  setTimeout(() => showMsg(''), 3000);
};

// ---------- controls ----------
$('undo').onclick = () => { if (undoStack.length) setWaypoints(undoStack.pop(), { record: false }); };
$('reverse').onclick = () => { if (waypoints.length > 1) setWaypoints([...waypoints].reverse()); };
$('loop').onclick = () => { if (waypoints.length > 1) setWaypoints([...waypoints, { ...waypoints[0] }]); };
$('clear').onclick = () => { if (waypoints.length) setWaypoints([]); };
$('profile').onchange = () => { store.set('cp.profile', $('profile').value); writeHash(); requestRoute(false); };
$('speed').oninput = () => { store.set('cp.speed', $('speed').value); renderStats(); };
$('colour-by').onchange = () => { store.set('cp.colour', $('colour-by').value); if (map.getSource('route')) map.getSource('route').setData(routeFeatures()); };
$('lyr-cyclosm').onchange = (e) => { store.set('cp.cyclosm', e.target.checked); map.setLayoutProperty('cyclosm', 'visibility', e.target.checked ? 'visible' : 'none'); };
$('lyr-poi').onchange = (e) => {
  store.set('cp.poi', e.target.checked);
  map.setLayoutProperty('pois', 'visibility', e.target.checked ? 'visible' : 'none');
  if (e.target.checked) loadViewportPois();
  updateStops();
};
$('poi-radius').onchange = updateStops;
$('gap-km').onchange = renderStops;
$('handle').onclick = () => { $('panel').classList.toggle('collapsed'); setTimeout(() => drawElevation(), 250); };

function restoreSettings() {
  // Collapsible panel sections remember whether they were open.
  document.querySelectorAll('details.sec').forEach((d) => {
    const saved = store.get('cp.sec.' + d.dataset.key, null);
    if (saved != null) d.open = saved;
    d.addEventListener('toggle', () => {
      store.set('cp.sec.' + d.dataset.key, d.open);
      if (d.open && d.dataset.key === 'elev') drawElevation();
    });
  });
  $('profile').value = store.get('cp.profile', 'fastbike');
  $('speed').value = store.get('cp.speed', 27);
  $('colour-by').value = store.get('cp.colour', 'none');
  const cyc = store.get('cp.cyclosm', false);
  $('lyr-cyclosm').checked = cyc;
  map.setLayoutProperty('cyclosm', 'visibility', cyc ? 'visible' : 'none');
  const poi = store.get('cp.poi', true);
  $('lyr-poi').checked = poi;
  map.setLayoutProperty('pois', 'visibility', poi ? 'visible' : 'none');
  renderSaved();
  drawElevation();
}
