# Handoff — fuse the Pulaski property/public-records platform into a self-hosted God's Eye View on Google Cloud

**Written:** 2026-08-24 · **Audience:** a fresh session with no prior context on either repo.
**Status:** planning + inventory document. Nothing in this document has been executed yet.
**Lives at:** `brandongrant/gods-eye-view`, branch **`v2`** — the branch this work happens on.

---

## 0. The assignment, exactly

1. **Create a new Google Cloud project** to host the fused application.
2. **Deploy `https://github.com/brandongrant/gods-eye-view`** (a CesiumJS 3D-globe intelligence console) into it.
3. **Take the Pulaski County data and its scheduled data updates** from
   `github.com/brandongrant/pulaski_building_map` and **merge them into that single "God's Eye View."**

### Hard constraint — do not touch the existing site

> **`https://brandongrant.github.io/pulaski_building_map/` must remain live and unchanged.**

That site is deployed by `.github/workflows/pages.yml` on every push to `main` of
`brandongrant/pulaski_building_map`. Concretely this means:

- **Do not push to that repo's `main`.** Not a rename, not a redirect, not a "small tweak."
- **Do not delete or rewrite the `data` branch.** The hourly collector commits there and the
  live site fetches its overlays from `raw.githubusercontent.com/.../data/...`. Breaking it
  breaks the live site's dispatch, deeds, and Pulse tabs.
- **Do not disable `.github/workflows/dispatch.yml`.** It is the *only* thing keeping the
  LRPD daily-report archive alive (the city deletes PDFs after ~a week) and the only thing
  accumulating the dispatch archive. If you migrate collection to GCP, run the new collector
  **in addition** until you have proven parity, then decide with the user.
- **Do not revoke or repoint the Cloudflare Worker** `pulaski-deeds.brandongrant.workers.dev`.
  The live site reads its URL from `web/data/services.json` and uses it for in-popup deed history.
- Treat `pulaski_building_map` as **read-only upstream**. All new work happens on the
  **`v2`** branch of `brandongrant/gods-eye-view` (this repo), consuming Pulaski data over HTTPS.

### An ambiguity to resolve with the user before spending money

"GCS" most likely means **Google Cloud (GCP) project**, because God's Eye View *requires* a
Google Maps Platform **Map Tiles API** key for its photorealistic 3D planet — which is a GCP
product, billed, and needs a project with billing enabled. This document assumes that reading.

If the user literally meant **Google Cloud Storage static hosting only**, say so up front:
**a GCS bucket alone cannot run this app.** See §5.3 — roughly half the layers depend on
server-side proxies that only exist inside the Vite dev server.

---

## 1. Repository and branch map — read this before you touch anything

There are two repos, many branches, several stale worktrees, and one very easy way to
destroy shipped work. This section is the map.

### 1.1 `brandongrant/pulaski_building_map`

| Ref | What it is | Trust |
|---|---|---|
| **`origin/main` = `8a4bdd9`** | **Canonical HEAD.** Everything shipped. Deploys the live Pages site. | source of truth |
| `origin/data` | Collector storage branch. Hourly commits from GitHub Actions. Latest seen `7709946` (`collect: 2026-08-25T01:49:33Z`) — actively running. | live, append-only |
| local `main` | **Stale** — sits at `d201acc`, 54 commits *behind* origin/main. | ignore |
| local `vehicle-search` | Stale pre-merge feature line (already merged via `codex/integrate-vehicle-deed-proxy`). | ignore |
| `claude/lr311-overlay` | **Unmerged, valuable.** Adds `pipeline/sr311_collect.py` (Little Rock 311 / CWI collector) + a 311 map overlay. Built on the *ES-module* lineage. | see 1.2 |
| `claude/phase1-canonical` | **Unmerged, valuable.** Canonical property model, loader, `worker/profile-api/` Cloudflare Worker, property profile drawer. Same ES-module lineage. | see 1.2 |
| every other `claude/*` / `codex/*` branch | Already merged into `origin/main`, or superseded. | ignore |

**Local worktrees on this machine** (`git worktree list` from `D:\Claude Code Projects\Building_Map`):

```
D:\Claude Code Projects\Building_Map                                    vehicle-search   (STALE)
  .claude\worktrees\surveillance-devices-map-929673                     == origin/main   (USE THIS ONE)
  .claude\worktrees\crime-reports-visualization-223eae                  stale lineage
  .claude\worktrees\elegant-allen-733b4f                                superseded deeds UI
  .claude\worktrees\owner-index-refresh-20260711                        superseded
  .claude\worktrees\pulaski-building-map-continue-398465                superseded
  .claude\worktrees\sharp-payne-7096cd                                  superseded
  .codex\worktrees\discovery-ui                                         superseded
D:\Claude Code Projects\Building_Map_data                               data branch — STALE (seed commit only)
```

> **The only checkout that matches `origin/main` is
> `D:\Claude Code Projects\Building_Map\.claude\worktrees\surveillance-devices-map-929673`.**
> The `Building_Map_data` checkout is at the *seed* commit and is missing months of collection —
> `git pull` it or use `git show origin/data:<path>` instead.

### 1.2 The ES-module fork in the road (a real trap)

`origin/main` carries a **monolithic** frontend: `web/app.js` (84 KB) + `web/pulse.js` + `web/watch.js`.

A parallel line (`claude/pulaski-building-map-continue-398465` → `claude/lr311-overlay` →
`claude/phase1-canonical`) split `app.js` into 13 ES modules under `web/js/` — but branched
**before** the crime/Pulse/Watch work landed, so those branches *delete* `pulse.js` and `watch.js`.

**Do not merge those branches into main to "get" the 311 collector.** You would silently drop
the Pulse and Watch tabs. Cherry-pick `pipeline/sr311_collect.py` and the `sr311/*` output
contract instead. (311 data already exists on `origin/data` at `sr311/out/requests.geojson`,
4.5 MB, collected 2026-06 → 2026-07, then stopped — the collector was never merged into the
hourly workflow.)

### 1.3 `brandongrant/gods-eye-view`

Fork/mirror of `bilawalsidhu/gods-eye-view` (MIT). 4 commits, latest `880a672`
*"Release God's Eye View as open source."* Vanilla JS + CesiumJS + Vite, no framework.

