'use strict';
/* Loop generator: waypoints on a circle through the start, resized until BRouter's distance matches,
   then filtered and ranked by the switches in the Loop generator section. */

let loopResults = [];
let loopPicked = -1; // index of the loop on the map; the list stays so you can swap
let lastLoop = null; // how the current route was generated, for problem reports
let loopBusy = false;

const lp = (id) => $(id).checked;
// Loops use the same traffic setting as everything else (the one next to the profile).
const quietLoops = () => $('opt-traffic').value === 'avoid';
function fetchRoute(points, profile) { return brouterRoute(points, profile, undefined, 0, {}); }

function circlePoints(start, brg, radius) {
  const centre = destination(start, brg, radius);
  const back = (brg + 180) % 360; // bearing from the centre back to the start
  return [start, ...[90, 180, 270].map((d) => destination(centre, (back + d) % 360, radius)), start];
}

// ---------- snapping waypoints to bike paths ----------
let pathIndex = null; // {key, cells: Map(cell -> [[lng,lat],...])}
const SNAP_CELL = 0.005;
async function loadPathIndex(start, radius) {
  const pad = (radius * 2.6) / 111000;
  const k = Math.cos(start[1] * Math.PI / 180);
  const s = start[1] - pad, n = start[1] + pad, w = start[0] - pad / k, e = start[0] + pad / k;
  const key = [s, w, n, e].map((v) => v.toFixed(2)).join(',');
  if (pathIndex && pathIndex.key === key) return pathIndex;
  const b = `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
  // The server keeps a copy of every bike path around Perth, refreshed every 6 months: instant, no Overpass wait.
  try {
    const res = await fetch(`/api/bikepaths?bbox=${b}`);
    if (res.ok) {
      const d = await res.json();
      if (d.covered) {
        pathIndex = { key, cells: new Map(Object.entries(d.cells)), updated: d.updated };
        return pathIndex;
      }
    }
  } catch { /* fall back to Overpass below */ }
  const data = await overpass(`[out:json][timeout:60];
(
  way["highway"="cycleway"](${b});
  way["highway"~"^(path|footway)$"]["bicycle"="designated"](${b});
);
out skel geom;`);
  const cells = new Map();
  for (const el of data.elements || []) {
    for (const g of el.geometry || []) {
      const ck = `${Math.floor(g.lon / SNAP_CELL)}:${Math.floor(g.lat / SNAP_CELL)}`;
      if (!cells.has(ck)) cells.set(ck, []);
      cells.get(ck).push([g.lon, g.lat]);
    }
  }
  pathIndex = { key, cells };
  return pathIndex;
}
function addLikedToPathIndex() {
  if (!pathIndex || typeof likedVertices !== 'function') return;
  for (const [lng, lat] of likedVertices()) {
    const ck = `${Math.floor(lng / SNAP_CELL)}:${Math.floor(lat / SNAP_CELL)}`;
    if (!pathIndex.cells.has(ck)) pathIndex.cells.set(ck, []);
    pathIndex.cells.get(ck).push([lng, lat]);
  }
}
function snapPoint(p, maxM = 600) {
  if (!pathIndex) return p;
  const cx = Math.floor(p[0] / SNAP_CELL), cy = Math.floor(p[1] / SNAP_CELL);
  let best = null, bestD = maxM;
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
    for (const q of pathIndex.cells.get(`${cx + dx}:${cy + dy}`) || []) {
      const d = haversine(p, q);
      if (d < bestD) { bestD = d; best = q; }
    }
  }
  return best || p;
}

// ---------- how much of a loop rides the same road twice ----------
function repeatShare(rt) {
  const C = 0.00018; // ~20 m
  const first = new Map();
  const start = rt.coords[0];
  let total = 0, rep = 0;
  for (let i = 1; i < rt.coords.length; i++) {
    const a = rt.coords[i - 1], b = rt.coords[i];
    const steps = Math.max(1, Math.round((rt.cum[i] - rt.cum[i - 1]) / 25));
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      const ch = rt.cum[i - 1] + t * (rt.cum[i] - rt.cum[i - 1]);
      if (haversine(p, start) < 400) continue; // leaving and coming home on the same street is fine
      total++;
      const cx = Math.floor(p[0] / C), cy = Math.floor(p[1] / C);
      let seen = false;
      for (let dx = -1; dx <= 1 && !seen; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const f = first.get(`${cx + dx}:${cy + dy}`);
          if (f != null && f < ch - 300) { seen = true; break; }
        }
      }
      if (seen) rep++;
      const key = `${cx}:${cy}`;
      if (!first.has(key)) first.set(key, ch);
    }
  }
  return total ? (100 * rep) / total : 0;
}

// ---------- dead-end spikes ----------
// A loop point that lands in a side street makes the route ride in to touch it and straight back out.
// Measure that spike at each point (how far the way in and the way out run together) ...
function pointAt(rt, m) {
  m = Math.max(0, Math.min(rt.cum[rt.cum.length - 1], m));
  let lo = 0, hi = rt.cum.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rt.cum[mid] <= m) lo = mid; else hi = mid - 1; }
  const i = lo;
  const span = rt.cum[i + 1] - rt.cum[i] || 1, t = (m - rt.cum[i]) / span;
  return [rt.coords[i][0] + t * (rt.coords[i + 1][0] - rt.coords[i][0]), rt.coords[i][1] + t * (rt.coords[i + 1][1] - rt.coords[i][1])];
}
function spikes(rt, pts) {
  const out = [];
  let from = 0;
  for (let n = 1; n < pts.length - 1; n++) {
    const iw = nearestIndex(rt.coords, pts[n], from);
    from = iw;
    let d = 0;
    while (d < 5000 && haversine(pointAt(rt, rt.cum[iw] - d - 10), pointAt(rt, rt.cum[iw] + d + 10)) < 25) d += 10;
    out.push({ n, at: rt.cum[iw], len: d });
  }
  return out;
}
// U-turns anywhere on the route (e.g. riding up a path to a crossing and back down the other side).
function uturns(rt, minLen = 100) {
  const out = [];
  const L = rt.cum[rt.cum.length - 1];
  let s = 50;
  while (s < L - 50) {
    let d = 0;
    while (d < 3000 && haversine(pointAt(rt, s - d - 10), pointAt(rt, s + d + 10)) < 25) d += 10;
    if (d >= minLen) { out.push({ at: s, len: d }); s += d + 50; } else s += 20;
  }
  return out;
}
const uturnMetres = (rt) => uturns(rt).reduce((a, u) => a + u.len, 0);

// ... and move the point back to where its spike leaves the through road, then reroute.
async function trimSpikes(pts, rt, profile, fixed = []) {
  for (let round = 0; round < 2; round++) {
    // A "spike" as long as the way out to the point is really a dead-end road (a valley, a
    // headland): trimming it would pull the point back to the start and collapse the loop.
    const home = pts[0];
    const sp = spikes(rt, pts).filter((s) => s.len > 40 && !fixed.includes(s.n) &&
      s.len < 0.5 * haversine(home, pts[s.n]) && haversine(home, pointAt(rt, s.at - s.len)) > 300);
    if (!sp.length) break;
    pts = pts.slice();
    for (const s of sp) pts[s.n] = pointAt(rt, s.at - s.len);
    rt = await fetchRoute(pts, profile);
  }
  return { pts, rt };
}

// ---------- building one loop ----------
async function routeCircle(start, brg, radius, profile) {
  let pts = circlePoints(start, brg, radius);
  if (lp('lp-snap')) pts = [pts[0], ...pts.slice(1, -1).map((p) => snapPoint(p)), pts[pts.length - 1]];
  return trimSpikes(pts, await fetchRoute(pts, profile), profile);
}

// ---------- loops through a chosen point ----------
// A round loop from the start A that passes through your point B. The loop is drawn around a
// centre C: the radius blends smoothly from |CA| to |CB| so the curve hits both. Moving C off
// the middle of A-B in different directions gives different loops; the further C goes, the
// bigger (and rounder) the loop. (Two side points, as first built, made thin out-and-back
// spikes when B was close to home.)
const THROUGH_DIRS = [0, 45, 90, 135, 180, 225, 270, 315];

function throughPoints(A, B, dir, d) {
  const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  const C = d > 0 ? destination(M, dir, d) : M;
  const tA = bearing(C, A), tB = bearing(C, B), rA = haversine(C, A), rB = haversine(C, B);
  const span = (tB - tA + 360) % 360; // clockwise from A to B
  const ease = (t) => (1 - Math.cos(Math.PI * t)) / 2;
  const at = (phi) => { // phi: degrees clockwise from A
    const r = phi <= span ? rA + (rB - rA) * ease(phi / (span || 1)) : rB + (rA - rB) * ease((phi - span) / (360 - span || 1));
    return destination(C, (tA + phi) % 360, r);
  };
  const out = [A];
  let bIndex = -1;
  for (const phi of [90, 180, 270]) {
    if (bIndex < 0 && phi > span) { out.push(B); bIndex = out.length - 1; }
    if (Math.abs(phi - span) > 35) out.push(at(phi));
  }
  if (bIndex < 0) { out.push(B); bIndex = out.length - 1; }
  out.push(A);
  return { pts: out, bIndex };
}
// A to B instead of a loop: just the first half, from the start round to your point.
let loopOneWay = false;
function throughShape(A, B, dir, d) {
  const r = throughPoints(A, B, dir, d);
  return loopOneWay ? { pts: r.pts.slice(0, r.bIndex + 1), bIndex: r.bIndex } : r;
}
function pathLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += haversine(pts[i - 1], pts[i]); return L; }
// How far to move the centre so the straight-line loop is this long (bisect; length grows with d).
function offsetFor(A, B, dir, len) {
  let lo = 0, hi = Math.max(len, 1000);
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (pathLength(throughShape(A, B, dir, mid).pts) < len) lo = mid; else hi = mid; }
  return lo;
}
// Shortest sensible loop through B, with some slack so the loops can differ from each other.
const minThroughKm = (A, B) => (pathLength(throughShape(A, B, 0, 0).pts) * 1.3 * 1.15) / 1000;
async function routeThrough(A, B, dir, d, profile) {
  let { pts, bIndex } = throughShape(A, B, dir, d);
  if (lp('lp-snap')) pts = pts.map((p, i) => (i > 0 && i < pts.length - 1 && i !== bIndex ? snapPoint(p) : p));
  const l = await trimSpikes(pts, await fetchRoute(pts, profile), profile, [bIndex]);
  l.bIndex = bIndex;
  return l;
}
// What a loop is measured against: its distance, or (when you set a time) its ride time from the
// pace model, expressed as "metres at the speed the target assumes" so all the sizing maths works unchanged.
let loopMeasure = (rt) => rt.length;
function rideSeconds(rt) {
  const m = typeof modelRide === 'function' ? modelRide(rt) : null;
  return m ? m.hours * 3600 : rt.length / (planSpeedKmh() / 3.6);
}
// Speed for turning a time into a starting distance: your FTP % on the flat (a little off for
// junctions and the odd hill). Loops are then sized on their real modelled time.
function planSpeedKmh() { return flatKmh(); }

async function makeThroughLoop(A, B, dir, target, profile) {
  let len = target / stretchNow(throughStretch); // roads are ~30% longer than straight lines
  let best = null;
  const badness = (x) => x.err * 100 + (lp('lp-noback') ? x.repeat : 0) + x.uturn / 20;
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = offsetFor(A, B, dir, len);
    const l = await routeThrough(A, B, dir, d, profile);
    l.err = Math.abs(loopMeasure(l.rt) - target) / target;
    l.repeat = repeatShare(l.rt);
    l.uturn = uturnMetres(l.rt);
    l.brg = bearing(A, l.pts[1]);
    l.through = true;
    if (!best || badness(l) < badness(best)) best = l;
    if (l.err < 0.07) throughStretch.push(loopMeasure(l.rt) / pathLength(l.pts));
    if (l.err < 0.07 || (d === 0 && loopMeasure(l.rt) > target)) break;
    len *= target / loopMeasure(l.rt);
  }
  return best;
}

// How much longer the roads are than the circle drawn for them. Starts at 30% and learns from
// each loop as it finishes, so later directions usually land on the distance first time.
let loopStretch = [], throughStretch = [];
const stretchNow = (list = loopStretch) => {
  if (!list.length) return 1.3;
  const s = [...list].sort((a, b) => a - b);
  return Math.min(2.2, Math.max(1.05, s[s.length >> 1]));
};

async function makeLoop(start, brg, target, profile) {
  let radius = target / (2 * Math.PI * stretchNow());
  let best = null;
  const badness = (x) => x.err * 100 + (lp('lp-noback') ? x.repeat : 0) + x.uturn / 20;
  const tried = new Set(); // turned circles already routed (doubling back and U-turns share some)
  const consider = (c, b) => {
    c.err = Math.abs(loopMeasure(c.rt) - target) / target;
    c.repeat = repeatShare(c.rt);
    c.uturn = uturnMetres(c.rt);
    c.brg = b;
    if (!best || badness(c) < badness(best)) best = c;
  };
  const turned = async (turn) => {
    const b = (brg + turn + 360) % 360;
    if (tried.has(b)) return;
    tried.add(b);
    try { consider(await routeCircle(start, b, radius, profile), b); }
    catch { /* that variation hit the sea or similar */ }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await routeCircle(start, brg, radius, profile);
    consider(c, brg);
    const ratio = loopMeasure(c.rt) / (2 * Math.PI * radius);
    if (c.err < 0.07) { loopStretch.push(ratio); break; }
    radius *= target / loopMeasure(c.rt);
  }
  tried.add(brg);
  // Doubling back: try the circle turned a little either way.
  if (lp('lp-noback') && best.repeat > 12) {
    for (const turn of [25, -25]) { if (best.repeat > 12) await turned(turn); }
  }
  // U-turns: try the circle turned a little each way and keep the cleanest. A short one
  // (under 200 m) only gets the two small turns; it's not worth four more routes.
  for (const turn of [12, -12, 25, -25]) {
    if (best.uturn === 0 || (Math.abs(turn) === 25 && best.uturn < 200)) continue;
    await turned(turn);
  }
  return best;
}

function mainRoadPct(rt) {
  let main = 0;
  for (const s of rt.segs) if (wayClass(s.tags) === 'main') main += rt.cum[s.i1] - rt.cum[s.i0];
  return (100 * main) / (rt.length || 1);
}

// ---------- ranking ----------
function loopScore(l) {
  let s = l.err * 100;
  if (quietLoops()) s += l.mainPct * 0.3;
  if (lp('lp-noback')) s += l.repeat * 0.5;
  s += l.uturn / 20; // every 100 m of U-turn costs as much as 5% off the target distance
  if (lp('lp-climb')) { const t = +$('lp-climb-m').value || 400; s += (Math.abs(l.rt.ascend - t) / t) * 40; }
  const nov = $('lp-novelty').value;
  if (nov !== 'off' && l.newPct != null) s += (nov === 'new' ? -1 : 1) * l.newPct * 0.3;
  if (l.wind) s += l.wind.second * 0.5;
  if (l.interval) s -= Math.min(l.interval.mins, 30) * 0.5;
  if (l.liked) s -= l.liked.pct * 0.3; // more of your liked roads ranks higher
  return s;
}

function showLoopPreview(highlight = -1) {
  const src = map.getSource('loops');
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    // Once one is picked, only show another when you hover it.
    features: loopResults.map((l, k) => ({
      type: 'Feature', properties: { hl: k === highlight ? 1 : 0 },
      geometry: { type: 'LineString', coordinates: l.rt.coords.map((c) => [c[0], c[1]]) },
    })).filter((f, k) => loopPicked < 0 || (k === highlight && k !== loopPicked)),
  });
  const iv = map.getSource('loop-interval');
  if (iv) {
    const l = loopResults[highlight];
    iv.setData(l && l.interval
      ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l.rt.coords.slice(l.interval.i0, l.interval.i1 + 1).map((c) => [c[0], c[1]]) } }
      : emptyFC());
  }
}

function renderLoops() {
  const ul = $('loops');
  ul.innerHTML = '';
  loopResults.forEach((l, k) => {
    const li = document.createElement('li');
    if (k === loopPicked) li.classList.add('picked');
    const lines = [
      `<div class="head">${l.through ? (loopOneWay ? `Via the ${compass(l.brg)} side` : `Out via the ${compass(l.brg)} side`) : `Heads ${compass(l.brg)}`}</div>`,
      `<div>${fmtDuration(rideSeconds(l.rt) / 3600)} ride time</div>`,
      `<div>${Math.round(l.rt.ascend)} m up</div>`,
      `<div>${Math.round(l.mainPct)}% main road</div>`,
    ];
    if (l.repeat >= 3) lines.push(`<div>${Math.round(l.repeat)}% ridden twice</div>`);
    if (l.uturn) lines.push(`<div><span class="badge warn">${l.uturn} m of U-turns</span></div>`);
    if (l.newPct != null) lines.push(`<div>${Math.round(l.newPct)}% roads you haven't ridden</div>`);
    if (l.interval) lines.push(`<div>${l.interval.mins} min interval stretch</div>`);
    if (l.liked && l.liked.pct >= 1) lines.push(`<div>${Math.round(l.liked.pct)}% roads you like</div>`);
    if (l.wind) {
      const w = fmtWind(l.wind.second).replace('wind', 'wind home');
      lines.push(`<div class="${/tail/.test(w) ? 'wind-good' : /head/.test(w) ? 'wind-bad' : ''}">${w}</div>`);
    }
    li.innerHTML = `<span class="km">${fmtKm(l.rt.length)}<small>km</small>${k === 0 ? '<span class="tag">best match</span>' : ''}</span>` +
      `<div class="facts">${lines.join('')}</div>`;
    li.onmouseenter = () => showLoopPreview(k);
    li.onmouseleave = () => showLoopPreview(-1);
    li.onclick = () => {
      loopPicked = k;
      renderLoops();
      showLoopPreview();
      $('loop-status').textContent = 'Tap another loop to swap. Generate again for new ones.';
      const last = l.pts.length - 1;
      // The point you chose to loop through stays exactly where you put it.
      setWaypoints(l.pts.map(([lng, lat], i) => (i > 0 && i < last && !(l.through && i === l.bIndex) ? { lng, lat, auto: true } : { lng, lat })), { fit: true });
      lastLoop = {
        targetKm: +$('loop-km').value, targetTime: loopMode === 'time' ? $('loop-hrs').value : null, oneWay: loopOneWay, heading: compass(l.brg), bearing: l.brg, rank: k + 1,
        switches: Object.fromEntries(['lp-noback', 'lp-snap', 'lp-climb', 'lp-interval', 'lp-through'].map((id) => [id, lp(id)])),
        traffic: $('opt-traffic').value,
        climbTarget: +$('lp-climb-m').value, intervalMin: +$('eff-min').value, intervalTerrain: $('eff-terrain').value, novelty: $('lp-novelty').value,
        stats: { km: +fmtKm(l.rt.length), up: Math.round(l.rt.ascend), mainPct: Math.round(l.mainPct), repeatPct: Math.round(l.repeat), uturnM: l.uturn, newPct: l.newPct == null ? null : Math.round(l.newPct) },
        waypoints: l.pts,
      };
    };
    ul.appendChild(li);
  });
}

