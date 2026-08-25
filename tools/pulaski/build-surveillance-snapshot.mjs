/**
 * Rebuild the bundled Pulaski surveillance snapshot from the upstream publication.
 *
 * Upstream (`brandongrant/pulaski_building_map`) is treated as read-only: this
 * only ever reads its published GeoJSON over HTTPS.
 *
 * Two transforms are applied, and only two:
 *   1. `properties.lbl` is copied to `properties.name`, and `properties.op` to
 *      `properties.operator`. `featureLabelFromProperties` in
 *      `src/data/localGeojson.js` reads `name`/`operator` and knows nothing about
 *      this dataset's abbreviated keys; copying is cheaper and far less brittle
 *      than teaching the shared label resolver a per-dataset vocabulary.
 *   2. FeatureCollection -> JSON Lines, which is what `createLocalGeoJsonLayer`
 *      parses.
 *
 * Every original key is preserved untouched alongside the copies.
 *
 * Usage: node tools/pulaski/build-surveillance-snapshot.mjs
 *
 * @module tools/pulaski/build-surveillance-snapshot
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'src', 'data', 'local_data', 'pulaski_surveillance');
const BASE = 'https://brandongrant.github.io/pulaski_building_map/data/surveillance';

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const [devices, meta] = await Promise.all([
    getJson(`${BASE}/devices.geojson`),
    getJson(`${BASE}/meta.json`).catch(() => null),
  ]);

  if (devices?.type !== 'FeatureCollection' || !Array.isArray(devices.features)) {
    throw new Error('upstream devices.geojson is not a FeatureCollection');
  }

  const families = {};
  const programs = {};
  const lines = [];
  for (const feature of devices.features) {
    const properties = { ...(feature.properties || {}) };
    if (properties.lbl && !properties.name) properties.name = properties.lbl;
    if (properties.op && !properties.operator) properties.operator = properties.op;
    families[properties.fam] = (families[properties.fam] || 0) + 1;
    programs[properties.prog] = (programs[properties.prog] || 0) + 1;
    lines.push(JSON.stringify({
      id: properties.id ?? feature.id ?? null,
      type: 'Feature',
      geometry: feature.geometry,
      properties,
    }));
  }

  const body = `${lines.join('\n')}\n`;
  await fs.mkdir(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'pulaski_surveillance.geojsonl');
  await fs.writeFile(outFile, body, 'utf8');

  const source = {
    id: 'local-pulaski-surveillance',
    name: 'Pulaski Surveillance',
    category: 'surveillance',
    description:
      'Publicly documented surveillance devices in Pulaski County, Arkansas: ARDOT traffic '
      + 'cameras, automated licence-plate readers, gunshot sensors, and road-visible field '
      + 'sightings.',
    downloaded_at: new Date().toISOString().slice(0, 10),
    license_note:
      'Derived from public agency publications, an LRPD FOIA response (PDFOIA-2025-4004), and '
      + 'OpenStreetMap (ODbL 1.0). Keep the OpenStreetMap contributor attribution when '
      + 'redistributing.',
    upstream: `${BASE}/devices.geojson`,
    counts: { features: devices.features.length, families, programs },
    files: [{
      path: 'pulaski_surveillance.geojsonl',
      url: `${BASE}/devices.geojson`,
      format: 'geojsonl',
      geojson_type: 'Point',
      feature_count: devices.features.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    }],
    upstream_meta: meta || null,
  };
  await fs.writeFile(path.join(OUT_DIR, 'source.json'), `${JSON.stringify(source, null, 2)}\n`, 'utf8');

  console.log(`wrote ${devices.features.length} features -> ${path.relative(ROOT, outFile)}`);
  console.log('families:', families);
  console.log('programs:', programs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