---

## 2. Complete capability inventory — what the Pulaski platform actually does

This is the thing being merged in. Nine distinct capabilities, all on `origin/main`.

### 2.1 Building map (the base layer)

225,774 building footprints for all of Pulaski County, served as a **PMTiles** vector tileset
(`web/data/buildings.pmtiles`, 67 MB, z8–z15), rendered in MapLibre GL.

- **Color by:** year built · building type · stories · building sq ft · footprint area ·
  improvement value · improvement $/sq-ft · vehicles at address · personal-property value
- **Palettes:** Colouring-London, Amsterdam-fire, Viridis, Magma, Turbo, Cividis, Cool-Warm (+ flip)
- **Filters:** year-built range (+ include-undated), building-type chips, "main buildings only"
  (largest footprint per parcel)
- **3D:** extrusion by assessor story count with exaggeration control
- **Basemaps:** pure black default; optional CARTO dark/light, OSM raster
- Hover tooltip / click popup with address, year, type, size, value, owner, permit timeline,
  deed timeline

### 2.2 Owner / address search

`web/data/owners.json` (18.4 MB) — 133,387 owners across 180,230 parcels, built by
`pipeline/build_owner_index.py` streaming the PAgis parcel layer. Search by owner name or street
address; flags **every** property an owner holds; popup shows owner (click → their other
properties) plus deed/assessor/treasurer lookup links. 100 % of addressed buildings resolve an owner.

### 2.3 Vehicle search (assessor personal property)

`web/data/vehicles.json` (10.6 MB) — 290,006 vehicles across 105,659 addresses. Search by
make / model / year → magenta clustered pins at matching situs addresses. Interned
makes/models/cities + a flat `[locIdx, year, makeIdx, modelIdx]` table filtered client-side.
Capped at **6 vehicles per address** (upstream `enrich_pp` cap), so dealer/apartment lots are
partial by design.

### 2.4 Permit overlay

`web/data/permits/permits.geojson` (16.7 MB) — ~63k City of Little Rock permits, 2019→present,
11 derived categories (new construction, addition, remodel/repair, demolition, roofing, trades,
unsafe/vacant, sign, other…), geocoded 97.9 % via the PAgis address index.
Contractor/applicant names **deliberately excluded**. Building popups show an address-matched
permit timeline. **Manual refresh** (date-stamped CSV from the city page). NLR permits are
deferred — their WP File Download portal needs a dedicated parser.

### 2.5 Live dispatch overlay (calls for service)

The flagship live feed. `pipeline/dispatch_collect.py` polls the City of Little Rock public CAD
endpoint (`web.littlerock.state.ar.us/pub/Home/CadEvents`), dedupes by `hash(type+location+time)`,
categorizes into ~20 buckets, geocodes, and appends JSONL to the `data` branch.

Published outputs on `origin/data`:

| File | Size | Contents |
|---|---|---|
| `dispatch/out/all.geojson` | 3.75 MB | every geocoded call, all-time |
| `dispatch/out/grid_30d.geojson` | 1.64 MB | ~500 ft cells, per-category counts |
| `dispatch/out/recent_7d.geojson` | 271 KB | bare points, heatmap |
| `dispatch/out/recent_24h.geojson` | 78 KB | last-24 h points |
| `dispatch/out/stats.json` | 599 B | totals, geocode-quality, per-category |
| `dispatch/raw/YYYY-MM.jsonl` | ~1.9 MB/mo | append-only archive |
| `dispatch/address_index.json.gz` | 4.5 MB | PAgis address-point geocoder |

Current stats (2026-08-25): **15,629 calls collected since 2026-07-06**, 15,287 placed,
**97.8 % geocode rate** (13,110 exact address · 1,764 intersection · 413 interpolated · 342 failed).

**Geocoding policy (fixed 2026-07-13, do not regress):** canonicalize street-type/direction
synonyms → exact lookup → house-number interpolation along the street → real intersections.
**No street-centroid fallback** — it used to dump every unmatched call on one averaged point,
producing phantom hotspots at wrong addresses. Outputs are **re-geocoded from the archived
location string on every run**, so matcher fixes retroactively re-score all history.

**Display policy:** every call type is mapped as a precise point, indefinitely (site-owner
decision 2026-07-13, overriding an earlier aggregate-only rule). Sensitive types
(medical/welfare/death/sex/domestic/juvenile) are still **flagged** (`sens: 1`) to drive a
popup note. Language is *calls for service* throughout — a dispatch is not a confirmed crime.

Feature shape:
```json
{"type":"Feature","geometry":{"type":"Point","coordinates":[-92.260913,34.724785]},
 "properties":{"t":"Suspicious Person","c":"suspicious","ts":"2026-07-06T19:47:52Z",
               "loc":"1100 E Roosevelt Rd","gq":"exact_address","sens":0}}
```

### 2.6 Reported crimes 2017–2025

`web/data/crime/crimes.json` (5.3 MB) — 114,742 LRPD index/Part-I offenses (violent + property),
2017 → Feb 2025, from a bulk statistics CSV that already carries LRPD's own lat/lon (no geocoding).
6,073 incidents whose location LRPD suppresses (all RAPE rows + others) are counted but not plotted.
Categorized with the **dispatch taxonomy** so they merge into the dispatch overlay's *all-time
points* mode — same chips, same colors, plus a 2017→now year slider.

Compact interned structure (`offenses`, `off_cat`, `statuses`, `weapons`, `locs[32,673]`,
`crime[114,742]`), expanded client-side — deliberately not a heavy GeoJSON.

### 2.7 Recorded documents (deeds) — collector + live Worker

Two mechanisms:

**(a) Harvest.** `pipeline/deeds_collect.py` runs 8 gentle queries per hourly workflow run
against the Pulaski Circuit/County Clerk index (pulaskideeds.com), one recording-day ×
instrument-type group at a time. Archived to `deeds/raw/YYYY-MM.jsonl` on the `data` branch,
matched to parcels via a subdivision/lot/block crosswalk (`deeds/legal_index.json.gz`, 5.7 MB),
published as `deeds/out/recent_activity.geojson` (2.6 MB) + `stats.json`. Coverage 2026-04-01 →.
**Military discharges (`DCH`) and medical-record authorizations (`ARM`) are never collected.**

