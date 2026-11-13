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
      showMsg(`Downloading map data for routing: ${Math.round(done / 1e6)}${total ? ` of ${Math.round(total / 1e6)}` : ''} MB…`);
      return;
    }
    clearInterval(regionPoll);
    showMsg('');
    if (after) after();
  }, 1500);
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

function renderRegions(st) {
  const ul = $('regions');
  if (!ul) return;
  ul.innerHTML = '';
  for (const t of st.tiles) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="km">${escapeHtml(t.tile)}</span><span>${t.mb} MB · updated ${escapeHtml(t.updated)}</span>` +
      '<button class="x" title="Delete this region">✕</button>';
    li.querySelector('button').onclick = async (e) => {
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
    li.innerHTML = `<span class="km">${escapeHtml(t)}</span><span>${j.error ? 'failed: ' + escapeHtml(j.error) : `downloading ${Math.round(j.done / 1e6)}${j.total ? ' of ' + Math.round(j.total / 1e6) : ''} MB`}</span>`;
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
