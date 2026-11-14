# Cycle Planner

Self-hosted bike route planner: BRouter for routing, a MapLibre web app on top. Images are built by GitHub Actions and published to ghcr.io, so installing is just a compose file.

## Install with Dockge

1. In Dockge, click **+ Compose** and name the stack `cycleplanner`.
2. Paste the contents of [`compose.yaml`](compose.yaml) and click **Deploy**.
3. Open `http://<server-ip>:8095`.

On first start BRouter downloads the routing data (about 12 MB for Perth), so routing gives a "still starting" message for the first minute or so.

To update after a new release, click **Update** on the stack in Dockge.

## Settings (environment in compose.yaml)

| Variable | Default | What it does |
|---|---|---|
| `TILES` | `E115_S35` | 5×5 degree routing tiles. E115_S35 covers Lancelin to Augusta and inland past York. Add `E115_S40` for Albany and the south coast, `E115_S30` for Leeman to Geraldton. |
| `REFRESH_DAYS` | `7` | Re-download the OpenStreetMap routing data when it's older than this. `0` turns it off. BRouter restarts itself after a refresh. |
| `JAVA_MAX_HEAP` | `1g` | Memory for BRouter. 1g is plenty for one or two tiles. |

| `ICU_API_KEY` (history) | empty | Your intervals.icu API key, from intervals.icu → Settings → Developer Settings. Turns on ride history. |
| `SYNC_HOURS` (history) | `6` | How often to pull new rides from intervals.icu. `0` = only when you press Sync. |
| `HISTORY_SINCE` (history) | `2015-01-01` | Oldest rides to fetch. |
| `HEATMAP_URL` (history) | empty | Tile URL of your popularity heatmap proxy, with `{activity}` `{color}` `{z}` `{x}` `{y}`. See below. |
| `HEATMAP_DAYS` (history) | `90` | Ask the heatmap proxy again for tiles older than this. Old tiles are kept and used if the proxy is down. |
| `HEATMAP_GAP` (history) | `0.3` | Seconds between requests to the heatmap proxy. |

The web port is `8095`; change the left side of `8095:80` if that clashes with something.

## Popularity heatmap

**More › Map › Popularity heatmap** draws heatmap tiles from a proxy you run, with a choice of activity, colours and opacity. It sits over the map and photos but under street names, your ride history and the route.

The browser never talks to the proxy. The history service fetches tiles (2 at a time, `HEATMAP_GAP` apart), keeps them in `data/heat/tiles` for `HEATMAP_DAYS`, and nginx serves them from the app's own address at `/tiles/heat/...`. So there's no CORS to set up, the proxy only has to be reachable from the server, and tiles you've looked at keep showing if the proxy goes down.

The compose file points at `http://host.docker.internal:9999/...`, which is the server itself. The proxy has to accept connections from outside itself: `sudo ss -ltnp | grep 9999` should show `0.0.0.0:9999`, `*:9999` or `[::]:9999`. If it shows `127.0.0.1:9999`, containers can't reach it. A proxy running in Docker with `ports: - 9999:...` is fine. If it runs on another machine, put that machine's address in `HEATMAP_URL` instead.

### Popular routes

**Route options › Popular roads** makes BRouter itself favour roads that are popular on the ride heatmap. The BRouter image is patched for this (`docker/brouter-heat`): every stretch of road BRouter weighs costs `1 + strength × (1 − heat)` times its normal cost, so with *prefer* (strength 0.5) a road nobody rides counts as 1.5 times as long as the busiest one, and with *strongly prefer* (1.5) 2.5 times. Heat comes from the same grid files as the popularity figure below. Where there's no heatmap data yet, roads count as middling (heat 0.5): counting them as busy would pull routes towards unknown ground, counting them as empty would push routes away from it. With the option on *ignore* the router behaves exactly like stock BRouter. Long routes take longer to plan with it on (a 70 km route went from about 2 s to 5 s in testing).

The patch is two small changes to BRouter 1.7.9 plus one new class, compiled against the release jar when the image is built. If BRouter's code ever changes under it, the image build fails rather than shipping a half-patched router.

Each route also gets a popularity figure: the share of it on roads the **ride** heatmap shows as popular, shown under the distance ("· 62% popular") and on each alternative. The alternatives also try to include the most popular way, and label it.

How the figure works: every heatmap colour scheme carries the same transparency, and that transparency is the popularity (0 where nobody rides, 143 on the faintest track, 255 on the busiest road). The history service downloads the z14 `ride` tiles over the bike-path area (`BIKEPATH_BBOX`, Mandurah to Two Rocks) in the background, slowly, middle outwards, and keeps just the transparency in `data/heat/grid`. A route is checked every 10–15 m against the strongest heat within 8 m of it. Tiles are re-downloaded after `HEATMAP_DAYS` (90), so the check each day costs nothing. Routes outside the area download the tiles they cross (up to 40 per check); anywhere without data is left out of the figure, and with heatmap data on under half the route no figure is shown.

Progress of the download: `/api/heat/grid`.

