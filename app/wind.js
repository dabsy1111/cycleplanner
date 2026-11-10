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
    hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,apparent_temperature,precipitation_probability,uv_index,is_day',
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
      local: j.hourly.time, temp: j.hourly.temperature_2m, feels: j.hourly.apparent_temperature,
      rain: j.hourly.precipitation_probability, uv: j.hourly.uv_index, day: j.hourly.is_day,
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

function riderSpeedMs() { return speedKmh() / 3.6; }

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

// ---------- weather for the ride day ----------
const wx = $('wx');
const UV_COLOURS = [[3, '#40c057'], [6, '#fab005'], [8, '#fd7e14'], [11, '#e03131'], [99, '#9c36b5']];
const uvColour = (u) => UV_COLOURS.find(([lim]) => u < lim)[1];

function rideWindow() {
  const dep = departureMs();
  const hours = route ? route.length / 1000 / speedKmh() : 1;
  return [dep, dep + hours * 3600e3];
}

function dayIndices() {
  if (!wind || !wind.local) return [];
  const date = ($('wind-time').value || '').slice(0, 10);
  const idx = [];
  wind.local.forEach((t, i) => { if (t.startsWith(date)) idx.push(i); });
  return idx;
}

function drawWeather(hoverX) {
  const dpr = window.devicePixelRatio || 1;
  const w = wx.clientWidth, h = wx.clientHeight;
  if (!w) return;
  wx.width = w * dpr; wx.height = h * dpr;
  const ctx = wx.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const idx = dayIndices();
  if (idx.length < 2) { ctx.fillStyle = '#9ca3af'; ctx.font = '12px system-ui'; ctx.fillText('No forecast for that day.', 8, 20); return; }
  const L = 30, R = 6;
  const t0 = wind.times[idx[0]], t1 = wind.times[idx[idx.length - 1]] + 3600e3;
  const X = (ms) => L + ((ms - t0) / (t1 - t0)) * (w - L - R);
  const rows = { temp: [4, 58], wind: [64, 104], rain: [110, 128], uv: [133, 141] };

  // night shading and the ride window
  ctx.fillStyle = 'rgba(52,58,64,.08)';
  for (const i of idx) if (!wind.day[i]) ctx.fillRect(X(wind.times[i]), 0, X(wind.times[i] + 3600e3) - X(wind.times[i]), 142);
  const [r0, r1] = rideWindow();
  ctx.fillStyle = 'rgba(214,51,108,.14)';
  ctx.fillRect(X(r0), 0, Math.max(2, X(r1) - X(r0)), 142);

  ctx.font = '10px system-ui';
  const line = (vals, [top, bot], lo, hi, colour, dash) => {
    ctx.beginPath();
    idx.forEach((i, k) => {
      const x = X(wind.times[i] + 1800e3), y = bot - ((vals[i] - lo) / (hi - lo || 1)) * (bot - top);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.setLineDash(dash || []); ctx.strokeStyle = colour; ctx.lineWidth = 1.8; ctx.stroke(); ctx.setLineDash([]);
  };
  // temperature + feels like
  const temps = idx.flatMap((i) => [wind.temp[i], wind.feels[i]]);
  const tlo = Math.floor(Math.min(...temps) / 5) * 5, thi = Math.ceil(Math.max(...temps) / 5) * 5;
  line(wind.temp, rows.temp, tlo, thi, '#e03131');
  line(wind.feels, rows.temp, tlo, thi, '#e03131', [3, 3]);
  // wind + gusts, with direction arrows every 3 h
  const whi = Math.max(20, Math.ceil(Math.max(...idx.map((i) => wind.gust[i])) / 10) * 10);
  line(wind.gust, rows.wind, 0, whi, '#a5d8ff');
  line(wind.speed, rows.wind, 0, whi, '#1971c2');
  ctx.fillStyle = '#1971c2';
  idx.forEach((i, k) => {
    if (k % 3) return;
    const x = X(wind.times[i] + 1800e3);
    ctx.save(); ctx.translate(x, rows.wind[0] + 4); ctx.rotate(((wind.dir[i] + 180) * Math.PI) / 180);
    ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(3, 3); ctx.lineTo(-3, 3); ctx.closePath(); ctx.fill(); ctx.restore();
  });
  // rain chance bars
  ctx.fillStyle = '#4dabf7';
  for (const i of idx) {
    const v = wind.rain[i] || 0, [top, bot] = rows.rain;
    const bw = X(wind.times[i] + 3600e3) - X(wind.times[i]) - 1;
    ctx.fillRect(X(wind.times[i]), bot - (v / 100) * (bot - top), bw, (v / 100) * (bot - top));
  }
  // UV strip
  for (const i of idx) {
    ctx.fillStyle = (wind.uv[i] || 0) < 1 ? '#f1f3f5' : uvColour(wind.uv[i]);
    ctx.fillRect(X(wind.times[i]), rows.uv[0], X(wind.times[i] + 3600e3) - X(wind.times[i]), rows.uv[1] - rows.uv[0]);
  }
  // labels
  ctx.fillStyle = '#6b7280'; ctx.textAlign = 'right';
  ctx.fillText(`${thi}°`, L - 3, rows.temp[0] + 8); ctx.fillText(`${tlo}°`, L - 3, rows.temp[1]);
  ctx.fillText(`${whi}`, L - 3, rows.wind[0] + 8); ctx.fillText('km/h', L - 3, rows.wind[1]);
  ctx.fillText('rain', L - 3, rows.rain[1]); ctx.fillText('UV', L - 3, rows.uv[1] + 1);
  ctx.textAlign = 'center';
  for (const hr of [0, 6, 12, 18]) ctx.fillText(hr === 0 ? '12am' : hr === 12 ? '12pm' : hr < 12 ? `${hr}am` : `${hr - 12}pm`, X(t0 + hr * 3600e3), h - 2);

  if (hoverX != null) {
    const ms = t0 + ((hoverX - L) / (w - L - R)) * (t1 - t0);
    const i = idx.find((q) => wind.times[q] <= ms && ms < wind.times[q] + 3600e3);
    if (i != null) {
      ctx.strokeStyle = '#1d2125'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hoverX, 0); ctx.lineTo(hoverX, 142); ctx.stroke();
      const tip = $('wx-tip');
      tip.hidden = false;
      tip.style.left = `${Math.min(w - 90, Math.max(90, hoverX))}px`;
      tip.textContent = `${new Date(wind.times[i]).toLocaleTimeString([], { hour: 'numeric' })}: ${Math.round(wind.temp[i])}° (feels ${Math.round(wind.feels[i])}°), ` +
        `${compass(wind.dir[i])} ${Math.round(wind.speed[i])} km/h, rain ${wind.rain[i] ?? 0}%, UV ${Math.round(wind.uv[i] ?? 0)}`;
    }
  }
}

function rideWeatherSummary() {
  if (!wind || !wind.temp) return '';
  const [r0, r1] = rideWindow();
  const hrs = wind.times.map((t, i) => i).filter((i) => wind.times[i] + 3600e3 > r0 && wind.times[i] < r1);
  if (!hrs.length) return '';
  const rng = (a) => { const lo = Math.round(Math.min(...a)), hi = Math.round(Math.max(...a)); return lo === hi ? `${lo}` : `${lo}–${hi}`; };
  return `During your ride: ${rng(hrs.map((i) => wind.temp[i]))}°C (feels up to ${Math.round(Math.max(...hrs.map((i) => wind.feels[i])))}°), ` +
    `UV up to ${Math.round(Math.max(...hrs.map((i) => wind.uv[i] || 0)))}, rain chance up to ${Math.max(...hrs.map((i) => wind.rain[i] || 0))}%.`;
}

wx.addEventListener('mousemove', (e) => drawWeather(e.clientX - wx.getBoundingClientRect().left));
wx.addEventListener('mouseleave', () => { $('wx-tip').hidden = true; drawWeather(); });
wx.addEventListener('touchstart', (e) => drawWeather(e.touches[0].clientX - wx.getBoundingClientRect().left), { passive: true });
wx.addEventListener('touchmove', (e) => drawWeather(e.touches[0].clientX - wx.getBoundingClientRect().left), { passive: true });
wx.addEventListener('touchend', () => { $('wx-tip').hidden = true; drawWeather(); });
window.addEventListener('resize', debounce(() => drawWeather(), 200));
$('wind-time').closest('details').addEventListener('toggle', () => drawWeather());

async function refreshWind() {
  const c = route ? route.coords[Math.floor(route.coords.length / 2)] : [map.getCenter().lng, map.getCenter().lat];
  try { await loadWind(c[0], c[1]); } catch (e) { console.warn(e); }
  renderWind();
  if (typeof modelRide === 'function') renderStats(); // ride time uses the wind
  drawWeather();
  $('wx-sum').textContent = rideWeatherSummary();
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
