// The Pulaski surveillance snapshot is a bundled layer, so its five registration
// points must agree or `finalizeRegistrations()` throws at boot. These pin the
// bundle itself, the share-link token, and the two upstream honesty conventions
// that a naive re-export would quietly drop: a surviving `sighting` is a device
// that matched nothing published, and it must never be shown without the
// observer's confidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LAYER_STATE_REGISTRY,
  decodeLayerStateParams,
  encodeLayerStateParams,
  normalizeLayerState,
  validateLayerStateRegistry,
} from './layerState.js';
import { localInfrastructureOverlayCopy } from './localGeojson.js';

const LAYER_ID = 'local-pulaski-surveillance';
const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const snapshot = () => read('./local_data/pulaski_surveillance/pulaski_surveillance.geojsonl')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

test('the bundle is JSON Lines of Points — the loader splits on newlines, not JSON.parse', () => {
  const features = snapshot();
  assert.equal(features.length, 525);
  for (const feature of features) {
    assert.equal(feature.type, 'Feature');
    assert.equal(feature.geometry.type, 'Point');
    const [lon, lat] = feature.geometry.coordinates;
    // Pulaski County, Arkansas — a swapped lat/lon would silently land in Asia.
    assert.ok(lon > -93.5 && lon < -91.5, `lon ${lon} outside Pulaski County`);
    assert.ok(lat > 34.2 && lat < 35.3, `lat ${lat} outside Pulaski County`);
  }
});

test('every feature carries `name`, because the shared label resolver reads that and not `lbl`', () => {
  for (const feature of snapshot()) {
    assert.ok(feature.properties.name, `feature ${feature.properties.id} has no name`);
    assert.equal(feature.properties.name, feature.properties.lbl);
  }
});

test('the registry entry exists, is uniquely tokenized, and keeps the array sorted', () => {
  assert.equal(validateLayerStateRegistry(), true);
  const entry = LAYER_STATE_REGISTRY.find((candidate) => candidate.id === LAYER_ID);
  assert.ok(entry, `${LAYER_ID} is missing from LAYER_STATE_REGISTRY`);
  assert.equal(entry.disposition, 'enabled-only');
  assert.match(entry.token, /^[a-z0-9]$/);
  const tokens = LAYER_STATE_REGISTRY.map((candidate) => candidate.token);
  assert.equal(new Set(tokens).size, tokens.length, 'share tokens must be unique');
});

test('a share link round-trips the layer — the token is the serialization character', () => {
  const state = normalizeLayerState({ enabledLayerIds: [LAYER_ID] });
  assert.deepEqual(state.enabledLayerIds, [LAYER_ID], 'the id must survive normalization');
  const params = new URLSearchParams([['v', '2']]);
  encodeLayerStateParams(params, state);
  const decoded = decodeLayerStateParams(params);
  // decode fails closed on an unknown token, so a null here means the registry
  // and the codec disagree about this layer.
  assert.ok(decoded, 'a link carrying this layer must not fail closed');
  assert.deepEqual(decoded.enabledLayerIds, [LAYER_ID]);
});

test('the layer is wired into localLayers.js with the id the registry expects', () => {
  const source = read('./localLayers.js');
  assert.match(source, /local_data\/pulaski_surveillance\/pulaski_surveillance\.geojsonl\?url/);
  assert.match(source, new RegExp(`id: '${LAYER_ID}'`));
  // The default export is what main.js registers; a layer defined but never
  // pushed into it is exactly the mismatch finalizeRegistrations() throws on.
  const exported = source.slice(source.indexOf('export default'));
  assert.match(exported, /pulaskiSurveillance,/);
});

test('attribution is registered — the OSM-derived subset carries a share-alike obligation', () => {
  const credits = read('./dataCredits.js');
  assert.match(credits, /key: 'pulaski-surveillance'/);
  assert.match(credits, /openstreetmap\.org\/copyright/);
  const sources = read('../../DATA_SOURCES.md');
  assert.match(sources, /pulaski_surveillance\//);
  assert.match(sources, /PDFOIA-2025-4004/);
});

test('the ambient card names the device family and its operator', () => {
  const { title, details } = localInfrastructureOverlayCopy({
    name: '5944 Rebsamen Park Rd',
    fam: 'alpr',
    prog: 'flock-lrpd',
    operator: 'Little Rock Police Department',
    public: 1,
  }, LAYER_ID);
  assert.equal(title, '5944 Rebsamen Park Rd');
  assert.deepEqual(details, ['Plate reader · Little Rock Police Department']);
});

test('a sighting is never shown without its confidence', () => {
  const { details } = localInfrastructureOverlayCopy({
    name: 'Twin heads on an I-430 ramp, North Little Rock',
    fam: 'sighting',
    conf: 'probable',
    public: 0,
  }, LAYER_ID);
  assert.equal(details.length, 1);
  assert.match(details[0], /^Field sighting/);
  assert.match(details[0], /probable/);
});

test('a published device does NOT borrow a sighting-style confidence it never claimed', () => {
  const { details } = localInfrastructureOverlayCopy({
    name: 'State Hwy. 440 at Mile Marker 12',
    fam: 'traffic',
    // Upstream leaves stray keys on published rows; only `sighting` reads conf.
    conf: 'confirmed',
    public: 1,
  }, LAYER_ID);
  assert.deepEqual(details, ['Traffic camera']);
});

test('an unknown device family degrades to the bare label instead of inventing one', () => {
  const { title, details } = localInfrastructureOverlayCopy(
    { name: 'Unlabelled pole', fam: 'quantum-radar' },
    LAYER_ID,
  );
  assert.equal(title, 'Unlabelled pole');
  assert.deepEqual(details, []);
});

test('the snapshot carries no person-level field — it is device infrastructure only', () => {
  const banned = new Set(['owner', 'plate', 'person', 'name_first', 'name_last', 'driver', 'vehicle']);
  for (const feature of snapshot()) {
    for (const key of Object.keys(feature.properties)) {
      assert.ok(!banned.has(key.toLowerCase()), `unexpected person-level key: ${key}`);
    }
  }
});
