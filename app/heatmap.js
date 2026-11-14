'use strict';
/* Popularity heatmap overlay (Part 1: display only, routing doesn't read it yet).
   Tiles come from your heatmap proxy through the history service: /tiles/heat/<activity>/<color>/{z}/{x}/{y}.png.
   Same origin as the app, so no CORS, and the server keeps a copy of every tile in data/heat. */

const HEAT_MIN_Z = 5;    // the proxy has nothing useful below this
// Highest zoom we ask for. The proxy's tiles are 512 px, so a z14 tile stays sharp to about z15,
// and MapLibre stretches it beyond that. The route scoring reads the same z14 tiles, so looking
// at the map and scoring routes share one download.
const HEAT_MAX_Z = 14;
const heatPrefs = {
  show: store.get('cp.heat', false),
  activity: store.get('cp.heat.act', 'ride'),
  color: store.get('cp.heat.col', 'hot'),
  opacity: store.get('cp.heat.op', 60),
};
let heatErrors = 0;      // failed tiles since the last change of settings
let heatChecking = false;
let heatRetry = 0;

function heatTileUrl() {
  return `${location.origin}/tiles/heat/${encodeURIComponent(heatPrefs.activity)}/${encodeURIComponent(heatPrefs.color)}/{z}/{x}/{y}.png`;
}

function heatStatus(text) { $('heat-status').textContent = text || ''; }

// Ask the server whether it can reach the proxy, and say so in plain words.
async function checkHeatServer() {
  if (heatChecking) return;
  heatChecking = true;
  try {
    const res = await fetch(`/api/heat/status?activity=${encodeURIComponent(heatPrefs.activity)}&color=${encodeURIComponent(heatPrefs.color)}`);
    if (!res.ok) throw new Error();
    const s = await res.json();
    if (!s.configured) heatStatus('No heatmap source set: add HEATMAP_URL to the history service in the stack, then redeploy.');
    else if (s.reachable === false) {
      heatStatus(`Can't reach the heatmap proxy at ${s.upstream}. ${s.last_error || ''} Cached tiles still show.`);
      clearTimeout(heatRetry);
      heatRetry = setTimeout(() => { if (heatPrefs.show) checkHeatServer(); }, 30000); // look again until it's back
    }
    else if (heatErrors && !s.layer_error) {
      // The proxy is back: MapLibre doesn't retry tiles that failed, so ask for them again.
      setHeatSource();
    } else if (s.layer_error) heatStatus(`The proxy won't serve ${heatPrefs.activity}/${heatPrefs.color}: ${s.layer_error}`);
    else heatStatus('');
  } catch {
    heatStatus('The history service isn\'t running, and it\'s what fetches heatmap tiles.');
  } finally {
    heatChecking = false;
  }
}
const recheckHeat = debounce(checkHeatServer, 800);

function applyHeat() {
  $('heat-opts').hidden = !heatPrefs.show;
  if (!map.getLayer('heat')) return;
  map.setLayoutProperty('heat', 'visibility', heatPrefs.show ? 'visible' : 'none');
  map.setPaintProperty('heat', 'raster-opacity', heatPrefs.opacity / 100);
}

function setHeatSource() {
  const src = map.getSource('heat');
  if (!src) return;
  heatErrors = 0;
  heatStatus('');
  src.setTiles([heatTileUrl()]);
}

map.on('load', () => {
  map.addSource('heat', {
    type: 'raster', tileSize: 256, minzoom: HEAT_MIN_Z, maxzoom: HEAT_MAX_Z,
    tiles: [heatTileUrl()],
  });
  // Under the street names and everything this app draws (history, marked roads, alternatives,
  // the route and its markers), above the base map and the aerial/satellite photos.
  const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer({
    id: 'heat', type: 'raster', source: 'heat', minzoom: HEAT_MIN_Z,
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': heatPrefs.opacity / 100, 'raster-fade-duration': 0 },
  }, firstLabel);
  applyHeat();
  if (heatPrefs.show) checkHeatServer();
});

// A tile that fails (502 = proxy unreachable and nothing cached) fires a map error with our source id.
// MapLibre just leaves the gap; we count them and check the server once things settle.
map.on('error', (e) => {
  if (e.sourceId !== 'heat') return;
  heatErrors++;
  recheckHeat();
});

// ---------- controls ----------
$('heat-show').checked = heatPrefs.show;
$('heat-activity').value = heatPrefs.activity;
$('heat-color').value = heatPrefs.color;
$('heat-opacity').value = heatPrefs.opacity;
$('heat-opacity-val').textContent = `${heatPrefs.opacity}%`;
$('heat-opts').hidden = !heatPrefs.show;

$('heat-show').onchange = (e) => {
  heatPrefs.show = e.target.checked;
  store.set('cp.heat', heatPrefs.show);
  applyHeat();
  if (heatPrefs.show) checkHeatServer();
};
$('heat-activity').onchange = (e) => {
  heatPrefs.activity = e.target.value;
  store.set('cp.heat.act', heatPrefs.activity);
  setHeatSource();
};
$('heat-color').onchange = (e) => {
  heatPrefs.color = e.target.value;
  store.set('cp.heat.col', heatPrefs.color);
  setHeatSource();
};
let heatOpFrame = 0;
$('heat-opacity').addEventListener('input', () => {
  heatPrefs.opacity = +$('heat-opacity').value;
  $('heat-opacity-val').textContent = `${heatPrefs.opacity}%`;
  if (heatOpFrame) return;
  heatOpFrame = requestAnimationFrame(() => { heatOpFrame = 0; applyHeat(); });
});
$('heat-opacity').addEventListener('change', () => store.set('cp.heat.op', heatPrefs.opacity));
