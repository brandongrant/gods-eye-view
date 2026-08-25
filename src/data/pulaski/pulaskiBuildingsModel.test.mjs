// Tile selection and height derivation for the buildings layer. Both are cheap
// to get subtly wrong and expensive to spot on a globe: an inverted tile row
// loads the wrong half of the county, and a bad storey fallback invents a
// skyline that looks plausible and is not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PULASKI_BOUNDS,
  STOREY_HEIGHT_M,
  UNDATED_COLOR,
  colorForYear,
  heightForFeature,
  latToTileY,
  lonToTileX,
  outerRings,
  ringToFlatDegrees,
  storeysForFeature,
  tilesForRectangle,
  zoomForCameraHeight,
} from './pulaskiBuildingsModel.js';

const DOWNTOWN = { lon: -92.2896, lat: 34.7465 };

test('tile coordinates match the values the real archive was probed with', () => {
  // These are the exact tiles verified against buildings.pmtiles.
  assert.equal(lonToTileX(DOWNTOWN.lon, 15), 7983);
  assert.equal(latToTileY(DOWNTOWN.lat, 15), 13007);
  assert.equal(lonToTileX(DOWNTOWN.lon, 14), 3991);
  assert.equal(latToTileY(DOWNTOWN.lat, 14), 6503);
  assert.equal(lonToTileX(DOWNTOWN.lon, 12), 997);
  assert.equal(latToTileY(DOWNTOWN.lat, 12), 1625);
});

test('tile rows run north to south — north yields the SMALLER index', () => {
  assert.ok(latToTileY(35.0, 14) < latToTileY(34.5, 14));
});

test('a latitude past the Mercator limit clamps instead of producing NaN', () => {
  assert.ok(Number.isFinite(latToTileY(89.9, 10)));
  assert.ok(Number.isFinite(latToTileY(-89.9, 10)));
});

test('zoom steps down with altitude, because a z12 tile here holds 23k features', () => {
  assert.equal(zoomForCameraHeight(800), 15);
  assert.equal(zoomForCameraHeight(3000), 14);
  assert.equal(zoomForCameraHeight(8000), 13);
  assert.equal(zoomForCameraHeight(50000), 12);
  assert.equal(zoomForCameraHeight(NaN), 15);
});

test('a view outside Pulaski County selects nothing at all', () => {
  // The layer is one county on a whole planet; Austin must cost zero requests.
  assert.deepEqual(
    tilesForRectangle({ west: -98, south: 30, east: -97, north: 31 }, 14),
    [],
  );
});

test('a view over downtown selects the tile containing it', () => {
  const tiles = tilesForRectangle(
    { west: -92.30, south: 34.74, east: -92.28, north: 34.75 }, 15,
  );
  assert.ok(tiles.length > 0);
  assert.ok(tiles.some((t) => t.x === 7983 && t.y === 13007));
  assert.ok(tiles.every((t) => t.z === 15));
});

test('selection is clipped to the archive extent, so no request is wasted off-dataset', () => {
  const tiles = tilesForRectangle(
    { west: -100, south: 20, east: -80, north: 45 }, 12, 4096,
  );
  const minX = lonToTileX(PULASKI_BOUNDS.west, 12);
  const maxX = lonToTileX(PULASKI_BOUNDS.east, 12);
  assert.ok(tiles.length > 0);
  for (const tile of tiles) {
    assert.ok(tile.x >= minX && tile.x <= maxX, `x ${tile.x} outside the archive`);
  }
});

