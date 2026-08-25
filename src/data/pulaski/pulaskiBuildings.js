/**
 * Pulaski County building footprints, decoded from PMTiles into Cesium geometry.
 *
 * The upstream tileset is MapLibre vector tiles (`buildings.pmtiles`, 67 MB,
 * 225,774 footprints, z8–z15). Cesium cannot consume those, and re-tiling 67 MB
 * to 3D Tiles offline would fork the dataset. So this reads single tiles over
 * HTTP Range with `pmtiles.js`, decodes the MVT with the `@mapbox/vector-tile` +
 * `pbf` pair the app already depends on, and extrudes each footprint by its
 * assessor storey count.
 *
 * Loading is viewport-driven, not a bulk import: a z12 tile of this archive
 * holds 23,341 features, so the layer stays idle until the camera is both over
 * Pulaski County and low enough for a sane tile zoom. That gate is the whole
 * performance story — without it, flying over Arkansas at altitude would try to
 * triangulate a quarter of a million polygons.
 *
 * @module data/pulaski/pulaskiBuildings
 */

import * as Cesium from 'cesium';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { governorRequestRender } from '../../renderGovernor.js';
import { openPmtiles } from './pmtiles.js';
import { pulaskiStaticBase } from './pulaskiSources.js';
import {
  PULASKI_BOUNDS,
  colorForYear,
  heightForFeature,
  outerRings,
  ringToFlatDegrees,
  tilesForRectangle,
  zoomForCameraHeight,
} from './pulaskiBuildingsModel.js';

export const PULASKI_BUILDINGS_LAYER_ID = 'pulaski-buildings';

/** Above this the layer sleeps: the county is a speck and the tiles are huge. */
const MAX_CAMERA_HEIGHT_M = 20000;
/** Ceiling on tiles held at once; each is its own batched Primitive. */
const MAX_ACTIVE_TILES = 16;
/** Decoded-tile cache, keyed z/x/y. Tiles are immutable, so this never staless. */
const MAX_CACHED_TILES = 48;
/** Camera settle delay — flying produces a continuous stream of change events. */
const CAMERA_DEBOUNCE_MS = 220;

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] Test seam.
 * @returns {object} A DataLayerManager-compatible layer module.
 */