**(b) Live per-parcel lookup.** `worker/pulaski-deeds.js` — a deployed **Cloudflare Worker** at
`https://pulaski-deeds.brandongrant.workers.dev` (URL lives in `web/data/services.json`, never
hard-code it). `GET /deeds?sub=&lot=&blc=` runs the county's legal-description search server-side
and returns a deduped JSON chain of title with grantor/grantee, current-owner heuristic, 20-year
window, **7-day Cache API TTL** so the county site is hit at most once per parcel per week.

### 2.8 LRPD daily incident reports → the **Pulse** tab

LRPD publishes a complete-incident-report PDF each weekday and **takes it down after about a week**
— the archive exists only because the collector keeps checking.

`pipeline/reports_collect.py` (self-throttled to one listing fetch per 4 h) scrapes the daily-reports
page and parses each packet with `pipeline/lrpd_reports.py` — a **geometric** reader of LRPD Form
5501 (field boxes fixed to the point; the red "Redact Before Release" stamp filtered out *by colour*
before words are assembled). ~⅓ of PDFs are scans with no text layer; recoverable content is kept
and marked `partial`.

**Privacy contract (pinned by `tests/test_lrpd_reports.py` against
`reports_collect.PUBLISH_FIELDS`):** published record is **incident-level only** — number, date/time,
call type, statutory offenses, district, address, dispatch category, geocode. Narratives *are read*
to derive mechanical tags (firearm, forced entry, property taken, suspect fled, arrest made…) and
then **discarded**. Nothing person-level is written to disk or served. Every case links to the
city's own PDF.

`pipeline/build_pulse.py` folds the dispatch archive + daily reports + the 2017–2025 offense export
into a single ~99 KB `pulse/out/pulse.json` (America/Chicago buckets), so the tab renders instantly.
Frontend is `web/pulse.js` — **hand-built SVG, no chart library**:

| Panel | What it shows |
|---|---|
| **The clock** | 24-h dial; outer ring = all calls, inner = shots/assault/robbery, each self-scaled |
| **The week** | 168 weekday-hour squares |
| **What** | Category leaderboard, last-7-days + WoW delta; click to filter every other panel |
| **Where** | Abstract quarter-mile hex mosaic, no basemap or labels; click a cell → opens on the map |
| **Corridors** | Recurring street names, split by category |
| **Risk assessment** | Per-location statements ("higher risk of theft at Walmart (2700 S Shackleford) on Friday, most likely between 2 and 4 PM"); click → flies the map there at building zoom with dispatch on |
| **Case files** | Parsed daily reports as cards + link to the city PDF |
| **The long view** | Month-of-year shape of 115k offenses over complete years |

**How a risk statement is built** (three datasets with opposite gaps — offenses reach to 2017 but
carry *no time of day*; dispatch has real timestamps but is weeks long and is *calls*, not offenses;
daily reports are richer and rarer):
- **Where** — offenses grouped by LRPD's recorded address; a location with no offense record still
  qualifies on ≥14 *reportable* calls
- **What/when (day)** — that location's own record, expressed as a **lift** over its own average day
- **When (hour)** — that location's dispatch calls once ≥25 exist; otherwise the citywide clock,
  and the card says so
- **Which business** — nearest named PAgis footprint within **45 m**
  (`pipeline/build_place_index.py`, 11.7k named buildings); beyond that it falls back to the bare
  address. Per-building suffixes stripped (`Fair Oaks Apts - Bldg 8` → `Fair Oaks Apts`).

Two honesty guards you must not remove:
1. **Current-only places qualify on reportable categories, not raw call volume** — rank by total
   calls and the board fills with the county jail (prisoner transports) and a homeless shelter
   (welfare checks): places police are sent *to help*.
2. **Rates are normalised before ranking** — citywide, reportable calls run ~4× more frequent than
   reported offenses (`call_to_offense` in `pulse.json`); unscaled, every call-based entry outranks
   every offense-based one. Call-derived cards are tinted and labelled.

The section carries its own caveat and it must survive any port: **these are concentrations, not
personal odds.** No footfall denominator; one address can absorb a whole shopping centre.

### 2.9 **Watch** tab — surveillance devices and their paper trail

`pipeline/build_surveillance.py` → `web/data/surveillance/devices.geojson` (209 KB, **525 devices**).

| Source | Gives |
|---|---|
| ARDOT published camera layer | ~190 state traffic cameras, model + live `.m3u8` stream URL |
| LRPD reader list (FOIA `PDFOIA-2025-4004`) | all 116 Flock plate readers, geocoded |
| OpenStreetMap `man_made=surveillance` (DeFlock tagging, ODbL) | readers + gunshot sensors nobody published |
| `pipeline/surveillance/sightings.json` | devices photographed from the road, scored against the published list |

Counts by family: traffic 191 · alpr 313 · gunshot 11 · camera 1 · sighting 9.
By program: ardot-cctv 194 · flock-lrpd 132 · flock-unattributed 136 · shotspotter 11 · other-alpr 34
· flock-other 9 · lvt-tower 2 · unidentified 3 · …

A reader and a volunteer point within **70 m** are treated as the same pole; the authoritative record
keeps the pin and inherits the volunteer's recorded direction. Each field sighting carries an explicit
confidence (`confirmed`/`likely`/`probable`/`uncertain`), the reasoning, and what evidence would
settle it — several are deliberately filed as *not identified*.

**The paper trail.** `pipeline/surveillance_docs.py add <url-or-file> --program flock-lrpd` fetches a
public record, extracts text (PDF/HTML/plain), and pulls dollar figures, resolution numbers, account
codes, cooperative-contract numbers and vendor names **as literal strings that appear in it**. The
extracted text is committed to `pipeline/surveillance/doc_text/` beside the entry so every figure
shown is checkable against source. 16 documents so far.
**Nothing is summed into a headline total** — renewals and amendments overlap, so the page shows
authorizations as a sequence of decisions.

Feature shape:
```json
{"type":"Feature","properties":{"id":"ardot-249","fam":"traffic","prog":"ardot-cctv",
 "lbl":"State Hwy. 440 at Mile Marker 12","src":"ardot","public":1,"route":"440",
 "model":"AXIS P5635-E Mk II","url":"https://actis.idrivearkansas.com/.../249.m3u8"},
 "geometry":{"type":"Point","coordinates":[-92.159234,34.80091]}}
```

