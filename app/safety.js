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

function renderSafety() {
  const ul = $('safety'), sum = $('safety-sum');
  ul.innerHTML = '';
  sum.textContent = '';
  if (!route) return;
  const list = safetyStretches(route);
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
