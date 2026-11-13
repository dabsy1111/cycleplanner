'use strict';
/* Cycle Planner: MapLibre frontend for a self-hosted BRouter. */

// ---------- config ----------
const BROUTER_URL = '/brouter';
const BASE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
// Map tiles go through the server's cache (nginx /tiles/...), so the map still works if a tile service is down.
const LANDGATE = 'https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Locate/MapServer/export';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/';
function viaTileCache(url) {
  if (url.startsWith('https://tiles.openfreemap.org/')) return { url: `${location.origin}/tiles/ofm/${url.slice(30)}` };
  const m = /^https:\/\/[abc]\.tile-cyclosm\.openstreetmap\.fr\/cyclosm\/(.*)$/.exec(url);
  if (m) return { url: `${location.origin}/tiles/cyclosm/${m[1]}` };
  if (url.startsWith(LANDGATE)) return { url: `${location.origin}/tiles/landgate/${url.slice(LANDGATE.length)}` };
  if (url.startsWith(ESRI)) return { url: `${location.origin}/tiles/esri/${url.slice(ESRI.length)}` };
  return { url };
}
// Our server caches Overpass answers for a week; the public servers are the fallback.
const OVERPASS = ['/api/overpass', 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
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
  bikepath: { label: 'Bike or shared path (signed for bikes)', color: '#1a9850' },
  footpath: { label: 'Footpath (not signed for bikes)', color: '#f06595' },
  lane:     { label: 'Road with bike lane', color: '#4575b4' },
  minor:    { label: 'Minor road', color: '#f4a340' },
  main:     { label: 'Main road', color: '#d73027' },
  track:    { label: 'Track or trail', color: '#8c510a' },
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
  if (h === 'cycleway' || (['path', 'footway', 'pedestrian', 'bridleway'].includes(h) && t.bicycle === 'designated')) return 'bikepath';
  if (['footway', 'pedestrian', 'steps', 'corridor'].includes(h) || (h === 'path' && t.foot === 'designated')) return 'footpath';
  if (h === 'path' || h === 'bridleway') return 'track';
  if (h === 'track') return 'track';
  if (!ROADS.has(h)) return 'other';
  const lane = ['cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both']
    .some((k) => ['lane', 'track', 'shared_lane', 'opposite_lane', 'opposite_track'].includes(t[k]));
  if (lane) return 'lane';
  if (/^(trunk|primary|secondary|motorway)/.test(h)) return 'main';
  return 'minor';
}

// ---------- extension points (used by wind.js, efforts.js, loops.js, history.js) ----------
const routeHooks = [];   // called with the new route (or null) after every reroute
const colourers = {};    // 'colour route by' modes: fn(route) -> [{i0, i1, color}]
function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function destination(p, brg, metres) {
  const R = 6371008.8, r = Math.PI / 180, d = metres / R, t = brg * r;
  const lat1 = p[1] * r, lon1 = p[0] * r;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(t));
  const lon2 = lon1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [lon2 / r, lat2 / r];
}
// Split a route into pieces of roughly `step` metres (for per-piece colouring).
function routePieces(rt, step = 150) {
  const out = [];
  let i0 = 0;
  for (let i = 1; i < rt.coords.length; i++) {
    if (rt.cum[i] - rt.cum[i0] >= step || i === rt.coords.length - 1) { out.push({ i0, i1: i }); i0 = i; }
  }
  return out;
}

// ---------- state ----------
let waypoints = [];        // [{lng, lat}]
let markers = [];
let undoStack = [];
let altIndex = 0;          // which BRouter alternative (0 = best) for A-to-B routes
let route = null;          // {coords, cum, length, ascend, segs:[{i0,i1,tags}]}
let routeAbort = null;
let routeSeq = 0;
const pois = new Map();    // id -> {id, lng, lat, kind, hasWater, tags}
const fetchedCells = new Set();
let stopsOnRoute = [];     // [{poi, km, off}]

