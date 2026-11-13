'use strict';
/* Routing data for other parts of the world. BRouter's data comes in 5x5 degree tiles
   (E115_S35 = 115-120 E, 30-35 S). When a route needs a tile the server doesn't have,
   offer to download it; the More > Regions section lists and removes them. */

function tileFor(lng, lat) {
  const x = Math.floor(lng / 5) * 5, y = Math.floor(lat / 5) * 5;
  return `${x < 0 ? 'W' + -x : 'E' + x}_${y < 0 ? 'S' + -y : 'N' + y}`;
}
function tilesFor(points) {
  // The tiles under the points and along the straight lines between them.
  const out = new Set();
  for (let i = 0; i < points.length; i++) {
    out.add(tileFor(points[i][0], points[i][1]));
    if (i) for (let k = 1; k < 10; k++) {
      const t = k / 10, a = points[i - 1], b = points[i];
      out.add(tileFor(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
    }
  }
  return [...out];
}

async function regionState() {
  const r = await fetch('/api/regions');
  if (!r.ok) throw new Error('the server did not answer');
  return r.json();
}
async function missingTiles(points) {
  const st = await regionState();
  const have = new Set(st.tiles.map((t) => t.tile));
  return tilesFor(points).filter((t) => !have.has(t));
}

let regionPoll = null;
async function downloadTiles(tiles, after) {
  for (const t of tiles) await fetch(`/api/regions/${t}`, { method: 'POST' });
  clearInterval(regionPoll);
  regionPoll = setInterval(async () => {
    let st;
    try { st = await regionState(); } catch { return; }
    renderRegions(st);
    const jobs = tiles.map((t) => st.downloading[t]).filter(Boolean);
    const failed = jobs.find((j) => j.error);
    if (failed) {
      clearInterval(regionPoll);
      showMsg(`Download failed: ${failed.error}.`);
      return;
    }
    if (jobs.length) {
      const done = jobs.reduce((a, j) => a + j.done, 0), total = jobs.reduce((a, j) => a + j.total, 0);
      const m = $('msg');
      m.hidden = false;
      m.innerHTML = `Downloading map data for ${tiles.join(', ')}: ${Math.round(done / 1e6)}${total ? ` of ${Math.round(total / 1e6)} MB (${Math.round((100 * done) / total)}%)` : ' MB'}` +
        `<div class="dl-bar"><div style="width:${total ? Math.min(100, (100 * done) / total).toFixed(1) : 5}%"></div></div>`;
      return;
    }
    clearInterval(regionPoll);
    showMsg('');
    if (after) after();
  }, 1000);
}

// Shown when a route fails because the data isn't there.
async function offerRegions(points, why) {
  let tiles;
  try { tiles = await missingTiles(points); } catch { tiles = []; }
  if (!tiles.length) { const m = /datafile (\S+)\.rd5/.exec(why || ''); if (m) tiles = [m[1]]; }
  if (!tiles.length) { showMsg('Routing failed: ' + why); return; }
  const m = $('msg');
  m.hidden = false;
  m.innerHTML = `This area isn't downloaded for routing yet (${tiles.join(', ')}, usually 20–200 MB each). ` +
    '<button type="button" class="linkbtn" id="dl-region">Download it</button>';
  $('dl-region').onclick = () => downloadTiles(tiles, () => requestRoute(false));
}

// Tell the server which regions you're routing in, once per region per session.
const reportedTiles = new Set();
routeHooks.push((rt) => {
  if (!rt) return;
  const tiles = tilesFor([rt.coords[0], rt.coords[rt.coords.length - 1], rt.coords[rt.coords.length >> 1]]).filter((t) => !reportedTiles.has(t));
  if (!tiles.length) return;
  tiles.forEach((t) => reportedTiles.add(t));
  fetch('/api/regions/used', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tiles) }).catch(() => {});
});

const homeTile = () => (typeof home !== 'undefined' && home ? tileFor(home.lng, home.lat) : 'E115_S35');
const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d + 'T00:00:00')) / 86400000) : null);
const usedText = (d) => { const n = daysSince(d); return n == null ? 'never used' : n <= 0 ? 'used today' : n === 1 ? 'used yesterday' : `last used ${n} days ago`; };

