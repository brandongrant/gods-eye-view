# Pulaski Surveillance

Publicly documented surveillance devices in Pulaski County, Arkansas.

Rebuild with `node tools/pulaski/build-surveillance-snapshot.mjs`, which reads the
published GeoJSON from `brandongrant/pulaski_building_map` over HTTPS. That repo is
upstream and read-only; nothing here writes to it.

Sources, and what each contributes:

- **ARDOT published camera layer** — state traffic cameras, with model and live
  `.m3u8` stream URL.
- **LRPD reader list (FOIA `PDFOIA-2025-4004`)** — automated licence-plate readers,
  geocoded.
- **OpenStreetMap `man_made=surveillance`** (DeFlock tagging) — readers and gunshot
  sensors that were never published by an agency.
- **Field sightings** — devices photographed from the road, scored against the
  published list. Each carries an explicit confidence (`confirmed` / `likely` /
  `probable` / `uncertain`), the reasoning, and what evidence would settle it.
  Several are deliberately filed as *not identified* rather than guessed.

Feature count: 525

By family: alpr 313 · traffic 191 · gunshot 11 · sighting 9 · camera 1

By program: ardot-cctv 194 · flock-unattributed 136 · flock-lrpd 132 · other-alpr 34 ·
shotspotter 11 · flock-other 9 · unidentified 3 · lvt-tower 2 · ardot-wwd 1 ·
ardot-managed-lane 1 · other-camera 1 · small-cell 1

Runtime output: `pulaski_surveillance.geojsonl`

Upstream dedup rule, preserved here because it changes what a pin means: an
authoritative reader and a volunteer sighting within **70 m** are treated as the same
pole. The authoritative record keeps the pin and inherits the volunteer's recorded
direction — so a `sighting` feature is one that did *not* match anything published.

License: device records are drawn from public agency publications and a FOIA
response. The OpenStreetMap-derived subset is Open Database License (ODbL) 1.0 —
keep the OpenStreetMap contributor attribution when redistributing this derived
database.

This is device-level infrastructure data only. It records where publicly documented
equipment stands; it carries nothing about people, vehicles, or anything any device
observed.