## Ride history

The `history` service pulls GPS tracks of your outdoor rides from intervals.icu and stores them in `data/history`. Indoor, Zwift and trainer rides are skipped. Rides that reached intervals.icu through Strava can't be fetched (Strava doesn't allow it), so they're skipped too; rides synced straight from Garmin, Wahoo or Hammerhead work. The key never leaves your server.

## Routing options

The app routes with patched copies of BRouter's bike profiles (`cp-fastbike`, `cp-safety`, `cp-trekking`, `cp-gravel`, built into the image by `docker/patch-profile.awk`). They add one setting, `avoid_footpaths`: footways, pedestrian areas and foot-only paths that aren't signed for bikes cost at least 6× as much, so they're only used as short links where nothing else goes through. WA allows footpath riding, so many ordinary footpaths are tagged `bicycle=yes` and the stock profiles happily use them.

"Avoid busy roads" sets each profile's own traffic option per request. If a patched profile ever fails to load, the app falls back to the stock one and says so.

Two more switches live in **Route options**: "fewer traffic lights" (each light counts as a 300 m detour, stop/give way 100 m) and "fewer turns" (60 m per turn). Both are extra settings in the patched profiles (`signal_penalty`, `turn_penalty`).

**No-go areas** are BRouter `nogos` circles. "Avoid completely" never enters; "prefer to avoid" uses a weight of 10 (cost per metre ridden inside). They're stored on the server in `data/settings.json`.

## Ride time from your power

With the history service connected, the app reads your ride FTP and weight from intervals.icu and estimates time at a % of FTP you choose (default 65%). It works through every 100 m of the route with the gradient and the forecast wind at that point (CdA 0.32, Crr 0.0045, 9 kg bike, descents capped at 50 km/h). Tap "use speed" to go back to a flat km/h.

## Roads you like and dislike

Tap "Mark a road I dislike" (or like), then tap the road on the map; the road is followed up to about 2 km each way. Disliked roads go to BRouter as a chain of small soft no-go circles, so they're avoided unless the way round is much longer. Liked roads are favoured by the loop generator (ranking and snapping). Stored on the server in `data/settings.json`.

## GPX import

"Import GPX to edit" turns a track into waypoints the router can follow (shape points, no gap over 1.5 km), shows the original in grey and says how much of it the new route follows.

## Caching

Map tiles (OpenFreeMap, CyclOSM) go through an nginx cache inside the web container: 30 days for tiles, an hour for the style, and stale tiles are served if the tile service is down. Overpass lookups (toilets, water, cafés, lights, paths) go through the history service and are kept for a week in `data/overpass/`, with old answers used if every Overpass server fails. The first lookup for a new area can take a minute.

## Saved routes and short links

Routes are saved on the server in `data/routes/`, so every device sees the same list. "Copy short link" stores the route and gives a `#r=abc123` link. Routes saved in a browser before this existed are moved to the server the first time that browser opens the app.

## Changing how it routes

Routing profiles live in `data/profiles/*.brf` inside the stack folder (`/opt/stacks/cycleplanner/data/profiles` on a default Dockge install). Edits are picked up on the next request.

## Using it from your phone away from home

Tailscale is the easiest way. `tailscale serve --bg 8090` on the server also gives you HTTPS, which the phone browser needs before the "locate me" button works.

## What it does

- Tap to add points, drag to move, tap the route line to insert a point, tap a point to remove it
- Profiles: road fastest, road low traffic, safest, mixed/touring, gravel
- Distance, climbing, ride time at your own speed, elevation profile
- Surface and way-type breakdown, route colouring by either
- Toilets and drinking water from OpenStreetMap (nothing inside shopping centres, indoor or customers-only), listed along the route with gap warnings
- GPX download with toilets and water as waypoints, routes saved in the browser, shareable links
- Place search, CyclOSM overlay, bottom-sheet layout on phones
- Wind: hourly forecast for your departure time, headwind/tailwind along the route, route colouring by wind, and a "ride it the other way" suggestion for loops
- Interval stretches: the longest parts of the route with no lights, stop/give way, roundabouts, barriers, sharp turns or path crossings, filtered by minimum minutes and flat/climb
- Loop generator: six loops of your chosen distance in different directions, each ridden the way that puts the wind behind you home, with climbing, main-road share and how much is new to you
- Ride history: your intervals.icu rides on the map, "% new roads" for any route, and route colouring by new vs ridden

## Repo layout

```
compose.yaml                  the stack to paste into Dockge
app/                          the web app
docker/web.Dockerfile         nginx + app
docker/brouter.Dockerfile     BRouter 1.7.9
docker/brouter-entrypoint.sh  data download, weekly refresh, server start
docker/history.Dockerfile     intervals.icu history service
history/server.py             the history service (Python standard library only)
.github/workflows/images.yml  builds and pushes both images on every push to main
```

The browser also talks to OpenFreeMap (map tiles), CyclOSM, Nominatim (search), the Overpass API (toilets, water, lights and crossings) and Open-Meteo (wind). All free and keyless.
