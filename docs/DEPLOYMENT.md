# Deployment — God's Eye View on Google Cloud

State as of 2026-08-25. Executes the plan in `GODS_EYE_VIEW_HANDOFF.md`.

## What is running

| Thing | Where |
|---|---|
| App | Cloud Run `gods-eye-view`, `us-central1`, `min=1 max=1` |
| URL | `https://gods-eye-view-1073062544076.us-central1.run.app` (**private**) |
| Images | `us-central1-docker.pkg.dev/api-project-1073062544076/gev/` |
| Collectors | Cloud Run Job `pulaski-collectors` + Cloud Scheduler `7 * * * *` UTC |
| Collector store | `gs://gev-pulaski-data/store` (**private**), mounted at `/gcs` via GCS FUSE |
| Project | `api-project-1073062544076` ("God's Eye View") |

`min=1 max=1` is deliberate. Upstream states that "generation semantics assume the
app's actual single-process dev-server deployment; concurrent replicas behind one
origin are out of scope" — the Radio catalog generation counter is per-process.

## Access

The service runs `--no-allow-unauthenticated`; only principals with
`roles/run.invoker` can reach it, and an unauthenticated request gets `403`.

A browser address bar cannot attach an identity token, so:

```bash
node tools/gev-proxy.mjs
```

then open <http://localhost:8080>. Grant another person access with:

```bash
gcloud run services add-iam-policy-binding gods-eye-view --region=us-central1 --member="user:SOMEONE@example.com" --role="roles/run.invoker"
```

### Why not IAP

The handoff recommended IAP. It is not usable on this project: IAP needs an OAuth
brand, `gcloud iap oauth-brands create` returns `Project must belong to an
organization`, and that API was permanently shut down in March 2026. A project
owned by a gmail.com account can only enable IAP through a first-time Cloud
Console click-through. Cloud Run IAM gives the same outcome — nothing is publicly
reachable — without it. To switch later: configure the OAuth consent screen in the
Console, then `gcloud beta run services update gods-eye-view --iap`.

## Serving

`vite build` emits a static `dist/`, but ten of the nineteen `/api/*` proxies
register only `configureServer`: they exist under `vite` and vanish under `vite
preview` or any static host, taking satellites, flights, traffic, routing, CCTV,
bikeshare, fires, aircraft metadata and terrain heights with them.

`server/index.js` reuses those plugins rather than forking them. They touch only
`server.middlewares.use(path, fn)` and one optional-chained
`server.httpServer.on('close')`, so an Express app satisfies the entire contract
when passed as `middlewares` (`src/server/mountApiPlugins.js`).

Two things that will bite anyone editing it:

- **Mount no body parser.** `/api/overpass`, `/api/openai/hud-summary` and
  `/api/realtime/debug-log` read the raw request stream themselves; a global
  parser consumes it and hangs them.
- **`/healthz` is unusable.** Google's front end answers that path with its own
  404 and the request never reaches the container. Health is `/_gev/healthz`.

`vite-plugin-cesium` is skipped when mounting: its `configureServer` serves
`/cesium` out of `node_modules/cesium/Build/CesiumUnminified`, which would shadow
the minified copy `closeBundle` wrote into `dist/cesium`.

## Keys

| Key | Where it lives | State |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | build arg → inlined into the bundle | set; restricted to the Cloud Run origin + localhost, and to Map Tiles + Places |
| `AISSTREAM_API_KEY` | Secret Manager | set — live vessels working |
| `FIRMS_MAP_KEY` | Secret Manager | set — 300k detections across 3 VIIRS sources |
| `OPENSKY_CLIENT_ID/SECRET` | — | **not set**; see below |
| `OPENAI_API_KEY` | — | not set; voice + AI HUD summary return 503 |
| `TOMTOM_API_KEY` | — | not set; traffic falls back to simulation |
| `CESIUM_ION_TOKEN` | — | not set; Bing imagery stacks unavailable |

Guard rails already in place: a **$50/month budget** on the billing account with
alerts at 25/50/75/90/100% plus a forecast rule, HTTP-referrer restriction on the
Maps key, and `GEV_RATELIMIT_GOOGLE_PER_MIN=60` / `GEV_RATELIMIT_OPENAI_PER_MIN=30`.
Those rate limits are per-IP and process-local — they are **not** billing caps; the
budget is.

A referrer-restricted browser key cannot authorize server-side calls, so
`/api/google/nearby-places` needs a **second, server-side** Google key before the
voice place-context features work.

## Known upstream failures (not bugs here)

- **`/api/celestrak` → 502.** `celestrak.org` is unreachable from this machine
  *and* from Cloud Run (direct `curl` times out). The satellites layer stays
  degraded until it recovers.
- **`/api/opensky` → 502.** Fails at the network level from Cloud Run's IP;
  anonymous OpenSky access is commonly blocked from datacenter ranges. Flights
  still populate through the adsb.lol fallback, which returns 200. Fix by adding
  free OpenSky OAuth credentials from an opensky-network.org account.
- **`/api/terrain/heights` → 502.** Re:Earth upstream, failing from both networks.

## Pulaski data

The app reads Pulaski data from the **existing public GitHub URLs**, which already
send `Access-Control-Allow-Origin: *` and honour Range requests. Nothing was
republished — notably not the person-adjacent `owners.json` / `vehicles.json`.
`src/data/pulaski/pulaskiSources.js` holds the base URLs and a
`window.__PULASKI_BASE__` override.

Neither GitHub host answers a **CORS preflight**. Any custom request header turns
a working fetch into a browser failure while still passing under `curl`. Keep
every request to those hosts header-free.

The collectors write to `gs://gev-pulaski-data/store` instead, which runs **in
parallel** with upstream's GitHub Actions cron exactly as the handoff requires.
Switching the app to read the bucket needs either a public bucket or a proxy
route — deliberately not done yet, so parity can be proven first.

## The untouched site

`https://brandongrant.github.io/pulaski_building_map/` is untouched and verified:
site root `200`, `origin/main` still at `8a4bdd9`, deed Worker `{"ok":true}`.
Nothing in this work pushes to that repo. Its `data` branch still advances hourly
because upstream's own Actions cron is still running, which is the intent — it is
the only thing keeping the LRPD daily-report archive alive.

## Rebuild and redeploy

```bash
gcloud builds submit --config cloudbuild.yaml --substitutions="_GOOGLE_MAPS_API_KEY=$(gcloud services api-keys get-key-string $(gcloud services api-keys list --filter='displayName:"GEV browser key"' --format='value(name)' | head -1) --format='value(keyString)')"
```

```bash
gcloud run deploy gods-eye-view --region=us-central1 --image=us-central1-docker.pkg.dev/api-project-1073062544076/gev/gods-eye-view:latest
```

## Windows notes

Three traps cost real time here and will recur:

- `core.autocrlf=true` checks the repo out as CRLF. Roughly 25 tests are
  source-introspection tests whose regexes assume LF, so **the whole suite is red
  on a fresh Windows clone**. The blobs are LF; only the working tree is wrong.
  Fix: `git config core.autocrlf false && git config core.eol lf`, then
  `git rm --cached -r . && git reset --hard` (a plain re-checkout will not do it —
  git's stat cache thinks the files are unchanged).
- Git Bash rewrites `/gcs` into a Windows path, so `--add-volume-mount` fails with
  "should be a valid unix absolute path". Run those `gcloud` calls from PowerShell.
- Node refuses to spawn `gcloud.cmd` without `shell: true` (CVE-2024-27980
  hardening) — `tools/gev-proxy.mjs` handles this.