### 2.10 Foundation / engineering plumbing (already built)

- `pipeline/common/settings.py` — central paths + rotating source URLs; `PULASKI_DATA_ROOT` env
- `pipeline/common/provenance.py` — source fingerprints, build manifest, derived-freshness
- `jurisdictions/ar/pulaski.yml` — **source manifest**: for every dataset, the owner, service URL,
  entity grain, refresh cadence, **sensitivity class**, and **display policy**. Connectors and
  freshness displays are supposed to read this rather than hard-code URLs.
  Sensitivity classes: `public_property` · `public_property_event` · `sensitive_location_event`
- `pipeline/check_quality.py` — release gate; non-zero exit = do not publish
- `tests/` — 11 test modules incl. `test_dispatch_sensitivity`, `test_lrpd_reports`,
  `test_pulse`, `test_surveillance`, `test_geocode`, `test_provenance`
- `docs/IMPLEMENTATION_ROADMAP.md` — **2,740 lines**, the platform's product/architecture bible
  (phases 0A→8, canonical property schema, query DSL, entity-resolution ladder, privacy rules
  §16, acceptance queries Appendix A). Read §16 before publishing anything person-adjacent.

---

## 3. Published data assets — the complete inventory to fuse

### 3.1 Static, committed on `origin/main` under `web/data/` (served by GitHub Pages today)

| Path | Size | Grain |
|---|---|---|
| `buildings.pmtiles` | 67.2 MB | 225,774 building footprints, z8–z15 |
| `owners.json` | 18.4 MB | 180,230 parcels / 133,387 owners |
| `permits/permits.geojson` | 16.7 MB | ~63k permits 2019→ |
| `vehicles.json` | 10.6 MB | 290,006 vehicles / 105,659 addresses |
| `crime/crimes.json` | 5.3 MB | 114,742 offenses 2017–2025 |
| `places.json` | 537 KB | 11.7k named buildings |
| `surveillance/devices.geojson` | 209 KB | 525 devices |
| `pulse/pulse.json` | 93 KB | committed fallback snapshot |
| `surveillance/documents.json` · `programs.json` · `meta.json` | 61 / 34 / 5 KB | paper trail |
| `config.json` · `permits_meta.json` · `crimes_meta.json` · `services.json` | small | UI domains, stats, service URLs |

**Total ≈ 119 MB.** All of it is fetchable today over HTTPS from either GitHub Pages or
`raw.githubusercontent.com` — you do not need to rebuild any of it to start.

### 3.2 Live, on the `data` branch (rewritten hourly)

`dispatch/out/*` · `deeds/out/*` · `reports/out/*` · `pulse/out/pulse.json` · `sr311/out/*`
(311 exists but is stale — collector unmerged). Plus append-only `*/raw/YYYY-MM.jsonl` archives
and the two big indexes (`dispatch/address_index.json.gz`, `deeds/legal_index.json.gz`).

Base URL pattern the frontend already uses:
```
https://raw.githubusercontent.com/brandongrant/pulaski_building_map/data/<path>
```

### 3.3 Gitignored bulk inputs (local only, `D:\Claude Code Projects\Building_Map\data\processed\`)

`buildings_final.pkl` (tiler input) · `parcel_owners.pkl` · `cama_parcel_attrs.pkl` ·
`legal_index.json.gz` · `address_index.json.gz`.
Raw PP dumps were **deleted** (disk pressure) — `buildings_final.pkl` is the only remaining
vehicle-level source. Do not plan a rebuild that assumes the raw dumps exist.

---

## 4. The scheduled updates as they exist today

`.github/workflows/dispatch.yml` — **`cron: "7 * * * *"` (hourly)** + `workflow_dispatch`,
`concurrency: dispatch-collect`, `permissions: contents: write`.

```
checkout main
checkout data → ./datastore
setup-python 3.12
pip install requests pdfplumber
python pipeline/dispatch_collect.py --store datastore
python pipeline/deeds_collect.py    --store datastore --max-queries 8   (continue-on-error)
python pipeline/reports_collect.py  --store datastore --min-interval-hours 4  (continue-on-error)
python pipeline/build_pulse.py      --store datastore
commit + push to data (retry ×3 with pull --rebase)
```

Why hourly and not `*/15`: every run rewrites `all.geojson` (~3 MB), so a 15-minute cadence added
96 fresh copies a day for nothing — the CAD feed is delayed 30 min–8 h anyway and its window holds
several hours of events.

`.github/workflows/pages.yml` — publishes `web/` to GitHub Pages on push to `main`. **Leave alone.**

### Collector CLIs (for reproducing on GCP)

| Script | Arguments |
|---|---|
| `dispatch_collect.py` | `--store <dir>` (req) · `--rebuild-only` |
| `deeds_collect.py` | `--store` (req) · `--max-queries N` (default 2) · `--start YYYY-MM-DD` (default 2026-04-01) |
| `reports_collect.py` | `--store` (req) · `--min-interval-hours 4.0` · `--force` · `--rebuild-only` |
| `build_pulse.py` | `--store` (req) · `--out <path>` |
| `build_addr_index.py` | `--raw <geojson>` (else streams PAgis) |
| `build_crime.py` | `--csv <path>` (default `RAW_DIR/lrpd_crime.csv`) |
| `build_surveillance.py` | `--offline` |
| `build_permits.py`, `build_owner_index.py`, `build_place_index.py`, `build_legal_index.py`, `build_vehicle_index.py`, `check_quality.py` | no args |

`--max-queries 0` on `deeds_collect.py` = pure re-match run, **no network**.

> GitHub disables scheduled workflows after ~60 days without repo activity. Any commit
> re-enables. If you migrate collection off GitHub and the repo goes quiet, the GitHub cron dies —
> which is fine only if the GCP job is proven first.

---

## 5. God's Eye View — what you are deploying

### 5.1 Shape

Vanilla JS + **CesiumJS** + **Vite**. No framework, no backend service. Node engine pinned:
**`>=24.14.0 <25 || >=26 <27`**.

