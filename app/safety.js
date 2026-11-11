'use strict';
/* Road safety: main roads and fast roads on the planned route. */

function speedLimit(t) {
  const m = /^(\d+)/.exec(t.maxspeed || '');
  return m ? +m[1] : null;
}

function safetyStretches(rt) {
  const out = [];
  for (const s of rt.segs) {
    const h = s.tags.highway || '';
    const main = /^(trunk|primary|secondary|motorway)/.test(h);
    const v = speedLimit(s.tags);
    const fast = v != null && v >= 80;
    if (!main && !fast) { out.push(null); continue; }
    const kind = `${h.replace('_link', ' link')} road${v ? `, ${v} km/h` : ''}`;
    const prev = out[out.length - 1];
    if (prev && prev.kind === kind && prev.i1 === s.i0) { prev.i1 = s.i1; prev.fast ||= fast; }
    else out.push({ i0: s.i0, i1: s.i1, kind, fast });
  }
  return out.filter(Boolean).map((x) => ({ ...x, len: rt.cum[x.i1] - rt.cum[x.i0] })).filter((x) => x.len >= 50);
}

// Warning signs on the map, so the risky bits stand out without opening the list.
function safetyFeatures(list) {
  const feats = [];
  for (const x of list) {
    const line = route.coords.slice(x.i0, x.i1 + 1).map((p) => [p[0], p[1]]);
    const props = { fast: x.fast ? 1 : 0, label: `${fmtKm(x.len)} km · ${x.kind}`, km: (route.cum[x.i0] / 1000).toFixed(1) };
    feats.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: line } });
    if (x.len >= 150) {
      const mid = pointAt(route, (route.cum[x.i0] + route.cum[x.i1]) / 2);
      feats.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [mid[0], mid[1]] } });
    }
  }
  return { type: 'FeatureCollection', features: feats };
}

function warningIcon(fill) {
  const c = document.createElement('canvas'); c.width = c.height = 56;
  const g = c.getContext('2d');
  g.lineJoin = 'round';
  g.beginPath(); g.moveTo(28, 5); g.lineTo(52, 48); g.lineTo(4, 48); g.closePath();
  g.fillStyle = fill; g.fill(); g.lineWidth = 4; g.strokeStyle = '#fff'; g.stroke();
  g.fillStyle = '#1d2125'; g.font = 'bold 30px sans-serif'; g.textAlign = 'center'; g.fillText('!', 28, 43);
  return g.getImageData(0, 0, 56, 56);
}

map.on('load', () => {
  map.addImage('warn-main', warningIcon('#fcc419'), { pixelRatio: 2 });
  map.addImage('warn-fast', warningIcon('#fa5252'), { pixelRatio: 2 });
  map.addSource('safety', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'safety-line', type: 'line', source: 'safety', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['case', ['==', ['get', 'fast'], 1], '#fa5252', '#fcc419'], 'line-opacity': 0.55,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 9, 16, 16] } }, 'route-casing');
  map.addLayer({ id: 'safety-icon', type: 'symbol', source: 'safety', filter: ['==', ['geometry-type'], 'Point'],
    layout: { 'icon-image': ['case', ['==', ['get', 'fast'], 1], 'warn-fast', 'warn-main'], 'icon-size': 1,
      'icon-allow-overlap': true, 'icon-anchor': 'bottom', 'icon-offset': [0, -4] } });
  map.on('click', 'safety-icon', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ offset: 24 }).setLngLat(e.lngLat)
      .setHTML(`<b>${p.fast ? 'Fast road' : 'Main road'}</b>from km ${p.km}: ${escapeHtml(p.label)}`).addTo(map);
  });
  map.on('mouseenter', 'safety-icon', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'safety-icon', () => { map.getCanvas().style.cursor = ''; });
  applySafetyMarks();
});

// A tap on a warning sign opens its popup instead of adding a route point.
clickHandlers.push((e) => !!map.getLayer('safety-icon') && map.queryRenderedFeatures(e.point, { layers: ['safety-icon'] }).length > 0);

function applySafetyMarks() {
  if (!map.getLayer('safety-icon')) return;
  const on = $('safety-marks').checked;
  for (const id of ['safety-line', 'safety-icon']) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
$('safety-marks').checked = store.get('cp.safety-marks', true);
$('safety-marks').onchange = () => { store.set('cp.safety-marks', $('safety-marks').checked); applySafetyMarks(); };

function renderSafety() {
  const ul = $('safety'), sum = $('safety-sum');
  ul.innerHTML = '';
  sum.textContent = '';
  const src = map.getSource('safety');
  if (src) src.setData(emptyFC());
  if (!route) return;
  const list = safetyStretches(route);
  if (src) src.setData(safetyFeatures(list));
  if (!list.length) { sum.textContent = 'No main or fast roads on this route.'; return; }
  const tot = list.reduce((a, x) => a + x.len, 0), fast = list.filter((x) => x.fast).reduce((a, x) => a + x.len, 0);
  sum.textContent = `${fmtKm(tot)} km on main roads` + (fast ? `, ${fmtKm(fast)} km of it signed 80 km/h or more.` : '.');
  for (const x of list) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="km">${(route.cum[x.i0] / 1000).toFixed(1)}</span><span>${fmtKm(x.len)} km · ${escapeHtml(x.kind)}</span>` +
      (x.fast ? '<span class="badge warn">fast</span>' : '');
    li.onclick = () => {
      const b = new maplibregl.LngLatBounds();
      route.coords.slice(x.i0, x.i1 + 1).forEach((p) => b.extend([p[0], p[1]]));
      map.fitBounds(b, { padding: 80, maxZoom: 16 });
    };
    ul.appendChild(li);
  }
}
routeHooks.push(renderSafety);
