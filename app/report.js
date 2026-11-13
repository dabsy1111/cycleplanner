'use strict';
/* Problem reports: one JSON file with everything needed to replay the current route exactly,
   plus the rider's notes and marked problem spots. Meant to be sent to Claude. */

let repSpots = [];      // [{lng, lat, note, marker}]
let placingSpot = false;
let appVersion = 'unknown';
fetch('version.txt').then((r) => (r.ok ? r.text() : 'dev')).then((t) => { appVersion = t.trim().slice(0, 12) || 'dev'; }).catch(() => {});

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const opt = (name, fallback = null) => { try { return eval(name); } catch { return fallback; } }; // module globals that may not exist

function chainageOf(lng, lat) {
  if (!route) return null;
  const i = nearestIndex(route.coords, [lng, lat], 0);
  return { km: +(route.cum[i] / 1000).toFixed(2), offRouteM: Math.round(haversine(route.coords[i], [lng, lat])) };
}

// Merge consecutive message segments with identical tags into stretches with km ranges.
function routeStretches(rt) {
  const out = [];
  for (const s of rt.segs) {
    const tags = Object.entries(s.tags).map(([k, v]) => `${k}=${v}`).join(' ');
    const last = out[out.length - 1];
    if (last && last.tags === tags) { last.toKm = +(rt.cum[s.i1] / 1000).toFixed(2); continue; }
    out.push({ fromKm: +(rt.cum[s.i0] / 1000).toFixed(2), toKm: +(rt.cum[s.i1] / 1000).toFixed(2), way: wayClass(s.tags), surface: surfaceClass(s.tags), tags });
  }
  return out;
}

function buildReport() {
  const pts = waypoints.map((w) => [w.lng, w.lat]);
  const req = pts.length > 1 ? brouterUrl(pts, $('profile').value, false, altIndex) : null;
  const rep = {
    kind: 'cycleplanner-problem-report',
    reportVersion: 1,
    appVersion,
    created: new Date().toISOString(),
    notes: $('rep-notes').value.trim(),
    problemSpots: repSpots.map((s, i) => ({ n: i + 1, lng: r5(s.lng), lat: r5(s.lat), note: s.note, ...chainageOf(s.lng, s.lat) })),
    view: { center: [r5(map.getCenter().lng), r5(map.getCenter().lat)], zoom: +map.getZoom().toFixed(1) },
    profile: $('profile').value,
    options: { ...getOptions(), alternativeIndex: altIndex },
    pace: { mode: opt('powerMode()') ? 'power' : 'speed', pctFtp: +$('pace-pct').value, speedKmh: +$('speed').value, athlete: opt('athlete') },
    departure: $('wind-time').value,
    waypoints: waypoints.map((w) => [r5(w.lng), r5(w.lat)]),
    brouterRequest: req,
    nogoAreas: opt('nogoAreas', []),
    markedRoads: (opt('markedRoads', []) || []).map((r) => ({ kind: r.kind, name: r.name, line: r.line })),
    loop: null,
    loopStatus: $('loop-status')?.textContent || null,
    route: null,
  };
  const ll = opt('lastLoop');
  if (ll) {
    const same = ll.waypoints.length === waypoints.length &&
      ll.waypoints.every((p, i) => Math.abs(p[0] - waypoints[i].lng) < 1e-6 && Math.abs(p[1] - waypoints[i].lat) < 1e-6);
    rep.loop = { ...ll, waypoints: ll.waypoints.map((p) => [r5(p[0]), r5(p[1])]), editedSince: !same };
  }
  if (route) {
    const geom = simplifyLine(route.coords.map((c) => [c[0], c[1]]), 4);
    const model = opt('modelRide(route)');
    rep.route = {
      km: +(route.length / 1000).toFixed(2),
      ascentM: Math.round(route.ascend),
      time: $('s-time').textContent,
      modelAvgKmh: model ? +model.avgKmh.toFixed(1) : null,
      wayBreakdown: $('bd-way').innerText.split('\n').filter(Boolean),
      surfaceBreakdown: $('bd-surface').innerText.split('\n').filter(Boolean),
      stretches: routeStretches(route),
      roadSafety: (opt('safetyStretches(route)', []) || []).map((x) => ({ fromKm: +(route.cum[x.i0] / 1000).toFixed(2), km: +(x.len / 1000).toFixed(2), kind: x.kind })),
      uturns: typeof uturns === 'function' ? uturns(route).map((u) => ({ atKm: +(u.at / 1000).toFixed(2), lengthM: u.len })) : null,
      steepest200: (() => { const s = steepest(route); return { pct: +s.pct.toFixed(1), atKm: +(s.at / 1000).toFixed(2) }; })(),
      climbs: (opt('climbList', []) || []).map((c) => ({ fromKm: +(route.cum[c.i0] / 1000).toFixed(2), km: +(c.len / 1000).toFixed(2), avgPct: +c.avg.toFixed(1), maxPct: +c.max.toFixed(1), gainM: Math.round(c.gain), riddenBefore: c.ridden ?? null })),
      geometry: geom.map(([lng, lat]) => [r5(lng), r5(lat)]),
    };
  }
  return rep;
}