```
src/
├── main.js                 # bootstrap: Google 3D tiles, layer registration
├── ui.js / hud.js          # panels, HUD, styles, AI scene summary
├── mapStackController.js   # Google 3D / Bing / OSM
├── voice/                  # OpenAI Realtime session + 28 voice tools
├── data/                   # one module per layer + manager + context store
│   └── local_data/         # bundled datasets, per-folder provenance
└── scenes/                 # cinematic scene director
vite.config.js              # ~5.5k lines — ALL /api/* proxy middleware lives here
```

Authoritative runtime reference: `docs/CURRENT-STATE.md` (2,584 lines). Known gaps:
`docs/KNOWN-ISSUES.md`.

### 5.2 The 16 shipped layers

flights (OpenSky + adsb.lol fallback) · military flights · AIS vessels · mapped installations ·
earthquakes (USGS) · satellites (CelesTrak, ~840-object core + Starlink DENSE chip) ·
space missions (Launch Library 2) · traffic (Overpass + optional TomTom) · CCTV (~800 cameras:
Austin, Caltrans, TfL London) · radio (Radio Browser, analog tuner) · bikeshare (GBFS) ·
datacenters (4,351, bundled) · dams (704, bundled) · submarine cables (712, bundled) ·
FIRMS active fires · military awareness (internal Contacts coordinator, not user-visible).

### 5.3 The deployment reality — read before choosing GCP hosting

**`vite build` produces a static `dist/`, but roughly half the layers break on a static host.**
Every `/api/*` endpoint is a Vite plugin in `vite.config.js`. Only some register
`configurePreviewServer`. Measured:

**Survive `vite preview` (9):** `radio-browser` · `rocket-launches` · `ais-live` ·
`track-backfill` · `openai-realtime` · `google-places-context` · `military-installations` ·
`regional-brief` · `weather-effects`

**Dev-server only — DEAD on a static host or under `vite preview` (10):**
`celestrak` · `tomtom` · `firms` · `terrain-heights` · `adsbdb` · `overpass`
(also serves `/api/route`) · `opensky` · `gbfs` · `cctv` · `adsblol`

That means a plain **GCS-bucket deployment loses satellites, flights, military flights, traffic,
routing, CCTV, bikeshare, fires, aircraft metadata, and terrain heights.** Also `vite preview`
is explicitly not a production server.

**Consequence for the plan:** you need a **Node process** in front, i.e. **Cloud Run**. Two paths:

| Path | Effort | Result |
|---|---|---|
| **A. Cloud Run running Vite** (`vite preview` or `vite` behind the container) | low | works, but 10 proxies still missing under preview; running the dev server in prod is the thing upstream says not to do |
| **B. Extract the proxies into a small Express/Fastify server** that serves `dist/` and mounts the same handlers, deployed to Cloud Run | medium — the handlers are already self-contained middleware functions, so this is mostly mechanical | **recommended.** Real prod server, all layers live, keys stay server-side, per-IP throttles keep working |

Upstream's own framing: *"a fast, hackable foundation, not a hardened production service"* and
*"generation semantics assume the app's actual single-process dev-server deployment; concurrent
replicas behind one origin are out of scope."* → **pin Cloud Run to `min-instances=1, max-instances=1`**
unless you first fix the Radio catalog-generation assumption.

### 5.4 Keys, and what they cost

| Key | Needed for | Exposure |
|---|---|---|
| **`GOOGLE_MAPS_API_KEY`** (required, metered) | photorealistic 3D planet, Map Tiles API | **CLIENT-EXPOSED by design** — restrict by HTTP referrer + API |
| `CESIUM_ION_TOKEN` (optional) | Bing imagery stacks | **CLIENT-EXPOSED** — public `assets:read` token, URL-restricted |
| `OPENAI_API_KEY` (metered) | voice + AI HUD summary | server-side only; browser gets ephemeral Realtime tokens |
| `AISSTREAM_API_KEY` (free) | live vessels | server-side |
| `FIRMS_MAP_KEY` (free) | active fires | server-side |
| `TOMTOM_API_KEY` (free tier) | real traffic instead of simulation | server-side |
| `OPENSKY_CLIENT_ID/SECRET` (free) | more flight-polling credits (`anon` works) | server-side |
| `LL2_API_TOKEN` (free) | higher space-missions allowance | server-side |

Guards: `GEV_RATELIMIT_GOOGLE_PER_MIN`, `GEV_RATELIMIT_OPENAI_PER_MIN` are **per-IP, in-memory,
process-local — not billing caps.** OpenAI voice has an in-app **$5 session cap** and warns at $2.

> **On a publicly reachable deployment your Google key brokers billable tile sessions to
> anyone who loads the page.** Before the first public URL: set a Cloud Billing **budget +
> alerts**, per-API **quotas**, and HTTP-referrer restriction to your exact Cloud Run domain.
> This is the single biggest cost risk in the whole plan.

---

## 6. Target architecture on Google Cloud

```
                  ┌─────────────────────────────────────────────┐
   browser ──────▶│  Cloud Run: gods-eye-view (Node, 1 instance)│
                  │  · serves dist/ (Vite build)                │
                  │  · mounts /api/* proxies (extracted)        │
                  │  · secrets from Secret Manager              │
                  └───────────────┬─────────────────────────────┘
                                  │ fetches Pulaski layers
                  ┌───────────────▼─────────────────────────────┐
                  │  GCS bucket: gev-pulaski-data (public read) │
                  │  · buildings.pmtiles  (Range requests)      │
                  │  · owners/vehicles/permits/crime/...        │
                  │  · dispatch/, deeds/, reports/, pulse/      │
                  └───────────────▲─────────────────────────────┘
                                  │ writes
                  ┌───────────────┴─────────────────────────────┐
                  │  Cloud Run Job: pulaski-collectors          │
                  │  (dispatch + deeds + reports + build_pulse) │
                  │  ◀── Cloud Scheduler, hourly at :07         │
                  └─────────────────────────────────────────────┘
```

### 6.1 Project + API setup

New GCP project (suggest id like `gods-eye-view-<suffix>`), billing enabled, then enable:
`maptiles.googleapis.com` (Map Tiles API) · `places-backend.googleapis.com` (Places, for voice
context/annotation resolution) · `run.googleapis.com` · `cloudscheduler.googleapis.com` ·
`secretmanager.googleapis.com` · `artifactregistry.googleapis.com` · `cloudbuild.googleapis.com` ·
`storage.googleapis.com` · `logging`/`monitoring`.

