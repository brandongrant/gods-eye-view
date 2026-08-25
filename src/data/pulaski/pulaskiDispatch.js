/**
 * Pulaski County calls for service — a live layer over the hourly dispatch feed.
 *
 * Upstream's collector polls the City of Little Rock's public CAD endpoint and
 * republishes `dispatch/out/all.geojson` (~15.8k geocoded calls since
 * 2026-07-06). The archive is rewritten wholesale on every collector run, so
 * this polls the 599-byte `stats.json` and only re-downloads the 3.7 MB archive
 * when its `updated` stamp actually moves.
 *
 * Points are drawn with a `PointPrimitiveCollection`, not entities. Fifteen
 * thousand `Entity` objects would cost a per-frame property evaluation each;
 * the primitive collection uploads once and costs nothing per frame — the same
 * reasoning `earthquakes.js` records for keeping its ellipse axes static.
 *
 * These are **calls for service**, not confirmed offenses. See
 * `pulaskiDispatchModel.js` for why every card says so.
 *
 * @module data/pulaski/pulaskiDispatch
 */

import * as Cesium from 'cesium';
import { governorRequestRender } from '../../renderGovernor.js';
import { registerSpriteCollection, restoreSpriteOrder } from '../spriteOrder.js';
import { registerPickOwner, unregisterPickOwner } from '../pickRegistry.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';
import {
  PULASKI_DEFAULT_WINDOW,
  PULASKI_WINDOWS,
  pulaskiCategoryColor,
  pulaskiCategoryLabel,
  pulaskiLiveBase,
  pulaskiWindow,
} from './pulaskiSources.js';
import {
  categoryCounts,
  dispatchCardCopy,
  filterByWindow,
  parseDispatchFeatures,
} from './pulaskiDispatchModel.js';

export const PULASKI_DISPATCH_LAYER_ID = 'pulaski-dispatch';
const OVERLAY_SOURCE_ID = 'pulaski-dispatch-selected';
const POLL_MS = 5 * 60 * 1000;
const LEGEND_LIMIT = 6;
const POINT_PIXEL_SIZE = 7;

const statsUrl = () => `${pulaskiLiveBase()}/dispatch/out/stats.json`;
const archiveUrl = () => `${pulaskiLiveBase()}/dispatch/out/all.geojson`;

/**
 * @param {object} [options]
 * @param {object} [options.overlayHost] Test seam for the three worldOverlay calls.
 * @param {typeof fetch} [options.fetchImpl] Test seam for the network.
 * @returns {object} A DataLayerManager-compatible layer module.
 */
