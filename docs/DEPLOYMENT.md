# Deployment — God's Eye View on Google Cloud

Executes the plan in `GODS_EYE_VIEW_HANDOFF.md`.

> ## ⏸ Currently SHUT DOWN (2026-08-26)
>
> The Cloud Run service is **deleted** and the hourly scheduler is **paused**.
> Nothing serves and nothing accrues compute cost. Everything needed to bring it
> back is intact: the images, the secrets, the collected archive, the budget and
> the tile quotas.
>
> The collector store stopped at `total_collected: 15,921` (2026-08-26T01:08:12Z).
> Upstream's own GitHub Actions cron is still running and still collecting, so the
> canonical archive keeps advancing — on restart the collectors resume from the
> bucket and re-derive every output from the raw archive, which is exactly why
> stopping for a while is safe.
>
> ### Restart
>
> ```bash
> gcloud run deploy gods-eye-view --project=api-project-1073062544076 --region=us-central1 --image=us-central1-docker.pkg.dev/api-project-1073062544076/gev/gods-eye-view:latest --service-account=gev-run@api-project-1073062544076.iam.gserviceaccount.com --min-instances=1 --max-instances=1 --memory=1Gi --cpu=1 --port=8080 --timeout=300 --set-secrets=AISSTREAM_API_KEY=AISSTREAM_API_KEY:latest,FIRMS_MAP_KEY=FIRMS_MAP_KEY:latest --set-env-vars=OPENSKY_AUTH_MODE=anon,GEV_RATELIMIT_GOOGLE_PER_MIN=60,GEV_RATELIMIT_OPENAI_PER_MIN=30 --allow-unauthenticated
> ```
>
> ```bash
> gcloud scheduler jobs resume pulaski-collectors-hourly --project=api-project-1073062544076 --location=us-central1
> ```
>
> The URL is derived from service name + project number, so redeploying under the
> same name returns the **same** URL. Drop `--allow-unauthenticated` to come back
> up private, and reach it with `npm run proxy`.
>
> ### What is still costing money
>
> Effectively nothing: ~37 MB in `gs://gev-pulaski-data` and four container images
> in Artifact Registry — cents per month combined. Secrets sit in the free tier.
> The Maps key bills only on use, and nothing is using it.
>
> To tear down completely instead, delete the bucket, the Artifact Registry repo,
> the two secrets, the Cloud Run job, and the scheduler job — or unlink billing
> from the project, which stops everything at once.

## What is running

| Thing | Where |
|---|---|
| App | Cloud Run `gods-eye-view`, `us-central1`, `min=1 max=1` |
| URL | `https://gods-eye-view-1073062544076.us-central1.run.app` (**public**) |
| Images | `us-central1-docker.pkg.dev/api-project-1073062544076/gev/` |
| Collectors | Cloud Run Job `pulaski-collectors` + Cloud Scheduler `7 * * * *` UTC |
| Collector store | `gs://gev-pulaski-data/store` (**private**), mounted at `/gcs` via GCS FUSE |
| Project | `api-project-1073062544076` ("God's Eye View") |

`min=1 max=1` is deliberate. Upstream states that "generation semantics assume the
app's actual single-process dev-server deployment; concurrent replicas behind one
origin are out of scope" — the Radio catalog generation counter is per-process.

## Access

**The service is PUBLIC.** `allUsers` holds `roles/run.invoker`, so anyone with the
URL can load it — changed deliberately on 2026-08-25 from the original
authenticated-only posture.

`tools/gev-proxy.mjs` (`npm run proxy`) still works and is still the way in if the
service is ever made private again:

```bash
gcloud run services remove-iam-policy-binding gods-eye-view --region=us-central1 --member="allUsers" --role="roles/run.invoker"
```

### What being public means here

- **No new data is disclosed.** Everything the Pulaski layers read is already
  public: `buildings.pmtiles`, `crimes.json` and the dispatch archive are all
  served openly by GitHub Pages and raw.githubusercontent with `ACAO: *`. Nothing
  was republished to make this work.
- **But the building tiles carry person-adjacent attributes** — situs `addr`, `veh`
  (vehicles registered at that address), `ppv` — and a public deployment puts them
  in front of anyone with the link rather than merely leaving them where upstream
  already publishes them. This is why the layer is not upstreamable, regardless of
  hosting.
- **The metered Google key is the real new exposure.** It is client-exposed by
  design, so a public page brokers billable tile sessions. The guards below are
  what stand between that and the bill.

### Cost guards (a budget alerts; only a quota stops)

