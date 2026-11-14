'use strict';
/* Popularity scores for routes (Part 2a). The server reads the heatmap's 'ride' tiles and says,
   for each route, how much of it is on roads the heatmap shows as popular. Used for the figure
   under the distance and to label the most popular alternative. Routing itself is unchanged. */

const HEAT_MIN_COVER = 0.5;   // below this much heatmap data along a route, don't show a figure

// Sample a route for the server: about every 15 m, at most ~4000 points.
function heatLine(rt) {
  const step = Math.max(15, rt.length / 4000);
  const out = [];
  for (let d = 0; d < rt.length; d += step) {
    const p = pointAt(rt, d);
    out.push([+p[0].toFixed(6), +p[1].toFixed(6)]);
  }
  const last = rt.coords[rt.coords.length - 1];
  out.push([last[0], last[1]]);
  return out;
}

// Scores every route that doesn't have one yet, in one request. Sets rt._heat to
// {covered, mean, popular} (0..1 each), or null when there's no heatmap. Never throws.
let heatScoreOff = false;      // server said the heatmap isn't set up: stop asking
async function scoreRoutes(rts) {
  const todo = rts.filter((rt) => rt && rt.coords && rt.coords.length > 1 && rt._heat === undefined && !rt._heatP);
  if (todo.length && !heatScoreOff) {
    const p = (async () => {
      try {
        const res = await fetch('/api/heat/score', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ routes: todo.map(heatLine) }),
        });
        if (res.status === 503) heatScoreOff = true;
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        todo.forEach((rt, i) => { rt._heat = data.routes[i] || null; });
      } catch {
        todo.forEach((rt) => { rt._heat = null; });
      }
    })();
    todo.forEach((rt) => { rt._heatP = p; });
  }
  await Promise.all(rts.map((rt) => rt && rt._heatP).filter(Boolean));
}

// Share of the route on popular roads as a whole percentage, or null if there isn't enough data.
function heatPct(rt) {
  const h = rt && rt._heat;
  return h && h.covered >= HEAT_MIN_COVER && h.popular != null ? Math.round(h.popular * 100) : null;
}

function renderHeatStat() {
  const el = $('s-heat');
  const pct = heatPct(route);
  el.textContent = pct == null ? '' : ` · ${pct}% popular`;
  const h = route && route._heat;
  el.title = pct == null ? '' :
    `${pct}% of the route is on roads the ride heatmap shows as popular.` +
    (h.covered < 0.98 ? ` Based on the ${Math.round(h.covered * 100)}% of the route with heatmap data.` : '');
}

routeHooks.push((rt) => {
  renderHeatStat();
  if (rt) scoreRoutes([rt]).then(() => {
    if (route !== rt) return;
    renderHeatStat();
    if (typeof altRoutes !== 'undefined' && altRoutes.length) renderAlts(); // 'most popular' needs this route's score too
  });
});