// ---------- progress while it works ----------
const loopProg = { t0: 0, timer: null, step: '', done: 0, total: 0, found: 0, active: new Set() };
function progShow(on) {
  const box = $('loop-progress');
  box.hidden = !on;
  $('loop-go').textContent = on ? 'Making loops…' : 'Make loops';
  clearInterval(loopProg.timer);
  if (!on && loopProg.step) { progStep(''); loopTimings.push(['total', Math.round((Date.now() - loopProg.t0) / 1000)]); }
  if (on) {
    Object.assign(loopProg, { t0: Date.now(), step: 'Starting…', stepT: Date.now(), done: 0, total: 0, found: 0 });
    loopTimings = [];
    loopProg.active.clear();
    loopProg.timer = setInterval(progRender, 500);
    progRender();
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
function progStep(text) {
  const now = Date.now();
  if (loopProg.step && loopProg.stepT) loopTimings.push([loopProg.step, Math.round((now - loopProg.stepT) / 1000)]);
  loopProg.step = text; loopProg.stepT = now;
  progRender();
}
let loopTimings = []; // [step, seconds], sent with problem reports
function progRender() {
  const p = loopProg, secs = Math.round((Date.now() - p.t0) / 1000);
  const dirs = [...p.active].map((b) => (typeof b === 'number' ? compass(b) : '')).filter(Boolean);
  const step = p.total && p.done < p.total && dirs.length ? `Routing loops heading ${dirs.join(', ')}…` : p.step;
  $('loop-progress').innerHTML = `<div class="lp-step"><span class="spinner"></span>${escapeHtml(step)}</div>` +
    (p.total ? `<div class="dl-bar"><div style="width:${((100 * p.done) / p.total).toFixed(0)}%"></div></div>` +
      `<div class="small">${p.done} of ${p.total} directions tried · ${p.found} loop${p.found === 1 ? '' : 's'} so far · ${secs} s</div>` :
      `<div class="small">${secs} s</div>`);
}

// Rank, drop near-copies and long U-turns, keep the best six. Used for the list as loops come in
// and for the final one (which may first be cut down to loops with an interval stretch).
function shortlist(list, final = false) {
  for (const l of list) {
    if (l.mainPct == null) l.mainPct = mainRoadPct(l.rt);
    if (l.newPct === undefined) l.newPct = typeof newRoadShare === 'function' ? newRoadShare(l.rt) : null;
    if (l.liked === undefined) l.liked = typeof likedShare === 'function' ? likedShare(l.rt) : null;
  }
  if (!final) { const close = list.filter((l) => l.err < 0.25); if (close.length) list = close; }
  list = [...list].sort((a, b) => loopScore(a) - loopScore(b));
  // Drop near-copies (common when every direction ends up on the same roads)...
  const distinct = [];
  for (const l of list) if (!distinct.some((d) => sameRoute(d.rt, l.rt))) distinct.push(l);
  // ...and loops with long U-turns when there are enough clean ones.
  const clean = distinct.filter((l) => l.uturn < 500);
  return (clean.length >= 3 ? clean : distinct).slice(0, 6);
}

async function generateLoops() {
  if (loopBusy) return;
  loopBusy = true;
  const km = +$('loop-km').value || 50;
  store.set('cp.loopkm', km);
  // Target by time: size loops by the ride time from your FTP % (or speed), hills and wind included.
  const byTime = loopMode === 'time' && parseDuration($('loop-hrs').value) > 0;
  const targetSecs = byTime ? parseDuration($('loop-hrs').value) : null;
  const target = byTime ? targetSecs * (planSpeedKmh() / 3.6) : km * 1000; // metres, or "metres at your usual speed"
  loopMeasure = byTime ? (rt) => rideSeconds(rt) * (target / targetSecs) : (rt) => rt.length;
  loopOneWay = lp('lp-through') && lp('lp-oneway');
  const start = waypoints.length ? [waypoints[0].lng, waypoints[0].lat] : [map.getCenter().lng, map.getCenter().lat];
  const profile = $('profile').value;
  const st = $('loop-status');
  $('loop-go').disabled = true;
  progShow(true);
  progStep('Checking map data for this area…');
  loopResults = [];
  loopPicked = -1;
  renderLoops();
  showLoopPreview();
  try {
    try {
      const miss = await missingTiles([start]);
      if (miss.length) { progShow(false); offerRegions([start]); st.textContent = 'This area needs downloading first (see the message at the top).'; return; }
    } catch { /* can't tell: try anyway */ }
    // The forecast loads in the background; loops are turned to suit the wind once it arrives.
    const windReady = loadWind(start[0], start[1]).catch(() => null);
    const windKey = `${start[1].toFixed(1)},${start[0].toFixed(1)}`;
    const windHere = () => wind && wind.key === windKey; // not a forecast left over from somewhere else
    if (lp('lp-snap')) {
      st.textContent = '';
      progStep('Looking up bike paths to snap to…');
      try { await loadPathIndex(start, target / (2 * Math.PI)); } catch { pathIndex = { key: '', cells: new Map() }; }
      addLikedToPathIndex(); // liked roads count as paths to snap to
    }
    let note = '';
    // With a second point and "through my point" on, every loop goes out to that point and back another way.
    // (Points a generated loop placed don't count, so you can regenerate after picking one.)
    const own = waypoints.slice(1).find((w) => !w.auto && haversine(start, [w.lng, w.lat]) > 30);
    const B = lp('lp-through') && own ? [own.lng, own.lat] : null;
    if (loopOneWay && !B) { st.textContent = 'Put down a second point to finish at, or untick "Finish there".'; return; }
    if (B && haversine(start, B) < 300) { st.textContent = 'Your second point is too close to the start. Move it, or untick "Loop through my second point".'; return; }
    if (B && minThroughKm(start, B) * 1000 > target) {
      const what = loopOneWay ? 'routes there' : 'loops through it';
      if (byTime) note = `Your point is ${fmtKm(haversine(start, B))} km away, so ${what} take longer than you asked.`;
      else {
        $('loop-km').value = Math.ceil(minThroughKm(start, B) / 5) * 5;
        note = `Your point is ${fmtKm(haversine(start, B))} km away, so ${what} are about ${$('loop-km').value} km.`;
      }
    }
    const tgt = B ? Math.max(target, minThroughKm(start, B) * 1000) : target;
    const bearings = B ? THROUGH_DIRS : lp('lp-climb') ? [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] : [0, 45, 90, 135, 180, 225, 270, 315];
    const found = [];
    let done = 0;
    loopStretch = []; throughStretch = [];
    loopProg.total = bearings.length;
    progStep('Routing loops');
    // Loops appear in the list as they're found, so you can look at (and pick) one while the rest
    // are still being worked out. The final list is ranked once everything is in.
    let shownOnce = false;
    const showSoFar = () => {
      if (!found.length) return;
      const picked = loopResults[loopPicked];
      loopResults = shortlist(found);
      loopPicked = picked ? loopResults.indexOf(picked) : -1;
      if (picked && loopPicked < 0) { loopResults.push(picked); loopPicked = loopResults.length - 1; }
      renderLoops();
      showLoopPreview();
      if (!shownOnce && loopPicked < 0) {
        shownOnce = true;
        const b = new maplibregl.LngLatBounds();
        const r = (B ? haversine(start, B) : tgt / (2 * Math.PI * 1.3)) * 2;
        [0, 90, 180, 270].forEach((d) => b.extend(destination(start, d, r)));
        map.fitBounds(b, { padding: 50 });
      }
    };
    const queue = [...bearings];
    const worker = async () => {
      while (queue.length) {
        const brg = queue.shift();
        loopProg.active.add(brg); progRender();
        try {
          const l = B ? await makeThroughLoop(start, B, brg, tgt, profile) : await makeLoop(start, brg, target, profile);
          if (windHere() && !loopOneWay) await windTurn(l);
          if (l.err < 0.4 && l.rt.length > 1000) { found.push(l); showSoFar(); }
        } catch { /* usually a circle point out at sea */ }
        done++;
        loopProg.active.delete(brg);
        loopProg.done = done; loopProg.found = found.length;
        progRender();
      }
    };
    // Ride each loop whichever way puts the wind behind you on the way home.
    async function windTurn(l) {
      const fwd = windStats(l.rt), rev = windStats(l.rt, true);
      if (rev.second < fwd.second - 1) {
        l.pts = [...l.pts].reverse();
        l.rt = await fetchRoute(l.pts, profile);
        if (l.through) l.bIndex = l.pts.length - 1 - l.bIndex;
        l.err = Math.abs(loopMeasure(l.rt) - tgt) / tgt;
        delete l.mainPct; delete l.newPct; delete l.liked; // facts about the old direction
        l.wind = windStats(l.rt);
      } else l.wind = fwd;
    }
    // BRouter runs four routes at once (MAX_THREADS) and kills the oldest if a fifth arrives:
    // three here leaves one for your own route while you look at loops that are already in.
    await Promise.all([worker(), worker(), worker()]);
    // Loops routed before the forecast arrived: if it failed, ask once more, then turn them.
    // (A loop you've already picked stays the way you picked it.)
    const late = loopOneWay ? [] : found.filter((l) => !l.wind && l !== loopResults[loopPicked]);
    if (late.length) {
      if (!windHere()) {
        progStep('Waiting a moment for the wind forecast…');
        const wait = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('slow'), ms))]);
        // Still on its way: give it a few seconds. Already failed: try once more.
        if ((await wait(windReady, 5000)) === null) await wait(loadWind(start[0], start[1]).catch(() => null), 15000);
      }
      if (windHere()) {
        progStep('Turning loops to put the wind behind you on the way home…');
        await Promise.all(late.map((l) => windTurn(l).catch(() => {})));
      } else note = (note ? note + ' ' : '') + "The wind forecast didn't load, so loops aren't turned for the wind.";
    }

    progStep(`Ranking ${found.length} loops…`);
    // Prefer loops within 25% of the distance; only fall back to looser ones if that leaves too few.
    const close = found.filter((l) => l.err < 0.25);
    let list = close.length >= 3 ? close : found;
    if (list.length && close.length < 3 && found.length > close.length) note = (note ? note + ' ' : '') + 'Few loops fit that distance here, so some are further off it.';
    if (lp('lp-interval') && found.length) {
      progStep('Checking lights and crossings for interval stretches…');
      const mins = +$('eff-min').value || 8, terrain = $('eff-terrain').value; // one setting, under Interval stretches
      try {
        // One lookup covering every loop.
        const nodes = await routeNodes({ coords: found.flatMap((l) => l.rt.coords.filter((_, i) => i % 10 === 0)) });
        for (const l of found) {
          const s = findStretches(l.rt, interruptions(l.rt, nodes), mins * 60 * riderSpeedMs(), terrain)[0];
          if (s) l.interval = { ...s, mins: Math.round(s.len / riderSpeedMs() / 60) };
        }
        list = found.filter((l) => l.interval);
        if (!list.length) note = `None of the loops has an uninterrupted ${mins} min stretch. Try a shorter interval or a longer loop.`;
      } catch (e) { note = 'Could not check interval stretches: ' + e.message; list = found; }
    }
    const picked = loopResults[loopPicked];
    loopResults = shortlist(list, true);
    loopPicked = picked ? loopResults.indexOf(picked) : -1;
    renderLoops();
    showLoopPreview();
    if (loopResults.length) {
      if (loopPicked < 0) {
        const b = new maplibregl.LngLatBounds();
        loopResults.forEach((l) => l.rt.coords.forEach((c) => b.extend([c[0], c[1]])));
        map.fitBounds(b, { padding: 50 });
      }
      st.textContent = (note ? note + ' ' : '') + `${loopResults.length} ${loopOneWay ? "routes" : "loops"}, best match first. Hover to highlight one, tap to use it.`;
    } else {
      st.textContent = note || 'No loops found. The roads around here may be mostly dead ends (hills, coast or water). Try a longer distance, or put down a second point to loop through.';
    }
  } finally {
    loopBusy = false;
    $('loop-go').disabled = false;
    progShow(false);
  }
}

