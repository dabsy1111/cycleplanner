'use strict';
/* Ride time from your power: FTP and weight from intervals.icu, a % of FTP you choose,
   and a standard road-bike physics model over every ~100 m of the route (gradient and forecast wind). */

const BIKE_KG = 9, CDA = 0.32, CRR = 0.0045, RHO = 1.2, DRIVETRAIN = 0.97, G = 9.81;
const MAX_DESCENT_KMH = 50; // you brake on the way down
let athlete = null;          // {ftp, weight}

function pacePower() { return athlete ? (athlete.ftp * (+$('pace-pct').value || 65)) / 100 : null; }
function powerMode() { return !!athlete && store.get('cp.pacemode', 'power') === 'power'; }

// Speed (m/s) holding power P on gradient `grade` (fraction) into headwind `wind` (m/s, negative = tailwind).
function speedFor(P, grade, wind, mass) {
  const th = Math.atan(grade);
  const resist = (v) => {
    const air = v + wind;
    return (CRR * mass * G * Math.cos(th) + mass * G * Math.sin(th)) * v + 0.5 * RHO * CDA * air * Math.abs(air) * v;
  };
  const Pw = P * DRIVETRAIN;
  let lo = 0.3, hi = MAX_DESCENT_KMH / 3.6;
  if (resist(hi) < Pw) return hi;
  for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (resist(mid) < Pw) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

function modelRide(rt) {
  if (!powerMode() || !rt || rt.coords[0].length < 3) return null;
  const P = pacePower(), mass = athlete.weight + BIKE_KG;
  const dep = typeof departureMs === 'function' ? departureMs() : Date.now();
  const r = Math.PI / 180;
  let secs = 0;
  for (const p of routePieces(rt, 100)) {
    const len = rt.cum[p.i1] - rt.cum[p.i0];
    if (!len) continue;
    const grade = ((rt.coords[p.i1][2] ?? 0) - (rt.coords[p.i0][2] ?? 0)) / len;
    let head = 0;
    if (typeof windAt === 'function' && typeof wind !== 'undefined' && wind) {
      const w = windAt(dep + secs * 1000);
      head = (w.speed / 3.6) * Math.cos((w.dir - bearing(rt.coords[p.i0], rt.coords[p.i1])) * r);
    }
    secs += len / speedFor(P, Math.max(-0.25, Math.min(0.25, grade)), head, mass);
  }
  return { hours: secs / 3600, avgKmh: (rt.length / 1000) / (secs / 3600) };
}

function renderPaceUi() {
  const on = powerMode();
  $('pace-flat').hidden = on;
  $('pace-power').hidden = !on;
  $('pace-switch').hidden = !athlete;
  $('pace-switch').textContent = on ? 'use speed' : 'use FTP';
  if (athlete) {
    $('pace-power').title = `${Math.round(pacePower())} W of your ${athlete.ftp} W FTP, ${athlete.weight} kg + ${BIKE_KG} kg bike`;
  }
}

function paceChanged() {
  renderPaceUi();
  renderStats();
  $('speed').dispatchEvent(new Event('change')); // wind, interval stretches and loops follow the new speed
}

$('pace-pct').value = store.get('cp.pacepct', 65);
$('pace-pct').addEventListener('input', () => { store.set('cp.pacepct', +$('pace-pct').value); paceChanged(); });
$('pace-switch').onclick = () => { store.set('cp.pacemode', powerMode() ? 'speed' : 'power'); paceChanged(); };
routeHooks.push(() => renderStats()); // re-run once the wind forecast for this route has loaded

(async () => {
  try {
    const res = await fetch('/api/athlete');
    if (!res.ok) throw new Error();
    const a = await res.json();
    if (a && a.ftp && a.weight) athlete = a;
  } catch { athlete = null; }
  renderPaceUi();
  if (athlete) renderStats();
})();
