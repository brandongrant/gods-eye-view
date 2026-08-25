/**
 * Pulaski County reported offenses, 2017 → Feb 2025.
 *
 * 114,742 LRPD index/Part-I offenses carrying LRPD's own coordinates (no
 * geocoding step, so no geocode-quality caveat applies here). Shares the
 * dispatch palette deliberately: the two layers use one taxonomy, so a theft is
 * the same colour whether it arrived as a call or as a report.
 *
 * Drawn with a `PointPrimitiveCollection` for the same reason as the dispatch
 * layer — 114k entities would each cost a per-frame property evaluation.
 *
 * @module data/pulaski/pulaskiCrime
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
import { pulaskiCategoryColor, pulaskiCategoryLabel, pulaskiStaticBase } from './pulaskiSources.js';
import {
  CRIME_DEFAULT_ERA,
  CRIME_ERAS,
  crimeCardCopy,
  crimeCategoryCounts,
  crimeEra,
  crimeSourceLabel,
  expandCrimes,
  filterByEra,
} from './pulaskiCrimeModel.js';

export const PULASKI_CRIME_LAYER_ID = 'pulaski-crime';
const OVERLAY_SOURCE_ID = 'pulaski-crime-selected';
const POINT_PIXEL_SIZE = 5;

const crimesUrl = () => `${pulaskiStaticBase()}/crime/crimes.json`;

/**
 * @param {object} [options]
 * @param {object} [options.overlayHost] Test seam for the three worldOverlay calls.
 * @param {typeof fetch} [options.fetchImpl] Test seam for the network.
 * @returns {object} A DataLayerManager-compatible layer module.
 */
export function createPulaskiCrimeLayer({
  overlayHost = { clearSource: clearOverlaySource, setEntries: setOverlayEntries, setVisible: setOverlaySourceVisible },
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  let _viewer = null;
  let _points = null;
  let _records = [];
  let _visible = [];
  let _era = CRIME_DEFAULT_ERA;
  let _notPlotted = 0;
  let _loaded = false;
  let _loading = false;
  let _error = null;
  let _lastUpdate = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rowListener = null;
  let _generation = 0;
  const _byPickId = new Map();

  const notifyRow = () => { if (_rowListener) _rowListener(); };

  function rebuild() {
    if (!_points) return;
    _points.removeAll();
    _byPickId.clear();
    _visible = filterByEra(_records, _era);
    for (let index = 0; index < _visible.length; index += 1) {
      const record = _visible[index];
      const pickId = `${PULASKI_CRIME_LAYER_ID}:${index}`;
      _byPickId.set(pickId, record);
      _points.add({
        id: pickId,
        position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
        color: Cesium.Color.fromCssColorString(pulaskiCategoryColor(record.category)),
        pixelSize: POINT_PIXEL_SIZE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    governorRequestRender(`layer-rebuild:${PULASKI_CRIME_LAYER_ID}`);
    notifyRow();
  }

  return {
    id: PULASKI_CRIME_LAYER_ID,
    name: 'Pulaski Reported Crime',
    icon: '◆',
    source: 'LRPD 2017–2025',
    // The archive is a fixed historical export: fetch once, never poll.
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init(viewer) {
      _viewer = viewer;
      _points = new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.OPAQUE });
      _points.show = false;
      viewer.scene.primitives.add(_points);
      registerSpriteCollection(PULASKI_CRIME_LAYER_ID, _points);
      restoreSpriteOrder(viewer);
    },

    async enable(viewer) {
      _enabled = true;
      _error = null;
      if (_points) _points.show = true;
      overlayHost.setVisible(OVERLAY_SOURCE_ID, true);

      registerPickOwner(PULASKI_CRIME_LAYER_ID, (pickedId) => _byPickId.has(pickedId));
      if (!_clickHandler) {
        _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        _clickHandler.setInputAction((click) => {
          const picked = viewer.scene.pick(click.position);
          const record = _byPickId.get(picked?.id);
          if (!record) return;
          const copy = crimeCardCopy(record);
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
          governorRequestRender(`layer-pick:${PULASKI_CRIME_LAYER_ID}`);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
      restoreSpriteOrder(viewer);
      return true;
    },

    disable() {
      _enabled = false;
      _generation += 1;
      if (_points) _points.show = false;
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      if (_clickHandler) {
        _clickHandler.destroy();
        _clickHandler = null;
      }
      unregisterPickOwner(PULASKI_CRIME_LAYER_ID);
    },

    async update() {
      if (!_enabled || _loaded) return true;
      const generation = _generation;
      _loading = true;
      notifyRow();
      try {
        const response = await fetchImpl(crimesUrl());
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (generation !== _generation) return true;
        _records = expandCrimes(payload);
        _notPlotted = Number(payload?.not_plotted) || 0;
        _loaded = true;
        _lastUpdate = Date.now();
        _error = null;
        rebuild();
        return true;
      } catch (error) {
        if (generation !== _generation) return true;
        _error = `crime archive unavailable (${error?.message || error})`;
        return false;
      } finally {
        _loading = false;
        notifyRow();
      }
    },

    destroy(viewer) {
      _generation += 1;
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      if (_clickHandler) {
        _clickHandler.destroy();
        _clickHandler = null;
      }
      unregisterPickOwner(PULASKI_CRIME_LAYER_ID);
      if (_points && viewer?.scene?.primitives) viewer.scene.primitives.remove(_points);
      _points = null;
      _viewer = null;
      _records = [];
      _visible = [];
      _loaded = false;
      _byPickId.clear();
    },

    getStats() {
      return {
        count: _visible.length,
        lastUpdate: _lastUpdate,
        error: _error,
        loading: _loading,
        loadingLabel: 'loading archive',
        // Names the suppressed incidents beside the plotted ones, so the
        // shortfall is on the row rather than hidden in a doc.
        source: _loaded ? crimeSourceLabel(_visible.length, _notPlotted) : 'LRPD 2017–2025',
      };
    },

    getParams() {
      return { era: _era };
    },

    setParams(params) {
      const requested = params?.era;
      if (!requested) return false;
      const resolved = crimeEra(requested);
      if (resolved.id !== requested) return false;
      if (resolved.id !== _era) {
        _era = resolved.id;
        overlayHost.clearSource(OVERLAY_SOURCE_ID);
        rebuild();
      }
      return true;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const chips = CRIME_ERAS.map((era) => ({
        id: `era-${era.id}`,
        label: era.label,
        title: era.id === 'all'
          ? 'Every reported offense, 2017 to 3 February 2025'
          : `Offenses reported ${era.from}–${era.to}`,
        active: _era === era.id,
        params: { era: era.id },
      }));
      const legend = crimeCategoryCounts(_visible).map((entry) => ({
        label: pulaskiCategoryLabel(entry.category),
        color: pulaskiCategoryColor(entry.category),
        count: entry.count,
        blurb: `${pulaskiCategoryLabel(entry.category)} offenses reported in this period`,
      }));
      return { chips, legend };
    },
  };
}

export default createPulaskiCrimeLayer();