const map = new maplibregl.Map({
  container: 'map', style: BASE_STYLE, ...START_VIEW, attributionControl: { compact: true },
  transformRequest: viaTileCache,
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

  // Photo backgrounds. They sit under the street names so you can still read where you are.
  const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addSource('aerial', {
    // Landgate's free WA aerial mosaic: about 7.5–15 cm per pixel over Perth, at least ~a year old.
    // It isn't pre-tiled, so each tile is drawn on request (512 px for sharp phone screens) and cached by the server.
    type: 'raster', tileSize: 256, minzoom: 10, maxzoom: 21, bounds: [112.9, -35.2, 129.0, -13.6], // WA only
    tiles: [`${LANDGATE}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=jpg&f=image`],
    attribution: 'Aerial imagery © <a href="https://www.landgate.wa.gov.au">Landgate</a> / SLIP',
  });
  map.addLayer({ id: 'aerial', type: 'raster', source: 'aerial', layout: { visibility: 'none' } }, firstLabel);
  map.addSource('satellite', {
    type: 'raster', tileSize: 256, maxzoom: 19,
    tiles: [`${ESRI}{z}/{y}/{x}`],
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  });
  map.addLayer({ id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } }, firstLabel);
  // OSM's bike paths and footpaths drawn over the photo, so you can check them against what's really there.
  map.addLayer({ id: 'photo-paths', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
    filter: ['==', ['get', 'class'], 'path'],
    layout: { visibility: 'none', 'line-cap': 'round' },
    paint: {
      'line-color': ['match', ['get', 'subclass'], 'cycleway', '#22d3ee', '#fde047'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 14, ['match', ['get', 'subclass'], 'cycleway', 2, 1], 19, ['match', ['get', 'subclass'], 'cycleway', 5, 2.5]],
      'line-dasharray': [2, 1.5], 'line-opacity': ['match', ['get', 'subclass'], 'cycleway', 0.95, 0.6],
    } }, firstLabel);

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
      'circle-color': ['match', ['get', 'kind'], 'water', '#1c7ed6', 'cafe', '#8c5a2b', '#0b7285'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
    } });

  map.on('click', onMapClick);
  map.on('mousedown', 'route-hit', (e) => startLineDrag(e, e.originalEvent.clientX, e.originalEvent.clientY));
  map.on('touchstart', 'route-hit', (e) => {
    if (e.originalEvent.touches.length === 1) startLineDrag(e, e.originalEvent.touches[0].clientX, e.originalEvent.touches[0].clientY);
  });
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
const clickHandlers = []; // return true to consume a map click (e.g. placing a no-go area)
function onMapClick(e) {
  if (Date.now() < lineDragUntil) return;
  for (const h of clickHandlers) if (h(e)) return;
  const hits = map.queryRenderedFeatures(e.point, { layers: ['pois', 'route-hit'] });
  const poiHit = hits.find((f) => f.layer.id === 'pois');
  if (poiHit) { showPoiPopup(pois.get(poiHit.properties.id)); return; }
  const lngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
  const closedLoop = waypoints.length >= 3 && haversine([waypoints[0].lng, waypoints[0].lat], [waypoints[waypoints.length - 1].lng, waypoints[waypoints.length - 1].lat]) < 30;
  if ((hits.some((f) => f.layer.id === 'route-hit') || closedLoop) && route && waypoints.length >= 2) {
    insertVia(lngLat); // on a finished loop, never add a point past the finish
  } else {
    setWaypoints([...waypoints, lngLat]);
  }
}

// Insert a via point at `drop`, in the leg of the route nearest `at` (defaults to the same spot).
function insertVia(p, at = p) {
  const ic = nearestIndex(route.coords, [at.lng, at.lat], 0);
  const wpIdx = [];
  let from = 0;
  for (const w of waypoints) { from = nearestIndex(route.coords, [w.lng, w.lat], from); wpIdx.push(from); }
  let leg = 0;
  for (let i = 0; i < wpIdx.length - 1; i++) if (wpIdx[i] <= ic) leg = i;
  const next = [...waypoints];
  next.splice(leg + 1, 0, p);
  setWaypoints(next);
}