function reportText() { return JSON.stringify(buildReport(), null, 1); }

function setPlacingSpot(on) {
  placingSpot = on;
  document.body.classList.toggle('placing', on);
  $('rep-spot').textContent = on ? 'Tap the map at the problem (tap here to cancel)' : 'Mark a problem spot';
}

function renderSpots() {
  const ul = $('rep-spots');
  ul.innerHTML = '';
  repSpots.forEach((s, i) => {
    s.marker.getElement().textContent = i + 1;
    const ch = chainageOf(s.lng, s.lat);
    const li = document.createElement('li');
    li.innerHTML = `<span class="km">${ch ? ch.km.toFixed(1) : '–'}</span><input class="spot-note" placeholder="What's wrong here?"><button class="x" title="Delete">✕</button>`;
    const inp = li.querySelector('input');
    inp.value = s.note;
    inp.oninput = () => { s.note = inp.value; };
    li.querySelector('button').onclick = () => { s.marker.remove(); repSpots.splice(i, 1); renderSpots(); };
    ul.appendChild(li);
  });
}

const spotClick = (e) => {
  if (!placingSpot) return false;
  const el = Object.assign(document.createElement('div'), { className: 'spot' });
  const s = { lng: e.lngLat.lng, lat: e.lngLat.lat, note: '' };
  s.marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(e.lngLat).addTo(map);
  s.marker.on('dragend', () => { const p = s.marker.getLngLat(); s.lng = p.lng; s.lat = p.lat; renderSpots(); });
  repSpots.push(s);
  setPlacingSpot(false);
  renderSpots();
  const inputs = $('rep-spots').querySelectorAll('input');
  inputs[inputs.length - 1].focus();
  return true;
};
spotClick.busy = () => placingSpot;
clickHandlers.push(spotClick);
$('rep-spot').onclick = () => setPlacingSpot(!placingSpot);
routeHooks.push(() => { if (repSpots.length) renderSpots(); });

function reportName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `cycleplanner-report-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

$('rep-download').onclick = () => {
  if (waypoints.length < 2 && !$('rep-notes').value.trim()) { $('rep-status').textContent = 'Plan a route or write a note first.'; return; }
  const blob = new Blob([reportText()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = reportName();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  $('rep-status').textContent = `Saved ${a.download}. Attach it in your chat with Claude.`;
};

$('rep-copy').onclick = async () => {
  const text = reportText();
  try {
    await navigator.clipboard.writeText(text);
    $('rep-status').textContent = `Copied (${Math.round(text.length / 1024)} KB). Paste it into your chat with Claude.`;
  } catch {
    // Clipboard needs https: show it so it can be selected and copied by hand.
    $('rep-status').innerHTML = '<textarea rows="6" readonly></textarea>Select all and copy. (One-tap copy needs the planner on https.)';
    const ta = $('rep-status').querySelector('textarea');
    ta.value = text;
    ta.focus(); ta.select();
  }
};
