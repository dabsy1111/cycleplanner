'use strict';
/* Alternatives: route the same points with a few profiles and BRouter alternatives, then keep
   only routes that are really different from yours and from each other (the Cyclops idea:
   each one should win on something, shortest, least climbing or quietest). */

const ALT_PROFILES = ['fastbike', 'trekking'];
const ALT_MAX = 3;          // shown besides the route you're on
const ALT_OVERLAP = 0.7;    // more shared road than this counts as the same route
let altRoutes = [];         // candidates: [{prof, idx, rt, mainPct, steep}]
let altSeq = 0;

function altStats(prof, idx, rt) {
  return { prof, idx, rt, mainPct: mainRoadPct(rt), steep: steepest(rt).pct };
}

// Grid cells (~25 m) a route passes through, sampled every 20 m.
function cellsOf(rt) {
  if (rt._cells) return rt._cells;
  const s = new Set(), pts = [];
  for (let d = 0; d <= rt.length; d += 20) {
    const p = pointAt(rt, d);
    pts.push(p);
    s.add(`${Math.round(p[0] / 0.0003)}:${Math.round(p[1] / 0.00023)}`);
  }
  rt._cells = s; rt._samples = pts;
  return s;
}
function overlap(a, b) { // share of a that runs on b
  const cb = cellsOf(b); cellsOf(a);
  let hit = 0;
  for (const p of a._samples) {
    const cx = Math.round(p[0] / 0.0003), cy = Math.round(p[1] / 0.00023);
    let on = false;
    for (let dx = -1; dx <= 1 && !on; dx++) for (let dy = -1; dy <= 1 && !on; dy++) on = cb.has(`${cx + dx}:${cy + dy}`);
    if (on) hit++;
  }
  return hit / (a._samples.length || 1);
}
const sameRoute = (a, b) => Math.max(overlap(a, b), overlap(b, a)) > ALT_OVERLAP;

// The list to show: the route you're on first, then up to ALT_MAX different ones.
function altChoices() {
  if (!route) return [];
  const cur = altStats($('profile').value, altIndex, route);
  cur.current = true;
  const pool = altRoutes.filter((c) => c.rt.length < route.length * 1.5);
  const picks = [cur];
  const tryAdd = (c) => {
    if (!c || picks.length > ALT_MAX || picks.includes(c)) return;
    if (picks.some((p) => sameRoute(p.rt, c.rt))) return;
    picks.push(c);
  };
  const by = (f) => [...pool].sort((a, b) => f(a) - f(b));
  // Something that wins on each measure first, then the best all-rounders.
  tryAdd(by((c) => c.rt.length).find((c) => !picks.some((p) => sameRoute(p.rt, c.rt))));
  tryAdd(by((c) => c.rt.ascend).find((c) => !picks.some((p) => sameRoute(p.rt, c.rt))));
  tryAdd(by((c) => c.mainPct).find((c) => !picks.some((p) => sameRoute(p.rt, c.rt))));
  // The most popular one on the ride heatmap, once scores are in (heatscore.js).
  const pop = (c) => (typeof heatPct === 'function' ? heatPct(c.rt) : null);
  if (pool.some((c) => pop(c) != null)) {
    tryAdd(by((c) => -(pop(c) ?? -1)).find((c) => pop(c) != null && !picks.some((p) => sameRoute(p.rt, c.rt))));
  }
  for (const c of by((c) => c.rt.length / route.length + c.rt.ascend / Math.max(50, route.ascend) / 3 + c.mainPct / 100)) tryAdd(c);
  // Label what each one wins on, among the ones shown.
  const win = (f, label, slack) => {
    const best = Math.min(...picks.map(f));
    const second = picks.map(f).sort((a, b) => a - b)[1];
    if (picks.length > 1 && second - best >= slack) picks.find((p) => f(p) === best).wins.push(label);
  };
  picks.forEach((p) => { p.wins = []; });
  win((p) => p.rt.length, 'shortest', 200);
  win((p) => p.rt.ascend, 'least climbing', Math.max(5, route.ascend * 0.05));
  win((p) => p.mainPct, 'quietest', 2);
  // Only when every route shown has a score, so a route with no heatmap data can't lose by default.
  if (picks.every((p) => pop(p) != null)) win((p) => -pop(p), 'most popular', 3);
  return picks;
}

const PROFILE_NAME = { fastbike: 'fastest', safety: 'safest', trekking: 'touring', gravel: 'gravel' };