// Grab the route line and pull it: a via point is created where you let go.
let lineDragUntil = 0; // ignore the click that follows a drag
function startLineDrag(e, x0, y0) {
  if (!route || waypoints.length < 2 || clickHandlers.some((h) => h.busy && h.busy())) return;
  e.preventDefault();
  const grabbed = { lng: e.lngLat.lng, lat: e.lngLat.lat };
  const ghost = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'wp via ghost' }) });
  let moved = false;
  const rect = map.getCanvas().getBoundingClientRect();
  const move = (cx, cy) => {
    if (!moved && Math.hypot(cx - x0, cy - y0) < 6) return;
    if (!moved) { moved = true; ghost.setLngLat(grabbed).addTo(map); }
    ghost.setLngLat(map.unproject([cx - rect.left, cy - rect.top]));
  };
  const onMouse = (ev) => move(ev.clientX, ev.clientY);
  const onTouch = (ev) => { ev.preventDefault(); move(ev.touches[0].clientX, ev.touches[0].clientY); };
  const end = () => {
    window.removeEventListener('mousemove', onMouse);
    window.removeEventListener('touchmove', onTouch);
    window.removeEventListener('mouseup', end);
    window.removeEventListener('touchend', end);
    map.dragPan.enable();
    if (!moved) return; // a plain tap: the click handler inserts the point
    const drop = ghost.getLngLat();
    ghost.remove();
    lineDragUntil = Date.now() + 400;
    insertVia({ lng: drop.lng, lat: drop.lat }, grabbed);
  };
  map.dragPan.disable();
  window.addEventListener('mousemove', onMouse);
  window.addEventListener('touchmove', onTouch, { passive: false });
  window.addEventListener('mouseup', end);
  window.addEventListener('touchend', end);
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
  // `auto` marks points the loop generator placed: the router may move them to trim dead-end spikes.
  waypoints = next.map((w) => (w.auto ? { lng: +w.lng, lat: +w.lat, auto: true } : { lng: +w.lng, lat: +w.lat }));
  altIndex = 0;
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
        .setHTML(`<b>${i === 0 ? 'Start' : last ? 'Finish' : 'Via point'}</b><button>Remove point</button>` +
          (i === 0 ? ' <button class="set-home">Set as home</button>' : ''))
        .addTo(map);
      const sh = popup.getElement().querySelector('.set-home');
      if (sh) sh.onclick = async () => { popup.remove(); await saveHome(w); showMsg('Home saved.'); };
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

// Routing options go to our patched profiles (cp-*) as BRouter profile parameters.
const TRAFFIC_PARAM = {
  fastbike: ['consider_traffic', '1'], safety: ['consider_traffic', '1'],
  trekking: ['consider_traffic', '1'], gravel: ['consider_traffic_estimate', '1'],
};
let patchedProfilesBroken = false;

const SIGNAL_PENALTY = 300; // metres of detour a traffic light is worth avoiding
const TURN_PENALTY = 60;     // metres per turn

function brouterUrl(points, profile, stock = false, alt = 0, over = {}) {
  const lonlats = points.map((p) => `${(+p[0]).toFixed(6)},${(+p[1]).toFixed(6)}`).join('|');
  let url = `${BROUTER_URL}?lonlats=${lonlats}&alternativeidx=${alt}&format=geojson`;
  const nogos = [typeof nogoParam === 'function' ? nogoParam() : '', typeof dislikedParam === 'function' ? dislikedParam() : ''].filter(Boolean).join('|');
  if (nogos) url += `&nogos=${nogos}`;
  url += '&profile=';
  if (stock) return url + encodeURIComponent(profile);
  url += encodeURIComponent('cp-' + profile);
  url += `&profile:avoid_footpaths=${$('opt-footpaths').checked ? 1 : 0}`;
  if ((over.traffic ?? $('opt-traffic').value) === 'avoid' && TRAFFIC_PARAM[profile]) url += `&profile:${TRAFFIC_PARAM[profile][0]}=${TRAFFIC_PARAM[profile][1]}`;
  if ($('opt-lights').checked) url += `&profile:signal_penalty=${SIGNAL_PENALTY}`;
  if ($('opt-turns').checked) url += `&profile:turn_penalty=${TURN_PENALTY}`;
  return url;
}