function staleRegions(st) {
  const age = +$('region-age').value;
  return st.tiles.filter((t) => t.tile !== homeTile() && (age === 0 || (daysSince(t.lastUsed) ?? 9999) >= age));
}

$('region-clear').onclick = async () => {
  const st = await regionState();
  const gone = staleRegions(st);
  const btn = $('region-clear');
  if (!gone.length) { $('region-note').textContent = 'Nothing to clear.'; return; }
  if (!btn.dataset.armed) { // second tap confirms
    btn.dataset.armed = '1';
    btn.textContent = `Delete ${gone.length} (${Math.round(gone.reduce((a, t) => a + t.mb, 0))} MB)?`;
    $('region-note').textContent = 'Will delete: ' + gone.map((t) => t.tile).join(', ') + '. Tap again to confirm.';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Clear'; }, 6000);
    return;
  }
  delete btn.dataset.armed; btn.textContent = 'Clear';
  for (const t of gone) await fetch(`/api/regions/${t.tile}`, { method: 'DELETE' });
  $('region-note').textContent = `Deleted ${gone.map((t) => t.tile).join(', ')}.`;
  renderRegions(await regionState());
};

function renderRegions(st) {
  const ul = $('regions');
  if (!ul) return;
  ul.innerHTML = '';
  for (const t of st.tiles) {
    const li = document.createElement('li');
    const isHome = t.tile === homeTile();
    li.innerHTML = `<span class="km">${escapeHtml(t.tile)}</span><span>${isHome ? '<b>home</b> · ' : ''}${t.mb} MB · ${usedText(t.lastUsed)}</span>` +
      (isHome ? '' : '<button class="x" title="Delete this region">✕</button>');
    if (!isHome) li.querySelector('button').onclick = async (e) => {
      e.stopPropagation();
      if (!confirmInline(li, `Delete ${t.tile}? Routes there will stop working until it's downloaded again.`)) return;
      await fetch(`/api/regions/${t.tile}`, { method: 'DELETE' });
      renderRegions(await regionState());
    };
    li.onclick = () => { // zoom to the tile
      const m = /^([EW])(\d+)_([NS])(\d+)$/.exec(t.tile);
      const x = (m[1] === 'W' ? -1 : 1) * +m[2], y = (m[3] === 'S' ? -1 : 1) * +m[4];
      map.fitBounds([[x, y], [x + 5, y + 5]], { padding: 30 });
    };
    ul.appendChild(li);
  }
  for (const [t, j] of Object.entries(st.downloading)) {
    const li = document.createElement('li');
    const pct = j.total ? Math.min(100, (100 * j.done) / j.total) : 5;
    li.innerHTML = `<span class="km">${escapeHtml(t)}</span><span style="flex:1">${j.error ? 'failed: ' + escapeHtml(j.error) : `downloading ${Math.round(j.done / 1e6)}${j.total ? ' of ' + Math.round(j.total / 1e6) : ''} MB` +
      `<div class="dl-bar"><div style="width:${pct.toFixed(1)}%"></div></div>`}</span>`;
    ul.appendChild(li);
  }
}
// A second tap confirms, instead of a browser dialog.
function confirmInline(li, text) {
  if (li.dataset.armed) return true;
  li.dataset.armed = '1';
  li.title = text;
  li.querySelector('button').textContent = 'Delete?';
  setTimeout(() => { delete li.dataset.armed; const b = li.querySelector('button'); if (b) b.textContent = '✕'; }, 4000);
  return false;
}

$('region-here').onclick = async () => {
  const c = map.getCenter();
  const t = tileFor(c.lng, c.lat);
  const st = await regionState();
  if (st.tiles.some((x) => x.tile === t)) { $('region-note').textContent = `${t} is already downloaded.`; return; }
  $('region-note').textContent = '';
  downloadTiles([t], () => { $('region-note').textContent = `${t} is ready.`; });
};
document.querySelector('[data-key="regions"]').addEventListener('toggle', async (e) => {
  if (e.target.open) { try { renderRegions(await regionState()); } catch { /* offline */ } }
});
