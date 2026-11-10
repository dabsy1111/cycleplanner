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

The web port is `8095`; change the left side of `8095:80` if that clashes with something.

## Ride history

The `history` service pulls GPS tracks of your outdoor rides from intervals.icu and stores them in `data/history`. Indoor, Zwift and trainer rides are skipped. Rides that reached intervals.icu through Strava can't be fetched (Strava doesn't allow it), so they're skipped too; rides synced straight from Garmin, Wahoo or Hammerhead work. The key never leaves your server.

## Routing options

The app routes with patched copies of BRouter's bike profiles (`cp-fastbike`, `cp-safety`, `cp-trekking`, `cp-gravel`, built into the image by `docker/patch-profile.awk`). They add one setting, `avoid_footpaths`: footways, pedestrian areas and foot-only paths that aren't signed for bikes cost at least 6× as much, so they're only used as short links where nothing else goes through. WA allows footpath riding, so many ordinary footpaths are tagged `bicycle=yes` and the stock profiles happily use them.

"Avoid busy roads" sets each profile's own traffic option per request. If a patched profile ever fails to load, the app falls back to the stock one and says so.

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