// Fetch and parse a route. If our patched profile ever fails where the stock one works,
// fall back to the stock profile and say so.
async function brouterRoute(points, profile, signal, alt = 0, over = {}) {
  const get = async (url) => {
    const res = await fetch(url, { signal });
    const text = await res.text();
    if ([502, 503, 504].includes(res.status)) throw new Error('the router is still starting up (first start downloads the map data). Try again in a minute.');
    if (!res.ok || !text.trim().startsWith('{')) { const e = new Error(text.trim().slice(0, 200) || `HTTP ${res.status}`); e.routing = true; throw e; }
    return parseBRouter(JSON.parse(text));
  };
  if (!patchedProfilesBroken) {
    try { return await get(brouterUrl(points, profile, false, alt, over)); } catch (e) {
      if (!e.routing) throw e;
      const rt = await get(brouterUrl(points, profile, true, alt)); // throws the real routing error if this fails too
      patchedProfilesBroken = true;
      console.warn('Patched profile failed, using stock profile:', e.message);
      return rt;
    }
  }
  return get(brouterUrl(points, profile, true, alt));
}

async function requestRoute(fit) {
  if (routeAbort) routeAbort.abort();
  if (waypoints.length < 2) { route = null; renderRoute(); return; }
  const seq = ++routeSeq;
  routeAbort = new AbortController();
  showMsg('Routing…');
  try {
    let rt = await brouterRoute(waypoints.map((w) => [w.lng, w.lat]), $('profile').value, routeAbort.signal, altIndex);
    if (seq !== routeSeq) return;
    // Loop points can end up down a dead end when options change (e.g. traffic setting):
    // pull them back to where the spike leaves the through road and reroute.
    for (let round = 0; round < 2 && typeof spikes === 'function' && waypoints.some((w) => w.auto); round++) {
      const pts = waypoints.map((w) => [w.lng, w.lat]);
      const bad = spikes(rt, pts).filter((s) => waypoints[s.n].auto && s.len > 40);
      if (!bad.length) break;
      for (const s of bad) { const p = pointAt(rt, s.at - s.len); waypoints[s.n] = { lng: p[0], lat: p[1], auto: true }; }
      rt = await brouterRoute(waypoints.map((w) => [w.lng, w.lat]), $('profile').value, routeAbort.signal, altIndex);
      if (seq !== routeSeq) return;
      renderMarkers();
      writeHash();
    }
    route = rt;
    showMsg(patchedProfilesBroken ? 'Footpath and traffic options are unavailable (profile error), using the standard profile.' : '');
    renderRoute();
    if (fit) fitRoute();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (/datafile \S+\.rd5 not found/.test(err.message)) { offerRegions(waypoints.map((w) => [w.lng, w.lat]), err.message); return; }
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
  if (colourers[mode]) {
    return {
      type: 'FeatureCollection',
      features: colourers[mode](route).map((p) => ({
        type: 'Feature', properties: { color: p.color },
        geometry: { type: 'LineString', coordinates: route.coords.slice(p.i0, p.i1 + 1) },
      })),
    };
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
  for (const h of routeHooks) { try { h(route); } catch (e) { console.error(e); } }
}
function refreshRouteColours() { if (map.getSource('route')) map.getSource('route').setData(routeFeatures()); }

function fitRoute() {
  if (!route) return;
  const b = new maplibregl.LngLatBounds();
  route.coords.forEach((c) => b.extend([c[0], c[1]]));
  const mobile = window.innerWidth < 760;
  map.fitBounds(b, { padding: mobile ? { top: 40, bottom: 260, left: 30, right: 30 } : { top: 40, bottom: 40, left: 400, right: 60 }, maxZoom: 15 });
}

let modelAvgKmh = null; // average speed from the power model (pace.js), when it's in use
function speedKmh() { return modelAvgKmh || Math.max(5, +$('speed').value || 27); }

// Steepest stretch of a fixed length. Grades between single points are mostly elevation noise.
function steepest(rt, win = 200) {
  let best = { pct: 0, at: 0 };
  if (!rt || rt.coords.length < 2 || rt.coords[0].length < 3) return best;
  let j = 0;
  for (let i = 0; i < rt.coords.length; i++) {
    while (j < rt.coords.length - 1 && rt.cum[j] - rt.cum[i] < win) j++;
    if (rt.cum[j] - rt.cum[i] < win) break;
    const pct = (100 * (rt.coords[j][2] - rt.coords[i][2])) / (rt.cum[j] - rt.cum[i]);
    if (pct > best.pct) best = { pct, at: rt.cum[i] };
  }
  return best;
}

function renderStats() {
  if (!route) { $('s-dist').textContent = '–'; $('s-asc').textContent = '–'; $('s-time').textContent = '–'; $('s-steep').textContent = ''; return; }
  $('s-dist').textContent = fmtKm(route.length);
  $('s-asc').textContent = Math.round(route.ascend);
  const st = steepest(route);
  $('s-steep').textContent = st.pct >= 1 ? ` · max ${st.pct.toFixed(st.pct < 10 ? 1 : 0)}%` : '';
  $('s-steep').title = st.pct >= 1 ? `Steepest 200 m: ${st.pct.toFixed(1)}% starting at km ${(st.at / 1000).toFixed(1)}` : '';
  const model = typeof modelRide === 'function' ? modelRide(route) : null;
  modelAvgKmh = model ? model.avgKmh : null;
  $('s-time').textContent = fmtDuration(model ? model.hours : route.length / 1000 / speedKmh());
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
function gradeColour(g) {
  if (g >= 9) return '#c92a2a';
  if (g >= 6) return '#f76707';
  if (g >= 3) return '#f59f00';
  if (g <= -3) return '#4dabf7';
  return '#868e96';
}
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
  ctx.fillStyle = 'rgba(134,142,150,.15)'; ctx.fill();
  // Line coloured by gradient over ~100 m pieces.
  ctx.lineWidth = 2;
  for (const p of routePieces(route, 100)) {
    const len = route.cum[p.i1] - route.cum[p.i0];
    const g = len ? (100 * ((route.coords[p.i1][2] ?? 0) - (route.coords[p.i0][2] ?? 0))) / len : 0;
    ctx.strokeStyle = gradeColour(g);
    ctx.beginPath();
    for (let i = p.i0; i <= p.i1; i++) (i === p.i0 ? ctx.moveTo : ctx.lineTo).call(ctx, X(route.cum[i]), Y(route.coords[i][2]));
    ctx.stroke();
  }

  // toilet / water ticks along the bottom
  for (const s of stopsOnRoute) {
    ctx.fillStyle = POI_COLOURS[s.poi.kind];
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
  nwr["amenity"="cafe"](${b});
  node["man_made"="water_tap"]["drinking_water"="yes"](${b});
)->.all;
(way["shop"="mall"](${b});relation["shop"="mall"](${b}););
map_to_area->.malls;
nwr.all(area.malls)->.inmall;
(.all; - .inmall;);
out center tags;`;
}

function usablePoi(t) {
  if (t.amenity === 'cafe') return !['private', 'no'].includes(t.access) && t.disused !== 'yes';
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
      const kind = t.amenity === 'toilets' ? 'toilet' : t.amenity === 'cafe' ? 'cafe' : 'water';
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

const POI_COLOURS = { water: '#1c7ed6', toilet: '#0b7285', cafe: '#8c5a2b' };
const POI_KINDS = ['toilet', 'water', 'cafe'];
function kindShown(kind) { const el = $('st-' + kind); return !el || el.checked; }
function applyPoiFilter() {
  if (map.getLayer('pois')) map.setFilter('pois', ['in', ['get', 'kind'], ['literal', POI_KINDS.filter(kindShown)]]);
}
function poiTitle(p) {
  if (p.kind === 'cafe') return p.tags.name ? `Café: ${p.tags.name}` : 'Café';
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
  if (!$('lyr-poi').checked) { gapsEl.innerHTML = '<div class="small">Turn on “Toilets, water &amp; cafés” under Map.</div>'; return; }
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
    if (!kindShown(s.poi.kind)) continue;
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
    q, format: 'jsonv2', limit: '6', // results near the map first, but anywhere in the world
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
    ? stopsOnRoute.filter((s) => kindShown(s.poi.kind)).map((s) => `  <wpt lat="${s.poi.lat.toFixed(6)}" lon="${s.poi.lng.toFixed(6)}"><name>${escapeHtml(poiTitle(s.poi))}</name><sym>${{ toilet: 'Restroom', cafe: 'Restaurant' }[s.poi.kind] || 'Drinking Water'}</sym></wpt>`).join('\n')
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
  let prof = params.get('p');
  if (prof === 'fastbike-lowtraffic') { prof = 'fastbike'; $('opt-traffic').value = 'avoid'; }
  if (prof && [...$('profile').options].some((o) => o.value === prof)) $('profile').value = prof;
  const w = params.get('w');
  if (!w) return null;
  const pts = w.split(';').map((s) => s.split(',').map(Number)).filter((a) => a.length === 2 && a.every(Number.isFinite));
  return pts.length ? pts.map(([lng, lat]) => ({ lng, lat })) : null;
}
// ---------- controls ----------
$('undo').onclick = () => { if (undoStack.length) setWaypoints(undoStack.pop(), { record: false }); };
$('reverse').onclick = () => { if (waypoints.length > 1) setWaypoints([...waypoints].reverse()); };
// Home: a saved start point, kept on the server so every device has it.
let home = null;
(async () => { try { const r = await fetch('/api/settings/home'); if (r.ok) home = await r.json(); } catch { /* offline */ } })();
async function saveHome(p) {
  home = p ? { lng: +p.lng, lat: +p.lat } : null;
  try { await fetch('/api/settings/home', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(home) }); }
  catch { showMsg('Could not save home: the server did not answer.'); }
}
$('home').onclick = async () => {
  if (!home) {
    if (!waypoints.length) { showMsg('Put a point on your house, then press Home to save it.'); return; }
    await saveHome(waypoints[0]);
    showMsg('Saved your start point as home. Press Home any time to start from there (tap the S marker to change it).');
    return;
  }
  showMsg('');
  if (!waypoints.length) { setWaypoints([home]); map.easeTo({ center: [home.lng, home.lat], zoom: Math.max(map.getZoom(), 13) }); }
  else setWaypoints([home, ...waypoints.slice(1)]); // swap the start for home, keep the rest
};
$('loop').onclick = () => { if (waypoints.length > 1) setWaypoints([...waypoints, { ...waypoints[0] }]); };
$('clear').onclick = () => { if (waypoints.length) setWaypoints([]); };
$('gpx-wpt').onchange = () => store.set('cp.gpxwpt', $('gpx-wpt').checked);
$('opt-footpaths').onchange = () => { store.set('cp.footpaths', $('opt-footpaths').checked); requestRoute(false); };
$('opt-traffic').onchange = () => { store.set('cp.traffic', $('opt-traffic').value); requestRoute(false); };
$('profile').onchange = () => { store.set('cp.profile', $('profile').value); writeHash(); requestRoute(false); };
$('speed').oninput = () => { store.set('cp.speed', $('speed').value); renderStats(); };
$('colour-by').onchange = () => { store.set('cp.colour', $('colour-by').value); if (map.getSource('route')) map.getSource('route').setData(routeFeatures()); };
function applyBase() {
  const b = $('lyr-base').value;
  map.setLayoutProperty('aerial', 'visibility', b === 'aerial' ? 'visible' : 'none');
  // Landgate only covers WA, so the Esri satellite sits underneath it to fill in everywhere else.
  map.setLayoutProperty('satellite', 'visibility', b !== 'map' ? 'visible' : 'none');
  map.setLayoutProperty('photo-paths', 'visibility', b !== 'map' && $('lyr-photo-paths').checked ? 'visible' : 'none');
  $('photo-paths-row').hidden = b === 'map';
  // The base map's 3D buildings would sit on top of the photo.
  for (const l of map.getStyle().layers) if (l.type === 'fill-extrusion') map.setLayoutProperty(l.id, 'visibility', b === 'map' ? 'visible' : 'none');
  if (b !== 'map') store.set('cp.photo', b); // remembered for the map button
  const btn = document.querySelector('.base-toggle');
  if (btn) {
    btn.classList.toggle('on', b !== 'map');
    btn.title = b === 'map' ? 'Show the aerial photo' : 'Back to the map';
    btn.setAttribute('aria-pressed', b !== 'map');
  }
}
$('lyr-base').onchange = () => { store.set('cp.base', $('lyr-base').value); applyBase(); };
// Map / photo button on the map itself. It flips to whichever photo you last used (aerial by default).
map.addControl({
  onAdd() {
    const div = document.createElement('div');
    div.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    div.innerHTML = '<button type="button" class="base-toggle" title="Show the aerial photo" aria-pressed="false">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="m2 13 10 5 10-5"/></svg></button>';
    div.firstChild.onclick = () => {
      const sel = $('lyr-base');
      sel.value = sel.value === 'map' ? store.get('cp.photo', 'aerial') : 'map';
      sel.onchange();
    };
    return div;
  },
  onRemove() {},
}, 'top-right');
$('lyr-photo-paths').onchange = () => { store.set('cp.photo-paths', $('lyr-photo-paths').checked); applyBase(); };
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

// ---------- base map details (OpenFreeMap "liberty" layer ids) ----------
const POI_LAYERS = ['poi_r1', 'poi_r7', 'poi_r20', 'poi_transit'];
const STREET_LAYERS = ['highway-name-path', 'highway-name-minor', 'highway-name-major'];
const MAP_DETAILS = { bus: false, rail: true, places: true, streets: true };
const baseFilters = {};

function applyMapDetails() {
  const d = {};
  for (const k of Object.keys(MAP_DETAILS)) { d[k] = $('md-' + k).checked; store.set('cp.md.' + k, d[k]); }
  const hidden = [];
  if (!d.bus) hidden.push('bus');
  if (!d.rail) hidden.push('rail', 'railway');
  for (const id of POI_LAYERS) {
    if (!map.getLayer(id)) continue;
    if (!(id in baseFilters)) baseFilters[id] = map.getFilter(id);
    const parts = [baseFilters[id]].filter(Boolean);
    if (hidden.length) parts.push(['!', ['match', ['get', 'class'], hidden, true, false]]);
    // Shops/cafés etc. live in the ranked layers; keep stations there if wanted.
    if (id !== 'poi_transit' && !d.places) {
      const keep = [...(d.bus ? ['bus'] : []), ...(d.rail ? ['rail', 'railway'] : [])];
      parts.push(keep.length ? ['match', ['get', 'class'], keep, true, false] : false);
    }
    map.setFilter(id, parts.length > 1 ? ['all', ...parts] : (parts[0] ?? null));
  }
  for (const id of STREET_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', d.streets ? 'visible' : 'none');
}
for (const k of Object.keys(MAP_DETAILS)) $('md-' + k).addEventListener('change', applyMapDetails);

function restoreSettings() {
  for (const k of POI_KINDS) {
    $('st-' + k).checked = store.get('cp.st.' + k, true);
    $('st-' + k).addEventListener('change', () => { store.set('cp.st.' + k, $('st-' + k).checked); applyPoiFilter(); renderStops(); drawElevation(); });
  }
  applyPoiFilter();
  $('gpx-wpt').checked = store.get('cp.gpxwpt', false);
  $('opt-footpaths').checked = store.get('cp.footpaths', true);
  $('opt-traffic').value = store.get('cp.traffic', 'normal');
  for (const [k, def] of Object.entries(MAP_DETAILS)) $('md-' + k).checked = store.get('cp.md.' + k, def);
  applyMapDetails();
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
  if (!$('profile').value) $('profile').value = 'fastbike';
  $('speed').value = store.get('cp.speed', 27);
  $('colour-by').value = store.get('cp.colour', 'none');
  $('lyr-base').value = store.get('cp.base', 'map');
  $('lyr-photo-paths').checked = store.get('cp.photo-paths', true);
  applyBase();
  const cyc = store.get('cp.cyclosm', false);
  $('lyr-cyclosm').checked = cyc;
  map.setLayoutProperty('cyclosm', 'visibility', cyc ? 'visible' : 'none');
  const poi = store.get('cp.poi', true);
  $('lyr-poi').checked = poi;
  map.setLayoutProperty('pois', 'visibility', poi ? 'visible' : 'none');
  drawElevation();
}