Two service accounts: `gev-run@` (Cloud Run — Secret Manager accessor, GCS object *viewer*) and
`pulaski-collector@` (Cloud Run Job — GCS object *admin* on the data bucket only).

**Set a billing budget with alerts before deploying anything that serves tiles.**

### 6.2 Data bucket

`gs://gev-pulaski-data`, uniform bucket-level access, `allUsers: objectViewer` (public read),
CORS allowing the Cloud Run origin, **and `Accept-Ranges` working** — GCS supports HTTP Range
natively, which is exactly what PMTiles needs. Cache-Control: long TTL on the static 119 MB set,
short (`max-age=300`) on the hourly `*/out/*` files.

### 6.3 Why not just point at GitHub

You can, initially — `raw.githubusercontent.com` already serves everything and requires zero
migration. Use that for **Phase 1** to get something on screen fast. Move to GCS when you want
(a) rate-limit headroom, (b) CORS you control, (c) the collectors writing somewhere that isn't
the live site's data branch.

---

## 7. Integration plan — Pulaski layers inside God's Eye View

### 7.1 Layer-by-layer mapping

| Pulaski capability | GEV representation | Notes |
|---|---|---|
| **Surveillance devices** (525) | new `pulaski-surveillance` local GeoJSON layer | **Start here.** Smallest (209 KB), already a clean GeoJSON of points, and thematically the closest fit to GEV's existing infrastructure layers (datacenters/dams). Near-zero risk. |
| **Dispatch calls** (all.geojson, 3.75 MB) | live layer polling the hourly output | Second. Needs time filtering + category colors. |
| **Reported crimes** (114,742) | merged into the dispatch layer, year-sliced | Same taxonomy already; mirror the existing merge. |
| **Permits** (63k) | live/bundled point layer with year + type + min-value filters | 16.7 MB — convert to a compact interned table like `crimes.json`, or tile it. |
| **Deeds** (`recent_activity.geojson`, 2.6 MB) | point layer + per-parcel Worker lookup on click | Worker stays on Cloudflare, or port to a Cloud Run endpoint. |
| **Buildings** (67 MB PMTiles) | **hardest.** Cesium wants 3D Tiles / GeoJSON, not MapLibre vector tiles. Options: (a) `@mapbox/vector-tile` + `pbf` are **already GEV dependencies** — decode PMTiles client-side and feed Cesium primitives per viewport; (b) re-tile to Cesium 3D Tiles offline; (c) keep the MapLibre map as a *second view*. | Decide with the user — see §11. |
| **Owner / vehicle search** | UI panel + voice tool | **collides with GEV's stated policy** — see §7.3. |
| **Pulse tab** | a panel or a separate route; SVG is framework-free so it ports cleanly | Not a globe layer. |

### 7.2 The exact extension contract in GEV (verified by reading the source)

Adding a layer touches **five** places. Miss any of the last three and the app throws at boot —
`finalizeRegistrations()` asserts the registry and the manager agree exactly.

1. **`src/data/local_data/<yourset>/`** — the data file + a `README.md`/`SOURCE.md` recording
   provenance (every existing folder has one; match it).
2. **`src/data/localLayers.js`** — import the asset with Vite's `?url` suffix and build the layer:
   ```js
   import pulaskiSurveillanceUrl from './local_data/pulaski_surveillance/devices.geojson?url';

   const pulaskiSurveillance = createLocalGeoJsonLayer({
     id: 'local-pulaski-surveillance',
     url: pulaskiSurveillanceUrl,
     name: 'Pulaski Surveillance',
     color: '#ff3366',
     icon: '◉',
     source: 'PAgis / ARDOT / LRPD FOIA / OSM',
     labels: true, labelMax: 600, labelGridPx: 130,
   });
   export default [datacenters, dams, submarineCablesLayer, fires, pulaskiSurveillance];
   ```
   (`createLocalGeoJsonLayer` in `src/data/localGeojson.js` gives you Cesium loading, labels,
   ground sampling, click→context cards, and overlay integration for free.)
3. **`src/data/layerState.js` → `LAYER_STATE_REGISTRY`** — add
   `{ id: 'local-pulaski-surveillance', token: '<unused single char>', disposition: 'enabled-only' }`.
   Tokens in use: `a b c d e f g i m q r s t u w x`. **The token is the share-link serialization
   character — never change it once shipped**, or old share links resolve to the wrong layer.
4. **`src/data/dataCredits.js` → `DATA_CREDITS`** — add the attribution entry. The file states the
   rule explicitly: *"if you add a data source, add it there AND here"* (there = `DATA_SOURCES.md`).
5. **`DATA_SOURCES.md`** — the machine-readable license/attribution index. Strings in
   `dataCredits.js` are copied verbatim from it.

Live (polling) layers instead follow the module shape in `src/data/bikeshare.js` / `earthquakes.js`
and are registered in `src/main.js` with `dataManager.register(...)` **before**
`finalizeRegistrations()`.

If you want voice control of the layer, also add it to the voice tool enum in `src/voice/`.

### 7.3 A policy collision you must surface to the user, not decide alone

God's Eye View's README states its scope boundary plainly:

> *"This project models events, assets, infrastructure, and systems... It does not build features
> for named-person search, face recognition, or tracking individuals, and pull requests that cross
> that line won't be merged. People are not a query type here."*

The Pulaski platform's **owner-name search** and **vehicle make/model search** are name- and
person-adjacent by construction (they are public assessor records, but they resolve to individuals
at addresses). The project's own roadmap flags this too — `jurisdictions/ar/pulaski.yml` sets
`sensitivity: public_person` on the PP dumps with `no_bulk_export: true`, and roadmap §16.3 says
*"re-evaluate the public make/model search before broader marketing."*

This is not a blocker for a **private, self-hosted** instance — it is the user's own data on the
user's own deployment, and it is already public on their existing site. But it **is** a blocker for
upstreaming, and it changes what "public URL" should mean. **Ask the user:**
- private instance (Cloud Run + IAP / Identity-Aware Proxy), or public?
- if public: do owner and vehicle search ship, or stay behind auth?

