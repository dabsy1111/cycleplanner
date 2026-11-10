# Cycle Planner

Self-hosted bike route planner: BRouter for routing, a MapLibre web app on top. Images are built by GitHub Actions and published to ghcr.io, so installing is just a compose file.

## Install with Dockge

1. In Dockge, click **+ Compose** and name the stack `cycleplanner`.
2. Paste the contents of [`compose.yaml`](compose.yaml) and click **Deploy**.
3. Open `http://<server-ip>:8090`.

On first start BRouter downloads the routing data (about 12 MB for Perth), so routing gives a "still starting" message for the first minute or so.

To update after a new release, click **Update** on the stack in Dockge.

## Settings (environment in compose.yaml)

| Variable | Default | What it does |
|---|---|---|
| `TILES` | `E115_S35` | 5×5 degree routing tiles. E115_S35 covers Lancelin to Augusta and inland past York. Add `E115_S40` for Albany and the south coast, `E115_S30` for Leeman to Geraldton. |
| `REFRESH_DAYS` | `7` | Re-download the OpenStreetMap routing data when it's older than this. `0` turns it off. BRouter restarts itself after a refresh. |
| `JAVA_MAX_HEAP` | `1g` | Memory for BRouter. 1g is plenty for one or two tiles. |

The web port is `8090`; change the left side of `8090:80` if that clashes with something.

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

## Repo layout

```
compose.yaml                  the stack to paste into Dockge
app/                          the web app
docker/web.Dockerfile         nginx + app
docker/brouter.Dockerfile     BRouter 1.7.9
docker/brouter-entrypoint.sh  data download, weekly refresh, server start
.github/workflows/images.yml  builds and pushes both images on every push to main
```

The browser also talks to OpenFreeMap (map tiles), CyclOSM, Nominatim (search) and the Overpass API (toilets and water). All free and keyless.
