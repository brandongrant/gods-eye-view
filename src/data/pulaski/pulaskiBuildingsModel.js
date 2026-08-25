/**
 * Pure geometry/tile/styling maths behind the Pulaski buildings layer.
 *
 * Split out from the Cesium layer so the slice-selection and the height
 * derivation can be tested directly — both are easy to get subtly wrong and
 * expensive to eyeball on a globe.
 *
 * @module data/pulaski/pulaskiBuildingsModel
 */

/** Archive extent, from the PMTiles header. Nothing outside this exists. */
export const PULASKI_BOUNDS = Object.freeze({
  west: -92.8779, south: 34.4808, east: -92.0242, north: 35.0267,
});

/** The tileset's own zoom range. */
export const PULASKI_MIN_ZOOM = 8;
export const PULASKI_MAX_ZOOM = 15;

/** Typical storey height in metres, for extrusion from assessor storey counts. */
export const STOREY_HEIGHT_M = 3.2;

/**
 * @param {number} lon
 * @param {number} z
 * @returns {number} Tile column.
 */
export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

/**
 * @param {number} lat
 * @param {number} z
 * @returns {number} Tile row (Web Mercator).
 */
export function latToTileY(lat, z) {
  // Clamp to the Mercator limit: tan() diverges at the poles and would produce
  // a NaN row that silently drops every tile in the request.
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const r = (clamped * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/**
 * Pick a tile zoom for a camera height.
 *
 * Deliberately coarse: each step down quadruples the tiles in view, and this
 * archive carries 23k features in a single z12 tile, so over-zooming out is how
 * you freeze the main thread.
 *
 * @param {number} cameraHeightM
 * @returns {number}
 */
export function zoomForCameraHeight(cameraHeightM) {
  if (!Number.isFinite(cameraHeightM)) return PULASKI_MAX_ZOOM;
  if (cameraHeightM < 1500) return 15;
  if (cameraHeightM < 4000) return 14;
  if (cameraHeightM < 9000) return 13;
  return 12;
}

/**
 * List the tiles covering a lon/lat rectangle, clipped to the archive extent.
 *
 * Returns `[]` when the view does not intersect Pulaski County at all, which is
 * the normal case — this layer is one county on a whole planet.
 *
 * @param {{west:number,south:number,east:number,north:number}} rect Degrees.
 * @param {number} z
 * @param {number} [maxTiles] Hard ceiling; the nearest tiles to the centre win.
 * @returns {{z:number,x:number,y:number}[]}
 */
export function tilesForRectangle(rect, z, maxTiles = 24) {
  const west = Math.max(rect.west, PULASKI_BOUNDS.west);
  const east = Math.min(rect.east, PULASKI_BOUNDS.east);
  const south = Math.max(rect.south, PULASKI_BOUNDS.south);
  const north = Math.min(rect.north, PULASKI_BOUNDS.north);
  if (!(west < east && south < north)) return [];

  const minX = lonToTileX(west, z);
  const maxX = lonToTileX(east, z);
  // Tile rows run north→south, so the northern edge yields the SMALLER index.
  const minY = latToTileY(north, z);
  const maxY = latToTileY(south, z);

  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;

  const tiles = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) tiles.push({ z, x, y });
  }
  if (tiles.length <= maxTiles) return tiles;

  return tiles
    .map((tile) => ({
      tile,
      d: (tile.x - centreX) ** 2 + (tile.y - centreY) ** 2,
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, maxTiles)
    .map((entry) => entry.tile);
}

/**
 * Derive a storey count for extrusion.
 *
 * The assessor's storey count (`st`) is missing on most footprints — only 51 of
 * 164 carried it in a sampled z15 tile — so where heated floor area and
 * footprint area both exist, their ratio is the honest fallback. Anything else
 * is a single storey; guessing taller would invent a skyline.
 *
 * @param {object} props MVT feature properties.
 * @returns {number}
 */
export function storeysForFeature(props) {
  const stated = Number(props?.st);
  if (Number.isFinite(stated) && stated >= 1) return Math.min(stated, 60);

  const sqft = Number(props?.sqft);
  const footprint = Number(props?.fpa);
  if (Number.isFinite(sqft) && Number.isFinite(footprint) && footprint > 0 && sqft > 0) {
    return Math.max(1, Math.min(60, Math.round(sqft / footprint)));
  }
  return 1;
}

/**
 * @param {object} props
 * @param {number} [exaggeration]
 * @returns {number} Extrusion height in metres.
 */
export function heightForFeature(props, exaggeration = 1) {
  return storeysForFeature(props) * STOREY_HEIGHT_M * exaggeration;
}

/**
 * Year-built ramp, oldest (warm) to newest (cool).
 *
 * Stops rather than a continuous interpolation: the eye reads a handful of eras
 * far better than a smooth gradient, and this mirrors how the upstream site
 * colours its Colouring-London palette.
 */
export const YEAR_COLOR_STOPS = Object.freeze([
  { until: 1900, color: '#5b1e2f' },
  { until: 1930, color: '#8c2f39' },
  { until: 1950, color: '#c04f3a' },
  { until: 1970, color: '#e08a3c' },
  { until: 1990, color: '#d9c14a' },
  { until: 2005, color: '#7fb45e' },
  { until: 2015, color: '#3f9e8c' },
  { until: Infinity, color: '#3f7fb4' },
]);

/** Colour used when the assessor has no year on record. */
export const UNDATED_COLOR = '#4a4a52';

/**
 * @param {number|undefined} year
 * @returns {string} CSS colour.
 */
export function colorForYear(year) {
  const value = Number(year);
  if (!Number.isFinite(value) || value <= 0) return UNDATED_COLOR;
  return YEAR_COLOR_STOPS.find((stop) => value <= stop.until).color;
}

/**
 * Flatten an MVT feature's GeoJSON geometry into outer rings.
 *
 * Only outer rings are kept: Cesium wants explicit hole hierarchies, holes are
 * vanishingly rare in assessor footprints, and a hole ring mistaken for an
 * outer ring draws a solid block over the courtyard it was meant to cut out.
 *
 * @param {object} geometry GeoJSON geometry from `feature.toGeoJSON`.
 * @returns {number[][][]} Array of rings, each an array of [lon, lat].
 */
export function outerRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    return Array.isArray(geometry.coordinates?.[0]) ? [geometry.coordinates[0]] : [];
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates || [])
      .map((polygon) => polygon?.[0])
      .filter((ring) => Array.isArray(ring) && ring.length >= 4);
  }
  return [];
}

/**
 * Flatten a ring to the [lon, lat, lon, lat, …] Cesium wants.
 *
 * Drops the closing vertex — `Cesium.PolygonHierarchy` closes rings itself, and
 * a duplicated first/last point makes the triangulator emit a degenerate edge.
 *
 * @param {number[][]} ring
 * @returns {number[]|null} null when the ring cannot form a triangle.
 */
export function ringToFlatDegrees(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed = first && last && first[0] === last[0] && first[1] === last[1];
  const end = closed ? ring.length - 1 : ring.length;
  if (end < 3) return null;

  const flat = new Array(end * 2);
  for (let i = 0; i < end; i += 1) {
    const point = ring[i];
    // parseFloat, NOT Number(): `Number(null)` and `Number('')` are 0, so a null
    // ordinate would become a real coordinate on the equator and drag one corner
    // of the footprint off the map.
    const lon = typeof point?.[0] === 'number' ? point[0] : Number.parseFloat(point?.[0]);
    const lat = typeof point?.[1] === 'number' ? point[1] : Number.parseFloat(point?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    flat[i * 2] = lon;
    flat[i * 2 + 1] = lat;
  }
  return flat;
}