Default recommendation if the user doesn't answer: **put the whole deployment behind IAP.** It
solves the person-data question and the Google-key billing-abuse question in one move.

### 7.4 Suggested phasing

**Phase 1 — prove the pipe (half a day).**
New GCP project + billing budget + Maps key. Fork/clone GEV, `npm install`, `npm run dev`, confirm
the globe loads. Add **one** bundled layer: `devices.geojson` (525 points) pulled straight from
`raw.githubusercontent.com`. Verify all five registration points. `npm run build`, `npm test`,
`npm run test:track` all green.

**Phase 2 — real hosting.** Extract the 19 proxy plugins into an Express server that also serves
`dist/`. Dockerfile → Artifact Registry → Cloud Run (`min=1, max=1`). Secrets in Secret Manager.
Restrict the Maps key to the Cloud Run domain. Confirm all 16 upstream layers still work
(especially the 10 dev-only proxies).

**Phase 3 — Pulaski data to GCS.** Copy the static 119 MB into `gs://gev-pulaski-data`. Verify
Range requests on `buildings.pmtiles`. Point the new layers at the bucket.

**Phase 4 — scheduled updates on GCP.** Containerize the collectors (§8). Cloud Run Job + Cloud
Scheduler hourly at :07. Run **in parallel** with the GitHub Actions workflow until outputs match
byte-for-byte on `stats.json` totals for a full day.

**Phase 5 — the buildings question.** Only after 1–4 land. See §11.

**Phase 6 — Pulse + Watch panels**, deeds/permits/crime layers, voice tools.

---

## 8. Migrating the scheduled collectors to GCP

The collectors were written against a **git checkout** as their store (`--store datastore`) and
they *rewrite all outputs from the raw archive on every run* — that's a feature (matcher fixes
retroactively re-score history), and it means the store must be **read-write and durable**.

Two viable stores:

**(a) Keep git.** Cloud Run Job clones the `data` branch (or a new `gev-data` branch/repo), runs
the four scripts unchanged, commits, pushes. Zero code change. Needs a deploy key in Secret
Manager. **Do not push to the existing `data` branch** unless you have decided to converge —
create a separate branch or repo so the live site is insulated.

**(b) Move to GCS.** Mount `gs://gev-pulaski-data` via **Cloud Storage FUSE** at the path passed
to `--store`. Also nearly zero code change, and it drops git entirely. Watch out: the scripts do
whole-file rewrites of multi-MB outputs each run — fine on GCS, but set the job timeout generously.

Job definition sketch:
```
FROM python:3.12-slim
RUN pip install requests pdfplumber
COPY pipeline/ /app/pipeline/
# entrypoint runs the four steps in order, mirroring dispatch.yml,
# with deeds + reports tolerating failure (they are `continue-on-error` today)
```
Cloud Scheduler → `cron: 7 * * * *`, timezone UTC (matches the GitHub cron; note the pipeline
buckets *display* in America/Chicago).

**Preserve these behaviours or the data degrades:**
- `deeds_collect.py --max-queries 8` per run and no more — the county DB is shared and a search
  costs ~1 s per result row against a hard ~180 s server cap. Politeness is a design constraint,
  not a tuning knob.
- `reports_collect.py --min-interval-hours 4` — the self-throttle is independent of how often the
  job fires, so a more frequent schedule does not hammer the city.
- `concurrency: dispatch-collect` — Cloud Run Jobs need the equivalent (`--parallelism 1`, and
  do not let a slow run overlap the next trigger).
- `build_pulse.py` runs **last**, every run.

---

## 9. Hard-won facts — do not re-derive these

**pulaskideeds.com** (measured live 2026-07-06):
session = `GET /search/index.php` → `POST Accept=Accept` → cookie + per-session `random` token in
the form HTML. A search = `POST ajaxActions.php {action:'storeDataString', dataString:<urlencoded
form>}` **with header `X-Requested-With: XMLHttpRequest`**, then
`GET content.php?embedded=1&...` on the same session — query params passed to `content.php`
directly are **ignored**. `instType[ALL]` is **not** expanded server-side; send all 88 codes from
`pipeline/deeds_inst_codes.json`. Cost ~1 s per result **row**, hard ~180 s cap → 92-byte error
body; load-dependent, so an identical query can fail then succeed — retry across runs, never loop.
Keep any (day × group) under ~150 rows. Results have **one row per party side** — merge by `inst`.
The verified index lags recording by 2–4 weeks. Cold deep links to document details are blocked
without a session (46-byte "County and/or state have not been set properly"), so per-document rows
must link the search entry page and *display* the instrument number.

**Dispatch geocoding:** the street-centroid fallback was removed deliberately. Do not reintroduce
a "close enough" fallback — it manufactured hotspots at wrong addresses.

**Vehicle index:** index **one representative footprint per normalized address**. Assessor
`veh`/`nveh` are parcel-level and replicated to every footprint; indexing every footprint inflates
counts ~1.5× and stacks duplicate pins. The dedup key must use `enrich_pp`'s **exact** `norm_addr`
(UNIT_RE unit-strip) + `norm_city` (CITY_MAP) or apartment footprints split back apart.

**`enrich_pp.veh_list()` had a `[:180]` truncation** that cut the tail mid-token, producing phantom
makes like `+94`. Fixed at source *and* defensively in the parser — keep both.

**Pulse ranking:** current-only places qualify on *reportable categories*, not raw call volume;
and rates are normalised by `call_to_offense` before ranking. Removing either fills the board with
the county jail and a homeless shelter.

**Surveillance:** 70 m dedup radius between an authoritative reader and a volunteer point.
Never sum the spend figures into a headline total.

**Place naming:** 45 m match radius, per-building suffixes stripped. Beyond 45 m the nearest
footprint is a neighbour and the statement pins a shopping centre's offenses on one tenant.

**MapLibre in a hidden/background preview tab never paints** — rAF is suspended so `load` never
fires, screenshots time out, coordinate clicks no-op. Verify by calling app functions directly
(`window.__app` on the ES-module branches; bare globals on `origin/main`) or use a real browser.
**Cesium will have the same problem.** Plan visual verification accordingly.

**Local toolchain gap:** this machine has **Node v22.13.1**; GEV's `package.json` requires
**`>=24.14.0 <25 || >=26 <27`**. Install a supported Node before `npm install`, or the engine
check fails.