function renderAlts() {
  const ul = $('alts');
  ul.innerHTML = '';
  const choices = altRoutes.length ? altChoices() : [];
  const src = map.getSource('alts');
  if (src) {
    src.setData({
      type: 'FeatureCollection',
      features: choices.filter((c) => !c.current).map((c) => ({
        type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c.rt.coords.map((p) => [p[0], p[1]]) },
      })),
    });
  }
  if (!altRoutes.length) return;
  if (choices.length === 1) { ul.innerHTML = '<li class="small">No really different routes between these points.</li>'; return; }
  const cur = choices[0];
  for (const c of choices) {
    const li = document.createElement('li');
    if (c.current) li.classList.add('active');
    const dk = (c.rt.length - cur.rt.length) / 1000, du = Math.round(c.rt.ascend - cur.rt.ascend);
    const delta = c.current ? '' : ` (${dk >= 0 ? '+' : ''}${dk.toFixed(1)} km, ${du >= 0 ? '+' : ''}${du} m)`;
    const pct = typeof heatPct === 'function' ? heatPct(c.rt) : null;
    const popTxt = pct == null ? '' : ` · ${pct}% popular`;
    const wins = c.wins.map((w) => `<span class="tag win">${w}</span>`).join('');
    li.innerHTML = `<span class="km">${fmtKm(c.rt.length)}</span>` +
      `<span>${c.current ? 'Your route' : PROFILE_NAME[c.prof] + (c.idx ? ` #${c.idx + 1}` : '')}${delta} · ${Math.round(c.rt.ascend)} m up, max ${c.steep.toFixed(0)}% · ${Math.round(c.mainPct)}% main road${popTxt} ${wins}</span>` +
      `${c.current ? '<span class="off">riding this</span>' : ''}`;
    if (!c.current) {
      li.onmouseenter = () => highlightAlt(c);
      li.onmouseleave = () => highlightAlt(null);
      li.onclick = () => {
        $('profile').value = c.prof; store.set('cp.profile', c.prof);
        altIndex = c.idx; writeHash(); requestRoute(false);
      };
    }
    ul.appendChild(li);
  }
}

function highlightAlt(c) {
  const src = map.getSource('alt-hl');
  if (src) src.setData(c ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c.rt.coords.map((p) => [p[0], p[1]]) } } : emptyFC());
}

async function loadAlternatives() {
  const seq = ++altSeq;
  altRoutes = [];
  renderAlts();
  if (!$('opt-alts').checked || waypoints.length < 2 || !route) return;
  const pts = waypoints.map((w) => [w.lng, w.lat]);
  const jobs = ALT_PROFILES.flatMap((prof) => [0, 1, 2].map((idx) => ({ prof, idx })));
  const found = [];
  $('alts').innerHTML = '<li class="small">Finding other ways…</li>';
  const worker = async () => {
    while (jobs.length) {
      const { prof, idx } = jobs.shift();
      try {
        const rt = await brouterRoute(pts, prof, undefined, idx);
        if (seq !== altSeq) return;
        if (!found.some((f) => Math.abs(f.rt.length - rt.length) < 30 && Math.abs(f.rt.ascend - rt.ascend) < 5)) found.push(altStats(prof, idx, rt));
      } catch { /* that profile has no alternative this far */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (seq !== altSeq) return;
  altRoutes = found;
  renderAlts();
  // Popularity arrives a moment later; label again when it does.
  if (typeof scoreRoutes === 'function') {
    await scoreRoutes([route, ...found.map((f) => f.rt)]);
    if (seq === altSeq) renderAlts();
  }
}

map.on('load', () => {
  map.addSource('alts', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'alts', type: 'line', source: 'alts',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#495057', 'line-opacity': 0.55, 'line-width': 4, 'line-dasharray': [1.5, 1] } }, 'route-casing');
  map.addSource('alt-hl', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'alt-hl', type: 'line', source: 'alt-hl',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#495057', 'line-opacity': 0.85, 'line-width': 6 } }, 'route-casing');
});

$('opt-alts').checked = store.get('cp.opt-alts', false);
$('opt-alts').addEventListener('change', () => { store.set('cp.opt-alts', $('opt-alts').checked); altKey = ''; if (route) altHook(); });
// Reload when the points or options change; switching profile or alternative just re-labels the list.
let altKey = '';
function altHook() {
  const key = JSON.stringify([waypoints, getOptions(), typeof nogoParam === 'function' ? nogoParam() : '', typeof dislikedParam === 'function' ? dislikedParam() : '', $('opt-alts').checked]);
  if (key !== altKey) { altKey = key; loadAlternatives(); } else renderAlts();
}
routeHooks.push(altHook);