| Control | Value |
|---|---|
| Billing budget | $50/mo, alerts at 25/50/75/90/100% + forecast |
| Maps key restriction | HTTP referrer, this Cloud Run origin + localhost; API-restricted to Map Tiles + Places |
| `tile.googleapis.com/threedtiles_renderer_request` | **400,000/day** (was UNLIMITED) |
| `tile.googleapis.com/threedtiles_root_tileset` | 2,000/day (was 10,000) |
| `tile.googleapis.com/twodtiles` | 20,000/day (was 100,000) |
| Per-IP, in-process | `GEV_RATELIMIT_GOOGLE_PER_MIN=60`, `GEV_RATELIMIT_OPENAI_PER_MIN=30` |
| Cloud Run | `max-instances=1` |

The daily tile quotas are the only hard stop in that list. Raise or lower them with
the Service Usage `consumerOverrides` API, or in Console under APIs & Services →
Map Tiles API → Quotas.

### Why not IAP

The handoff recommended IAP. It is not usable on this project: IAP needs an OAuth
brand, `gcloud iap oauth-brands create` returns `Project must belong to an
organization`, and that API was permanently shut down in March 2026. A project
owned by a gmail.com account can only enable IAP through a first-time Cloud
Console click-through (OAuth consent screen → External, then Cloud Run → Security
→ enable IAP).

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
| `FIRMS_MAP_KEY` | Secret Manager | set — 300k detections across 3 VIIRS sources. Must be the short `MAP_KEY` from firms.modaps.eosdis.nasa.gov/api/map_key/, **not** an Earthdata Login JWT; FIRMS rejects a JWT with `Invalid MAP_KEY` |
| `OPENSKY_CLIENT_ID/SECRET` | — | **not set**; see below |
| `OPENAI_API_KEY` | — | not set; voice + AI HUD summary return 503 |
| `TOMTOM_API_KEY` | — | not set; traffic falls back to simulation |
| `CESIUM_ION_TOKEN` | — | not set; Bing imagery stacks unavailable |

See **Cost guards** under Access for the full list. Note that neither the budget
nor `GEV_RATELIMIT_*` actually stops spend: the budget only emails you, and the
rate limits are per-IP and process-local (in-memory, reset on restart). The daily
tile quotas are the only hard ceiling.

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

## Pulaski layers

Four, all verified live on the deployed service:

| Layer | Id | Token | What it draws |
|---|---|---|---|
| Pulaski Buildings | `pulaski-buildings` | `h` | Footprints decoded from PMTiles per viewport, extruded by assessor storey count |
| Pulaski Reported Crime | `pulaski-crime` | `j` | 114,742 LRPD offenses 2017 → 3 Feb 2025, era chips |
| Pulaski Calls for Service | `pulaski-dispatch` | `k` | Hourly CAD feed, 24H/7D/30D/ALL window chips |
| Pulaski Surveillance | `local-pulaski-surveillance` | `p` | 525 bundled devices |

**Never change a token once shipped** — it is the share-link serialization
character, and the decoder fails closed on an unknown one, so an old build would
reject the entire layer payload of a new link.

Counts were cross-checked against upstream's own published totals rather than
merely eyeballed: dispatch `all` = 15,519 against `stats.json` `placed` 15,519;
crime eras 47,454 / 40,349 / 26,939 summing to 114,742 and each matching the
`by_year` figures exactly; crime categories matching `by_cat` exactly.

The buildings layer sleeps unless the camera is over the county and below 20 km
(`status: 'zoom-in'`, which the panel renders as a state rather than an error) —
a z12 tile of this archive holds 23,341 features.

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

## Still open

From the handoff's phasing, not yet built:

- **Pulse and Watch panels** (§2.8, §2.9). The Pulse SVG dashboard is framework-free
  and ports cleanly, and `pulse/out/pulse.json` is pre-aggregated for exactly those
  charts at 97 KB — but it is a panel, not a globe layer, and needs UI scaffolding.
- **Deeds and permits layers.** `deeds/out/recent_activity.geojson` (2.6 MB) is a
  straight point layer on the dispatch pattern. Permits (16.7 MB) wants interning
  first, like `crimes.json`.
- **Owner and vehicle search.** Unblocked by the private deployment, still unbuilt.
- **The 311 collector** (`pipeline/sr311_collect.py`, unmerged upstream on
  `claude/lr311-overlay`). Its output is already seeded in the store but stops at
  2026-07, so the layer would need a visible "as of" label.
- **Voice tools** for the new layers. Adding them means editing the tool enums in
  `vite.config.js`, which trips a byte-length + sha256 pin in
  `src/firstRunExperience.test.mjs` that must be recomputed deliberately.

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
