'use strict';
/* Ride time from your power: FTP and weight from intervals.icu, a % of FTP you choose,
   and a standard road-bike physics model over every ~100 m of the route (gradient and forecast wind). */

const BIKE_KG = 9, CDA = 0.32, CRR = 0.0045, RHO = 1.2, DRIVETRAIN = 0.97, G = 9.81;
const MAX_DESCENT_KMH = 50; // you brake on the way down
// Your FTP and weight come from intervals.icu through the server, which keeps the last values it
// got. This browser keeps a copy too, so the right numbers are there from the first moment, even
// if the server can't be reached. Only if neither has ever had them is a typical rider assumed.
const DEFAULT_ATHLETE = { ftp: 200, weight: 75, assumed: true };
let athlete = store.get('cp.athlete', null) || DEFAULT_ATHLETE; // {ftp, weight, updated, stale}

function pacePower() { return (athlete.ftp * (+$('pace-pct').value || 65)) / 100; }
function powerMode() { return true; } // ride time always comes from power now (kept for older callers)
// Steady speed on flat, still air at your % of FTP, less a little for junctions and the odd hill.
// Used wherever a single speed is needed before a route's own modelled time is known.
function flatKmh() { return speedFor(pacePower(), 0, 0, athlete.weight + BIKE_KG) * 3.6 * 0.92; }

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
  if (!rt || rt.coords[0].length < 3) return null;
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
  const at = `${Math.round(pacePower())} W, about ${Math.round(flatKmh())} km/h on the flat`;
  $('pace-power').title = athlete.assumed
    ? `intervals.icu has never been reached, so this assumes ${athlete.ftp} W FTP and ${athlete.weight} kg: ${at}`
    : `${athlete.ftp} W FTP, ${athlete.weight} kg + ${BIKE_KG} kg bike: ${at}.` +
      (athlete.stale ? ` intervals.icu can't be reached right now, so these are the last values it gave${athlete.updated ? ` (${athlete.updated})` : ''}.` : '');
}

function paceChanged() {
  renderPaceUi();
  renderStats();
  $('pace-pct').dispatchEvent(new Event('change')); // wind, interval stretches and loops follow the new pace
}

$('pace-pct').value = store.get('cp.pacepct', 65);
$('pace-pct').addEventListener('input', () => { store.set('cp.pacepct', +$('pace-pct').value); paceChanged(); });
routeHooks.push(() => renderStats()); // re-run once the wind forecast for this route has loaded

// Check now, then hourly: a new FTP or weight on intervals.icu updates the saved values.
async function loadAthlete() {
  try {
    const res = await fetch('/api/athlete');
    if (!res.ok) throw new Error();
    const a = await res.json();
    if (a && a.ftp && a.weight) {
      athlete = a;
      store.set('cp.athlete', { ftp: a.ftp, weight: a.weight, updated: a.updated });
    }
  } catch {
    // Server unreachable: keep what this browser last saw, marked as not current.
    if (!athlete.assumed) athlete = { ...athlete, stale: true };
  }
  paceChanged();
}
loadAthlete();
setInterval(loadAthlete, 3600 * 1000);