**Git on this machine:** `gh` CLI is **not installed**. Pushes work through Git Credential Manager
as `brandongrant`. LF→CRLF warnings are normal.

---

## 10. Verification checklist

**God's Eye View base:**
- [ ] `npm install` on Node 24.14+ or 26.x
- [ ] `npm run dev -- --host localhost --port 4173` → globe loads, photorealistic tiles render
- [ ] `npm run build` · `npm test` · `npm run test:track` (dev server up) — **all three green**,
      this is upstream's stated PR gate
- [ ] no new console errors

**Each added layer:**
- [ ] appears in the Data Layers panel, toggles on/off cleanly
- [ ] `finalizeRegistrations()` does not throw (registry ↔ manager agreement)
- [ ] share link round-trips the layer state (token works)
- [ ] attribution appears in the Cesium credit lightbox
- [ ] `DATA_SOURCES.md` updated

**Cloud Run:**
- [ ] all dev-only proxies answer on the deployed origin (`/api/opensky`, `/api/celestrak`,
      `/api/overpass`, `/api/route`, `/api/gbfs`, `/api/cctv`, `/api/tomtom`, `/api/firms`,
      `/api/terrain/heights`, `/api/adsbdb`, `/api/adsblol/mil`)
- [ ] Maps key restricted to the Cloud Run domain; billing budget + alert active
- [ ] no secret other than `GOOGLE_MAPS_API_KEY` / `CESIUM_ION_TOKEN` reaches the browser bundle

**Data:**
- [ ] `buildings.pmtiles` serves HTTP 206 Partial Content from GCS
- [ ] CORS allows the Cloud Run origin
- [ ] collector job writes, and `stats.json` totals track the GitHub-Actions run for 24 h

**The untouched site:**
- [ ] `https://brandongrant.github.io/pulaski_building_map/` still loads
- [ ] its Map, Pulse, and Watch tabs still populate
- [ ] `origin/main` and `origin/data` have no new commits from this work

---

## 11. Open decisions for the user

1. **"GCS" = Google Cloud project (assumed) or literally a Cloud Storage bucket?** If the latter,
   explain §5.3 — a bucket cannot run this app.
2. **Public or private?** Recommend **IAP-gated**, which resolves both the person-data policy
   question (§7.3) and the Google-key billing-abuse risk in one move.
3. **Do owner search and vehicle search ship?** They conflict with GEV's stated "people are not a
   query type" boundary. Fine on a private instance; not upstreamable.
4. **The 67 MB building tileset — how?** (a) decode PMTiles client-side with the already-present
   `@mapbox/vector-tile` + `pbf` and feed Cesium primitives per viewport, (b) re-tile offline to
   Cesium 3D Tiles, or (c) keep the MapLibre map as a separate view inside the app. This is the
   largest single piece of work in the whole project — get a decision before starting.
5. **Do the GitHub collectors keep running after GCP parity?** Recommend yes for a while: they are
   the only guard against losing the LRPD daily-report archive, which cannot be backfilled.
6. ~~New repo or a branch of the GEV fork?~~ **DECIDED 2026-08-25 — branch `v2` of
   `brandongrant/gods-eye-view`, where you are now.** Keep Pulaski-specific code in clearly
   separated modules so merges from upstream `bilawalsidhu/gods-eye-view` stay possible.
7. **The 311 collector** (`pipeline/sr311_collect.py`, unmerged on `claude/lr311-overlay`) — cherry-pick
   it into the new collector job? Data already exists on `origin/data` but stops at 2026-07.

---

## 12. Quick-reference commands

```bash
# canonical Pulaski checkout (matches origin/main)
cd "D:/Claude Code Projects/Building_Map/.claude/worktrees/surveillance-devices-map-929673"

# read anything from the live data branch without a stale checkout
git show origin/data:dispatch/out/stats.json
git ls-tree -r -l origin/data

# serve the Pulaski map locally (needs Range support; stock http.server won't do)
python serve.py            # http://localhost:8080

# rebuild everything (~20-40 min, ~2 GB temp)
pip install -r requirements.txt && python pipeline/run_all.py
pip install -r requirements-dev.txt && python -m pytest tests/

# local Pulse iteration against a data-branch checkout
python pipeline/build_pulse.py --store <data-checkout> --out web/data/pulse/pulse.json
# then http://localhost:8080/?pulse=local

# God's Eye View
git clone https://github.com/brandongrant/gods-eye-view.git
cd gods-eye-view && cp .env.example .env    # set GOOGLE_MAPS_API_KEY
npm install && npm run dev -- --host localhost --port 4173
npm run build && npm test && npm run test:track
```

Live URLs already in play:
- Site (**do not disturb**): `https://brandongrant.github.io/pulaski_building_map/`
- Data branch raw: `https://raw.githubusercontent.com/brandongrant/pulaski_building_map/data/<path>`
- Deed Worker: `https://pulaski-deeds.brandongrant.workers.dev` (`/health`, `/deeds?sub=&lot=&blc=`)

---

## 13. Source documents worth reading before executing

| Doc | Size | Why |
|---|---|---|
| `docs/IMPLEMENTATION_ROADMAP.md` (pulaski) | 2,740 lines | product + architecture bible; §16 privacy rules are binding |
| `jurisdictions/ar/pulaski.yml` (pulaski) | ~220 lines | per-source sensitivity + display policy; the contract the collectors honour |
| `docs/SESSION_HANDOFF.md` (pulaski) | 740 lines | prior-session state; its "Hard-won facts" overlaps §9 above |
| `docs/recorded_documents_plan.md` (pulaski) | 248 lines | deeds recon + phase plan |
| `README.md` (pulaski, `origin/main`) | 22 KB | the most complete plain-language description of every capability |
| `docs/CURRENT-STATE.md` (GEV) | 2,584 lines | authoritative runtime reference; its "Proxy/Security Baseline" is essential for §5.3 |
| `DATA_SOURCES.md` (GEV) | 21 KB | license/attribution index you must extend |
| `SECURITY.md` (GEV) | 6.7 KB | threat model for a shared instance |
| `docs/KNOWN-ISSUES.md` (GEV) | 108 lines | |