// Distance or time: whichever box you typed in last is the target; the other shows the estimate.
let loopMode = store.get('cp.loopmode', 'km');
function parseDuration(s) { // "2:30", "2.5", "150m" -> seconds
  s = String(s || '').trim();
  let m = /^(\d+):(\d{1,2})$/.exec(s);
  if (m) return (+m[1] * 60 + +m[2]) * 60;
  m = /^(\d+)\s*m(in)?$/.exec(s);
  if (m) return +m[1] * 60;
  const h = parseFloat(s);
  return h > 0 ? h * 3600 : 0;
}
const hhmm = (secs) => { const m = Math.round(secs / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
function updateLoopTime() {
  const v = planSpeedKmh();
  if (loopMode === 'time') {
    const secs = parseDuration($('loop-hrs').value);
    if (secs) $('loop-km').value = Math.max(5, Math.round((secs / 3600) * v));
  } else {
    const km = +$('loop-km').value || 0;
    if (km) $('loop-hrs').value = hhmm((km / v) * 3600);
  }
  $('loop-km').classList.toggle('est', loopMode === 'time');
  $('loop-hrs').classList.toggle('est', loopMode !== 'time');
  $('loop-time').textContent = loopMode === 'time' ? 'Sized by ride time (hills and wind included).' : '';
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
  map.addSource('loop-interval', { type: 'geojson', data: emptyFC() });
  map.addLayer({ id: 'loop-interval', type: 'line', source: 'loop-interval',
    layout: { 'line-cap': 'round' }, paint: { 'line-color': '#fcc419', 'line-width': 12, 'line-opacity': 0.8 } }, 'loops');
});

// Remember the loop switches.
for (const id of ['lp-noback', 'lp-snap', 'lp-climb', 'lp-interval', 'lp-through', 'lp-oneway']) {
  $(id).checked = store.get('cp.' + id, $(id).checked);
  $(id).addEventListener('change', () => store.set('cp.' + id, $(id).checked));
}
for (const id of ['lp-climb-m', 'lp-novelty']) {
  $(id).value = store.get('cp.' + id, $(id).value);
  $(id).addEventListener('change', () => store.set('cp.' + id, $(id).value));
}
$('loop-km').value = store.get('cp.loopkm', 50);
$('loop-hrs').value = store.get('cp.loophrs', '');
updateLoopTime();
$('loop-km').addEventListener('input', () => { loopMode = 'km'; store.set('cp.loopmode', 'km'); updateLoopTime(); });
$('loop-hrs').addEventListener('input', () => { loopMode = 'time'; store.set('cp.loopmode', 'time'); store.set('cp.loophrs', $('loop-hrs').value); updateLoopTime(); });
$('pace-pct').addEventListener('change', updateLoopTime); // also fired once your FTP arrives
$('loop-go').onclick = generateLoops;

// The interval switch uses the length and terrain set under Interval stretches: say what they are.
function renderIntervalRule() {
  const t = { flat: 'flat', any: 'any terrain', climb: 'climbs' }[$('eff-terrain').value] || $('eff-terrain').value;
  $('lp-interval-rule').textContent = `at least ${+$('eff-min').value || 8} min, ${t}`;
}
['eff-min', 'eff-terrain'].forEach((id) => $(id).addEventListener('change', renderIntervalRule));
renderIntervalRule();