test('the tile ceiling holds, and the tiles kept are the ones nearest the centre', () => {
  const rect = { west: -92.8, south: 34.5, east: -92.1, north: 35.0 };
  const uncapped = tilesForRectangle(rect, 15, 100000);
  assert.ok(uncapped.length > 16, 'this rectangle must overflow the cap to be a real test');

  const capped = tilesForRectangle(rect, 15, 16);
  assert.equal(capped.length, 16);

  const centreX = (Math.min(...uncapped.map((t) => t.x)) + Math.max(...uncapped.map((t) => t.x))) / 2;
  const centreY = (Math.min(...uncapped.map((t) => t.y)) + Math.max(...uncapped.map((t) => t.y))) / 2;
  const worstKept = Math.max(...capped.map((t) => (t.x - centreX) ** 2 + (t.y - centreY) ** 2));
  const droppedKeys = new Set(capped.map((t) => `${t.x}/${t.y}`));
  const bestDropped = Math.min(
    ...uncapped.filter((t) => !droppedKeys.has(`${t.x}/${t.y}`))
      .map((t) => (t.x - centreX) ** 2 + (t.y - centreY) ** 2),
  );
  assert.ok(worstKept <= bestDropped, 'a dropped tile was closer than a kept one');
});

test('a stated storey count wins', () => {
  assert.equal(storeysForFeature({ st: 3 }), 3);
  assert.equal(storeysForFeature({ st: 3, sqft: 9000, fpa: 1000 }), 3);
});

test('missing storeys fall back to floor-area over footprint, which is the honest ratio', () => {
  // Most footprints have no `st` — only 51 of 164 in a sampled z15 tile.
  assert.equal(storeysForFeature({ sqft: 3060, fpa: 1020 }), 3);
  assert.equal(storeysForFeature({ sqft: 1022, fpa: 1290 }), 1, 'never below one storey');
});

test('with nothing to go on it is a single storey — a taller guess invents a skyline', () => {
  assert.equal(storeysForFeature({}), 1);
  assert.equal(storeysForFeature({ st: 0 }), 1);
  assert.equal(storeysForFeature({ sqft: 5000, fpa: 0 }), 1);
  assert.equal(storeysForFeature({ st: 'tall' }), 1);
});

test('an absurd storey count is capped rather than trusted', () => {
  assert.equal(storeysForFeature({ st: 5000 }), 60);
  assert.equal(storeysForFeature({ sqft: 1e9, fpa: 1 }), 60);
});

test('height is storeys times storey height, and exaggeration scales it', () => {
  assert.equal(heightForFeature({ st: 2 }), 2 * STOREY_HEIGHT_M);
  assert.equal(heightForFeature({ st: 2 }, 3), 2 * STOREY_HEIGHT_M * 3);
});

test('year colours step by era, and an unknown year is visibly not a date', () => {
  assert.equal(colorForYear(1890), colorForYear(1899));
  assert.notEqual(colorForYear(1890), colorForYear(1935));
  assert.notEqual(colorForYear(1960), colorForYear(2020));
  for (const missing of [undefined, null, 0, '', 'n/a', NaN]) {
    assert.equal(colorForYear(missing), UNDATED_COLOR);
  }
});

test('only outer rings are taken — a hole read as an outline fills the courtyard', () => {
  const withHole = {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
      [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [0.2, 0.2]],
    ],
  };
  assert.equal(outerRings(withHole).length, 1);
  assert.deepEqual(outerRings(withHole)[0][0], [0, 0]);

  const multi = {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      [[[5, 5], [6, 5], [6, 6], [5, 5]]],
    ],
  };
  assert.equal(outerRings(multi).length, 2);

  assert.deepEqual(outerRings(null), []);
  assert.deepEqual(outerRings({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }), []);
});

test('the closing vertex is dropped — Cesium closes rings and a dupe degenerates the mesh', () => {
  const closed = ringToFlatDegrees([[0, 0], [1, 0], [1, 1], [0, 0]]);
  assert.deepEqual(closed, [0, 0, 1, 0, 1, 1]);

  const open = ringToFlatDegrees([[0, 0], [1, 0], [1, 1], [0, 1]]);
  assert.deepEqual(open, [0, 0, 1, 0, 1, 1, 0, 1]);
});

test('a ring that cannot form a triangle, or carries a bad ordinate, is refused', () => {
  assert.equal(ringToFlatDegrees([[0, 0], [1, 1]]), null);
  assert.equal(ringToFlatDegrees([[0, 0], [1, 0], [0, 0]]), null);
  assert.equal(ringToFlatDegrees([[0, 0], [1, 0], [null, 1], [0, 0]]), null);
  assert.equal(ringToFlatDegrees(null), null);
});
