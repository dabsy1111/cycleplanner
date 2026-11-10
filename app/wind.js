'use strict';
/* Wind: Open-Meteo hourly forecast, headwind along the route, and which way to ride a loop. */

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

let wind = null;        // {key, fetched, times:[ms], speed:[], dir:[], gust:[]}
let windPending = null;

function defaultDeparture() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}
$('wind-time').value = defaultDeparture();
function departureMs() { const t = Date.parse($('wind-time').value); return Number.isFinite(t) ? t : Date.now(); }

async function loadWind(lng, lat) {
  const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
  if (wind && wind.key === key && Date.now() - wind.fetched < 30 * 60e3) return wind;
  if (windPending && windPending.key === key) return windPending.p;
  const params = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lng.toFixed(3),
    hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'kmh', timezone: 'auto', past_days: '1', forecast_days: '7',
  });
  const p = fetch(`${OPEN_METEO}?${params}`).then((r) => {
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    return r.json();
  }).then((j) => {
    const off = (j.utc_offset_seconds || 0) * 1000;
    wind = {
      key, fetched: Date.now(),
      times: j.hourly.time.map((t) => Date.parse(t + 'Z') - off),
      speed: j.hourly.wind_speed_10m, dir: j.hourly.wind_direction_10m, gust: j.hourly.wind_gusts_10m,
    };
    return wind;
  }).finally(() => { windPending = null; });
  windPending = { key, p };
  return p;
}

// Wind at a moment, interpolated between hours (direction via vector components). dir = where it blows FROM.
function windAt(ms) {
  if (!wind) return null;
  const t = wind.times;
  if (ms <= t[0]) return { speed: wind.speed[0], dir: wind.dir[0], gust: wind.gust[0] };
  if (ms >= t[t.length - 1]) { const n = t.length - 1; return { speed: wind.speed[n], dir: wind.dir[n], gust: wind.gust[n] }; }
  let i = 0;
  while (t[i + 1] < ms) i++;
  const f = (ms - t[i]) / (t[i + 1] - t[i]);
  const r = Math.PI / 180;
  const vx = (1 - f) * wind.speed[i] * Math.sin(wind.dir[i] * r) + f * wind.speed[i + 1] * Math.sin(wind.dir[i + 1] * r);
  const vy = (1 - f) * wind.speed[i] * Math.cos(wind.dir[i] * r) + f * wind.speed[i + 1] * Math.cos(wind.dir[i + 1] * r);
  return {
    speed: Math.hypot(vx, vy),
    dir: (Math.atan2(vx, vy) / r + 360) % 360,
    gust: (1 - f) * wind.gust[i] + f * wind.gust[i + 1],
  };
}

function riderSpeedMs() { return Math.max(5, +$('speed').value || 27) / 3.6; }

// Headwind (km/h, + = into the wind) for each ~150 m piece, given departure time and rider speed.
function windPieces(rt, reversed = false) {
  if (!wind) return null;
  const dep = departureMs(), v = riderSpeedMs(), L = rt.cum[rt.cum.length - 1];
  const r = Math.PI / 180;
  return routePieces(rt).map((p) => {
    let brg = bearing(rt.coords[p.i0], rt.coords[p.i1]);
    let mid = (rt.cum[p.i0] + rt.cum[p.i1]) / 2;
    if (reversed) { brg = (brg + 180) % 360; mid = L - mid; }
    const w = windAt(dep + (mid / v) * 1000);
    return { ...p, len: rt.cum[p.i1] - rt.cum[p.i0], at: mid, head: w.speed * Math.cos((w.dir - brg) * r) };
  });
}

function windStats(rt, reversed = false) {
  const pcs = windPieces(rt, reversed);
  if (!pcs) return null;
  const L = rt.cum[rt.cum.length - 1] || 1;
  let all = 0, first = 0, second = 0, l1 = 0, l2 = 0, into = 0;
  for (const p of pcs) {
    all += p.head * p.len;
    if (p.at < L / 2) { first += p.head * p.len; l1 += p.len; } else { second += p.head * p.len; l2 += p.len; }
    if (p.head > 5) into += p.len;
  }
  return { avg: all / L, first: l1 ? first / l1 : 0, second: l2 ? second / l2 : 0, intoPct: (100 * into) / L };
}

function isLoop(rt) {
  const a = rt.coords[0], b = rt.coords[rt.coords.length - 1];
  return haversine(a, b) < 500;
}

const fmtWind = (h) => `${h >= 0 ? 'headwind' : 'tailwind'} ${Math.abs(h).toFixed(0)} km/h`;

function renderWind() {
  const el = $('wind-summary'), btn = $('wind-reverse');
  btn.hidden = true;
  if (!wind) { el.innerHTML = '<p>Wind forecast unavailable.</p>'; return; }
  const dep = departureMs();
  const w = windAt(dep);
  updateWindBadge(w, dep);
  if (!route) { el.innerHTML = `<p>${compass(w.dir)} ${w.speed.toFixed(0)} km/h, gusts ${w.gust.toFixed(0)}, at ${new Date(dep).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.</p>`; return; }
  const s = windStats(route);
  const finish = windAt(dep + (route.length / riderSpeedMs()) * 1000);
  let html = `<p>${compass(w.dir)} ${w.speed.toFixed(0)} km/h at the start, ${compass(finish.dir)} ${finish.speed.toFixed(0)} km/h by the finish (gusts to ${Math.max(w.gust, finish.gust).toFixed(0)}).</p>` +
    `<p>First half ${fmtWind(s.first)}, second half ${fmtWind(s.second)}. ${s.intoPct.toFixed(0)}% of the ride is into a headwind over 5 km/h.</p>`;
  if (isLoop(route)) {
    const rv = windStats(route, true);
    if (rv.second < s.second - 2) {
      html += `<p><b>Ride it the other way.</b> The second half becomes ${fmtWind(rv.second)}, so the wind helps you home.</p>`;
      btn.hidden = false;
    } else {
      html += '<p>This direction is the better one for getting home with the wind.</p>';
    }
  }
  el.innerHTML = html;
}

function updateWindBadge(w, dep) {
  const b = $('wind-badge');
  if (!w) { b.hidden = true; return; }
  b.hidden = false;
  $('wind-arrow').style.transform = `rotate(${(w.dir + 180) % 360}deg)`;
  $('wind-text').textContent = `${compass(w.dir)} ${w.speed.toFixed(0)} km/h · ${new Date(dep).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

async function refreshWind() {
  const c = route ? route.coords[Math.floor(route.coords.length / 2)] : [map.getCenter().lng, map.getCenter().lat];
  try { await loadWind(c[0], c[1]); } catch (e) { console.warn(e); }
  renderWind();
  if ($('colour-by').value === 'wind') refreshRouteColours();
}

colourers.wind = (rt) => {
  const pcs = windPieces(rt);
  if (!pcs) return [{ i0: 0, i1: rt.coords.length - 1, color: ROUTE_COLOR }];
  return pcs.map((p) => ({
    i0: p.i0, i1: p.i1,
    color: p.head > 8 ? '#d73027' : p.head > 3 ? '#fc8d59' : p.head < -8 ? '#1a9850' : p.head < -3 ? '#91cf60' : '#bdbdbd',
  }));
};

routeHooks.push(() => { refreshWind(); });
$('wind-time').addEventListener('change', refreshWind);
$('speed').addEventListener('change', refreshWind);
$('wind-reverse').onclick = () => setWaypoints([...waypoints].reverse());
map.on('load', refreshWind);
