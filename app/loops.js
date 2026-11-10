'use strict';
/* Loop generator: waypoints on a circle through the start, resized until BRouter's distance matches. */

const LOOP_BEARINGS = [0, 60, 120, 180, 240, 300];
let loopResults = [];

async function fetchRoute(points, profile) {
  const lonlats = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join('|');
  const res = await fetch(`${BROUTER_URL}?lonlats=${lonlats}&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson`);
  const text = await res.text();
  if (!res.ok || !text.trim().startsWith('{')) throw new Error(text.trim().slice(0, 120) || `HTTP ${res.status}`);
  return parseBRouter(JSON.parse(text));
}

function circlePoints(start, brg, radius) {
  const centre = destination(start, brg, radius);
  const back = (brg + 180) % 360; // bearing from the centre back to the start
  return [start, ...[90, 180, 270].map((d) => destination(centre, (back + d) % 360, radius)), start];
}

async function makeLoop(start, brg, target, profile) {
  let radius = target / (2 * Math.PI * 1.3); // roads are ~30% longer than the circle
  let best = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const pts = circlePoints(start, brg, radius);
    const rt = await fetchRoute(pts, profile);
    const err = Math.abs(rt.length - target) / target;
    if (!best || err < best.err) best = { pts, rt, err, brg };
    if (err < 0.07) break;
    radius *= target / rt.length;
  }
  return best;
}

function mainRoadPct(rt) {
  let main = 0;
  for (const s of rt.segs) if (wayClass(s.tags) === 'main') main += rt.cum[s.i1] - rt.cum[s.i0];
  return (100 * main) / (rt.length || 1);
}

function showLoopPreview(highlight = -1) {
  const src = map.getSource('loops');
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features: loopResults.map((l, k) => ({
      type: 'Feature', properties: { hl: k === highlight ? 1 : 0 },
      geometry: { type: 'LineString', coordinates: l.rt.coords.map((c) => [c[0], c[1]]) },
    })),
  });
}

function renderLoops() {
  const ul = $('loops');
  ul.innerHTML = '';
  const bestWind = loopResults.reduce((b, l, k) => (l.wind && (b < 0 || l.wind.second < loopResults[b].wind.second) ? k : b), -1);
  loopResults.forEach((l, k) => {
    const li = document.createElement('li');
    const tags = [];
    if (k === bestWind) tags.push('<span class="tag">best for wind</span>');
    if (l.newPct != null && l.newPct >= 40) tags.push(`<span class="tag">${Math.round(l.newPct)}% new</span>`);
    li.innerHTML = `<span class="km">${fmtKm(l.rt.length)}</span>` +
      `<span>Heads ${compass(l.brg)} · ${Math.round(l.rt.ascend)} m up · ${Math.round(mainRoadPct(l.rt))}% main road${tags.join('')}</span>` +
      `<span class="off">${l.wind ? fmtWind(l.wind.second).replace('wind', 'wind home') : ''}</span>`;
    li.onmouseenter = () => showLoopPreview(k);
    li.onmouseleave = () => showLoopPreview(-1);
    li.onclick = () => {
      loopResults = [];
      showLoopPreview();
      ul.innerHTML = '';
      $('loop-status').textContent = '';
      setWaypoints(l.pts.map(([lng, lat]) => ({ lng, lat })), { fit: true });
    };
    ul.appendChild(li);
  });
}

async function generateLoops() {
  const km = +$('loop-km').value || 50;
  store.set('cp.loopkm', km);
  const target = km * 1000;
  const start = waypoints.length ? [waypoints[0].lng, waypoints[0].lat] : [map.getCenter().lng, map.getCenter().lat];
  const profile = $('profile').value;
  const st = $('loop-status');
  const btn = $('loop-go');
  btn.disabled = true;
  loopResults = [];
  renderLoops();
  showLoopPreview();
  try { await loadWind(start[0], start[1]); } catch { /* wind is optional */ }

  let done = 0, failed = 0;
  st.textContent = `Working… 0 of ${LOOP_BEARINGS.length}`;
  const queue = [...LOOP_BEARINGS];
  const worker = async () => {
    while (queue.length) {
      const brg = queue.shift();
      try {
        const l = await makeLoop(start, brg, target, profile);
        // Ride it whichever way puts the wind behind you on the way home.
        if (wind) {
          const fwd = windStats(l.rt), rev = windStats(l.rt, true);
          if (rev.second < fwd.second - 1) {
            l.pts = [...l.pts].reverse();
            l.rt = await fetchRoute(l.pts, profile);
            l.wind = windStats(l.rt);
          } else l.wind = fwd;
        }
        if (typeof newRoadShare === 'function') l.newPct = newRoadShare(l.rt);
        if (l.err < 0.25) loopResults.push(l);
      } catch { failed++; } // usually a circle point out at sea
      done++;
      st.textContent = `Working… ${done} of ${LOOP_BEARINGS.length}`;
      loopResults.sort((a, b) => a.brg - b.brg);
      renderLoops();
      showLoopPreview();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  btn.disabled = false;
  if (loopResults.length) {
    const b = new maplibregl.LngLatBounds();
    loopResults.forEach((l) => l.rt.coords.forEach((c) => b.extend([c[0], c[1]])));
    map.fitBounds(b, { padding: 50 });
    st.textContent = `${loopResults.length} loops. Hover to highlight one, tap to use it.`;
  } else {
    st.textContent = 'No loops found. Try a different distance or start point.';
  }
}

function updateLoopTime() {
  const km = +$('loop-km').value || 0;
  $('loop-time').textContent = km ? `(about ${fmtDuration(km / Math.max(5, +$('speed').value || 27))})` : '';
}

map.on('load', () => {
  map.addSource('loops', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'loops', type: 'line', source: 'loops',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['case', ['==', ['get', 'hl'], 1], '#1971c2', '#495057'],
      'line-width': ['case', ['==', ['get', 'hl'], 1], 5, 2.5],
      'line-opacity': ['case', ['==', ['get', 'hl'], 1], 0.95, 0.5],
    } }, 'route-casing');
});

$('loop-km').value = store.get('cp.loopkm', 50);
updateLoopTime();
$('loop-km').addEventListener('input', updateLoopTime);
$('speed').addEventListener('input', updateLoopTime);
$('loop-go').onclick = generateLoops;