export function createPulaskiDispatchLayer({
  overlayHost = { clearSource: clearOverlaySource, setEntries: setOverlayEntries, setVisible: setOverlaySourceVisible },
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  let _viewer = null;
  let _points = null;
  let _records = [];
  let _visible = [];
  let _window = PULASKI_DEFAULT_WINDOW;
  let _loadedStamp = null;
  let _lastUpdate = null;
  let _error = null;
  let _loading = false;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  /** Bumped on every disable so an in-flight archive load cannot repopulate a hidden layer. */
  let _generation = 0;
  const _byPickId = new Map();

  const notifyRow = () => { if (_rowListener) _rowListener(); };

  function clearSelection() {
    overlayHost.clearSource(OVERLAY_SOURCE_ID);
  }

  function rebuild() {
    if (!_points) return;
    _points.removeAll();
    _byPickId.clear();
    _visible = filterByWindow(_records, _window);
    for (let index = 0; index < _visible.length; index += 1) {
      const record = _visible[index];
      const pickId = `${PULASKI_DISPATCH_LAYER_ID}:${index}`;
      _byPickId.set(pickId, record);
      _points.add({
        id: pickId,
        position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
        color: Cesium.Color.fromCssColorString(pulaskiCategoryColor(record.category)),
        pixelSize: POINT_PIXEL_SIZE,
        // Calls sit on the ground under photoreal mesh; without this they wink
        // out behind buildings at street level, which reads as missing data.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    governorRequestRender(`layer-rebuild:${PULASKI_DISPATCH_LAYER_ID}`);
    notifyRow();
  }

  async function loadArchive(generation) {
    _loading = true;
    notifyRow();
    try {
      // No custom headers anywhere in here: neither GitHub host answers a CORS
      // preflight, so adding one turns a working fetch into a browser failure.
      const response = await fetchImpl(archiveUrl());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const geojson = await response.json();
      if (generation !== _generation) return false;
      _records = parseDispatchFeatures(geojson);
      _lastUpdate = Date.now();
      _error = null;
      rebuild();
      return true;
    } catch (error) {
      if (generation !== _generation) return false;
      _error = `dispatch archive unavailable (${error?.message || error})`;
      return false;
    } finally {
      _loading = false;
      notifyRow();
    }
  }

  return {
    id: PULASKI_DISPATCH_LAYER_ID,
    name: 'Pulaski Calls for Service',
    icon: '◈',
    source: 'Little Rock CAD',
    updateInterval: POLL_MS,

    init(viewer) {
      _viewer = viewer;
      _points = new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.OPAQUE });
      _points.show = false;
      viewer.scene.primitives.add(_points);
      registerSpriteCollection(PULASKI_DISPATCH_LAYER_ID, _points);
      _records = [];
      _visible = [];
      _loadedStamp = null;
      _lastUpdate = null;
      _error = null;
      restoreSpriteOrder(viewer);
    },

    enable(viewer) {
      _enabled = true;
      _error = null;
      if (_points) _points.show = true;
      overlayHost.setVisible(OVERLAY_SOURCE_ID, true);

      registerPickOwner(PULASKI_DISPATCH_LAYER_ID, (pickedId) => _byPickId.has(pickedId));
      if (!_clickHandler) {
        _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        _clickHandler.setInputAction((click) => {
          const picked = viewer.scene.pick(click.position);
          const record = _byPickId.get(picked?.id);
          if (!record) return;
          const copy = dispatchCardCopy(record);
          overlayHost.setEntries(OVERLAY_SOURCE_ID, [{
            id: 'selected',
            source: OVERLAY_SOURCE_ID,
            position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
            variant: 'card',
            title: copy.title,
            details: copy.details,
            accent: pulaskiCategoryColor(record.category),
            priority: 10000,
            collisionGroup: 'ambient-card',
            zIndex: 40,
            interactive: false,
            minDistance: 0,
            maxDistance: 14000000,
            edgeFade: 'keyhole',
            horizonCull: true,
            terrainOcclusion: false,
            gapPx: 15,
            placement: 'above',
          }], { cohortLimit: 1, collisionCapacity: 1, moving: false });
          governorRequestRender(`layer-pick:${PULASKI_DISPATCH_LAYER_ID}`);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
      restoreSpriteOrder(viewer);
    },

    disable() {
      _enabled = false;
      // Invalidate any archive load already in flight, or it would repopulate
      // the collection after the layer was switched off.
      _generation += 1;
      if (_points) _points.show = false;
      clearSelection();
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      if (_clickHandler) {
        _clickHandler.destroy();
        _clickHandler = null;
      }
      unregisterPickOwner(PULASKI_DISPATCH_LAYER_ID);
    },

    async update() {
      if (!_enabled) return true;
      const generation = _generation;
      try {
        const response = await fetchImpl(statsUrl());
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const stats = await response.json();
        if (generation !== _generation) return true;
        // The collector rewrites all.geojson wholesale each run. Re-pulling
        // 3.7 MB on a timer regardless of whether it moved would be the single
        // most expensive thing this layer does.
        if (stats?.updated && stats.updated === _loadedStamp && _records.length) {
          _lastUpdate = Date.now();
          _error = null;
          return true;
        }
        const loaded = await loadArchive(generation);
        if (loaded) _loadedStamp = stats?.updated || null;
        return loaded;
      } catch (error) {
        if (generation !== _generation) return true;
        _error = `dispatch feed unavailable (${error?.message || error})`;
        return false;
      }
    },

    destroy(viewer) {
      _generation += 1;
      clearSelection();
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      if (_clickHandler) {
        _clickHandler.destroy();
        _clickHandler = null;
      }
      unregisterPickOwner(PULASKI_DISPATCH_LAYER_ID);
      if (_points && viewer?.scene?.primitives) viewer.scene.primitives.remove(_points);
      _points = null;
      _viewer = null;
      _records = [];
      _visible = [];
      _byPickId.clear();
    },

    getStats() {
      return {
        count: _visible.length,
        lastUpdate: _lastUpdate,
        error: _error,
        loading: _loading,
        loadingLabel: 'loading archive',
      };
    },

    getParams() {
      return { window: _window };
    },

    setParams(params) {
      const requested = params?.window;
      if (!requested) return false;
      const resolved = pulaskiWindow(requested);
      if (resolved.id !== requested) return false;
      if (resolved.id !== _window) {
        _window = resolved.id;
        clearSelection();
        rebuild();
      }
      return true;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const chips = PULASKI_WINDOWS.map((entry) => ({
        id: `window-${entry.id}`,
        label: entry.label,
        title: entry.hours
          ? `Calls from the last ${entry.label}`
          : 'Every call since collection began (2026-07-06)',
        active: _window === entry.id,
        params: { window: entry.id },
      }));
      const legend = categoryCounts(_visible)
        .slice(0, LEGEND_LIMIT)
        .map((entry) => ({
          label: pulaskiCategoryLabel(entry.category),
          color: pulaskiCategoryColor(entry.category),
          count: entry.count,
          blurb: `${pulaskiCategoryLabel(entry.category)} calls for service in this window`,
        }));
      return { chips, legend };
    },
  };
}

export default createPulaskiDispatchLayer();