export function createPulaskiBuildingsLayer({ fetchImpl = (...args) => fetch(...args) } = {}) {
  let _viewer = null;
  let _enabled = false;
  let _source = null;
  let _sourcePromise = null;
  let _error = null;
  let _loading = false;
  let _featureCount = 0;
  let _lastUpdate = null;
  let _exaggeration = 1;
  let _cameraListener = null;
  let _debounce = null;
  /** Bumped on disable/destroy so in-flight tile work cannot draw into a dead scene. */
  let _generation = 0;

  /** @type {Map<string, {primitive: any}>} */
  const _active = new Map();
  /** @type {Map<string, {features: any[]}>} */
  const _cache = new Map();

  const archiveUrl = () => `${pulaskiStaticBase()}/buildings.pmtiles`;

  async function source() {
    if (_source) return _source;
    if (!_sourcePromise) {
      _sourcePromise = openPmtiles({ url: archiveUrl(), fetchImpl })
        .then((opened) => { _source = opened; return opened; })
        .catch((error) => { _sourcePromise = null; throw error; });
    }
    return _sourcePromise;
  }

  function cacheTile(key, value) {
    _cache.set(key, value);
    while (_cache.size > MAX_CACHED_TILES) {
      _cache.delete(_cache.keys().next().value);
    }
  }

  /** Decode one tile into plain {rings, color, height} records. */
  async function loadTileFeatures(z, x, y) {
    const key = `${z}/${x}/${y}`;
    const cached = _cache.get(key);
    if (cached) return cached.features;

    const opened = await source();
    const bytes = await opened.getTile(z, x, y);
    if (!bytes || bytes.length === 0) {
      cacheTile(key, { features: [] });
      return [];
    }

    const layer = new VectorTile(new PbfReader(bytes)).layers?.buildings;
    const features = [];
    if (layer) {
      for (let i = 0; i < layer.length; i += 1) {
        const feature = layer.feature(i);
        const props = feature.properties || {};
        const rings = outerRings(feature.toGeoJSON(x, y, z).geometry);
        for (const ring of rings) {
          const flat = ringToFlatDegrees(ring);
          if (!flat) continue;
          features.push({ flat, props });
        }
      }
    }
    cacheTile(key, { features });
    return features;
  }

  /** Build one batched Primitive for a tile's footprints. */
  function buildPrimitive(features) {
    const instances = [];
    for (const feature of features) {
      const height = heightForFeature(feature.props, _exaggeration);
      let geometry;
      try {
        geometry = new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(feature.flat),
          ),
          extrudedHeight: height,
          height: 0,
          perPositionHeight: false,
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        });
      } catch {
        // A self-intersecting assessor footprint kills only itself.
        continue;
      }
      instances.push(new Cesium.GeometryInstance({
        geometry,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString(colorForYear(feature.props.yr)).withAlpha(0.92),
          ),
        },
      }));
    }
    if (!instances.length) return null;
    return new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
      asynchronous: true,
      releaseGeometryInstances: true,
    });
  }

  function dropTile(key) {
    const entry = _active.get(key);
    if (!entry) return;
    _active.delete(key);
    if (_viewer?.scene?.primitives && entry.primitive) {
      _viewer.scene.primitives.remove(entry.primitive);
    }
  }

  function clearAll() {
    for (const key of [..._active.keys()]) dropTile(key);
    _featureCount = 0;
  }

  /** Which tiles the current camera wants, or [] when the layer should sleep. */
  function desiredTiles() {
    if (!_viewer) return [];
    const scene = _viewer.scene;
    const rectangle = scene.camera.computeViewRectangle(scene.globe?.ellipsoid);
    if (!rectangle) return [];
    const height = scene.camera.positionCartographic?.height ?? Infinity;
    if (height > MAX_CAMERA_HEIGHT_M) return [];

    const degrees = {
      west: Cesium.Math.toDegrees(rectangle.west),
      south: Cesium.Math.toDegrees(rectangle.south),
      east: Cesium.Math.toDegrees(rectangle.east),
      north: Cesium.Math.toDegrees(rectangle.north),
    };
    return tilesForRectangle(degrees, zoomForCameraHeight(height), MAX_ACTIVE_TILES);
  }

  async function syncToCamera() {
    if (!_enabled || !_viewer) return;
    const generation = _generation;
    const wanted = desiredTiles();
    const wantedKeys = new Set(wanted.map((t) => `${t.z}/${t.x}/${t.y}`));

    for (const key of [..._active.keys()]) {
      if (!wantedKeys.has(key)) dropTile(key);
    }
    if (!wanted.length) {
      _featureCount = 0;
      _error = null;
      governorRequestRender(`layer-sync:${PULASKI_BUILDINGS_LAYER_ID}`);
      return;
    }

    _loading = true;
    try {
      for (const tile of wanted) {
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        if (_active.has(key)) continue;
        const features = await loadTileFeatures(tile.z, tile.x, tile.y);
        // The camera may have moved on, or the layer been switched off, while
        // this tile was in flight.
        if (generation !== _generation || !_enabled) return;
        if (!desiredTiles().some((t) => `${t.z}/${t.x}/${t.y}` === key)) continue;
        if (_active.has(key)) continue;

        const primitive = buildPrimitive(features);
        if (!primitive) { _active.set(key, { primitive: null }); continue; }
        _viewer.scene.primitives.add(primitive);
        _active.set(key, { primitive });
      }
      _error = null;
      _lastUpdate = Date.now();
    } catch (error) {
      if (generation === _generation) {
        _error = `buildings unavailable (${error?.message || error})`;
      }
    } finally {
      if (generation === _generation) {
        _loading = false;
        _featureCount = [..._active.keys()]
          .reduce((total, key) => total + (_cache.get(key)?.features.length || 0), 0);
        governorRequestRender(`layer-sync:${PULASKI_BUILDINGS_LAYER_ID}`);
      }
    }
  }

  function onCameraChanged() {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => { void syncToCamera(); }, CAMERA_DEBOUNCE_MS);
  }

  return {
    id: PULASKI_BUILDINGS_LAYER_ID,
    name: 'Pulaski Buildings',
    icon: '▤',
    source: 'PAgis / Pulaski assessor',
    // Camera-driven, like the other viewport layers: no data poll, just a
    // stats/panel repaint timer.
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init(viewer) {
      _viewer = viewer;
      _error = null;
      _featureCount = 0;
    },

    enable(viewer) {
      _enabled = true;
      _viewer = viewer;
      _error = null;
      if (!_cameraListener) {
        _cameraListener = onCameraChanged;
        viewer.camera.changed.addEventListener(_cameraListener);
        viewer.camera.percentageChanged = Math.min(viewer.camera.percentageChanged || 1, 0.05);
      }
      void syncToCamera();
    },

    disable() {
      _enabled = false;
      _generation += 1;
      clearTimeout(_debounce);
      _debounce = null;
      if (_cameraListener && _viewer) {
        _viewer.camera.changed.removeEventListener(_cameraListener);
        _cameraListener = null;
      }
      clearAll();
    },

    async update() {
      if (!_enabled) return true;
      // The camera listener owns loading; this only surfaces a hard failure.
      return _error === null;
    },

    destroy(viewer) {
      _generation += 1;
      clearTimeout(_debounce);
      if (_cameraListener && viewer) {
        viewer.camera.changed.removeEventListener(_cameraListener);
        _cameraListener = null;
      }
      clearAll();
      _cache.clear();
      _source = null;
      _sourcePromise = null;
      _viewer = null;
    },

    getStats() {
      const sleeping = _enabled && _active.size === 0 && !_loading && !_error;
      return {
        count: _featureCount,
        lastUpdate: _lastUpdate,
        error: _error,
        loading: _loading,
        loadingLabel: 'decoding tiles',
        // Not an error state: the layer is one county, and the camera is
        // usually somewhere else entirely.
        status: sleeping ? 'zoom-in' : undefined,
      };
    },

    getParams() {
      return { exaggeration: _exaggeration };
    },

    setParams(params) {
      const requested = Number(params?.exaggeration);
      if (!Number.isFinite(requested) || requested <= 0 || requested > 6) return false;
      if (requested !== _exaggeration) {
        _exaggeration = requested;
        // Heights are baked into the geometry, so a change means a rebuild.
        clearAll();
        void syncToCamera();
      }
      return true;
    },

    /** Fly to the county — the layer is invisible from anywhere else. */
    getFocusRectangle() {
      return Cesium.Rectangle.fromDegrees(
        PULASKI_BOUNDS.west, PULASKI_BOUNDS.south, PULASKI_BOUNDS.east, PULASKI_BOUNDS.north,
      );
    },
  };
}

export default createPulaskiBuildingsLayer();
