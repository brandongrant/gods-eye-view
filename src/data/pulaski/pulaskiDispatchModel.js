/**
 * Pure model behind the Pulaski dispatch layer: parsing, windowing, and card copy.
 *
 * Kept free of Cesium so the filtering and the wording can be tested directly —
 * the wording is not cosmetic here. These are **calls for service**: a request
 * that sent a unit somewhere, recorded before anyone established what happened.
 * A dispatch is not a confirmed offense, and every card has to say so, because
 * a coloured dot on a map reads as a fact about an address.
 *
 * Upstream's feature shape (`dispatch/out/all.geojson`), keys abbreviated:
 *   t   call-type label     c   category      ts  ISO timestamp
 *   loc address string      gq  geocode quality
 *   sens 1 when the call type is in a sensitive class
 *        (medical / welfare / death / sex / domestic / juvenile)
 *
 * @module data/pulaski/pulaskiDispatchModel
 */

import { pulaskiCategoryLabel, pulaskiWindow } from './pulaskiSources.js';

/**
 * Geocode qualities upstream publishes, worst to best.
 *
 * `interpolated` means the house number was estimated along the street — the
 * dot is on the right block, not necessarily the right building. Upstream
 * deliberately removed a street-centroid fallback because it manufactured
 * hotspots at wrong addresses, so anything weaker than this simply is not here.
 */
export const GEOCODE_QUALITY_NOTES = Object.freeze({
  exact_address: '',
  intersection: 'Placed at the intersection',
  interpolated: 'Position estimated along the block',
});

/**
 * Parse a dispatch FeatureCollection into flat records.
 *
 * Features without usable coordinates are dropped rather than defaulted: a call
 * at [0, 0] would render in the Gulf of Guinea.
 *
 * @param {any} geojson
 * @returns {{lon:number,lat:number,type:string,category:string,ts:string,tsMs:number,loc:string,gq:string,sensitive:boolean}[]}
 */
export function parseDispatchFeatures(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const records = [];
  for (const feature of features) {
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    // parseFloat, NOT Number(): `Number(null)` and `Number('')` are both 0, so a
    // null coordinate would sail through as a valid position at [0, 0].
    const lon = typeof coords[0] === 'number' ? coords[0] : Number.parseFloat(coords[0]);
    const lat = typeof coords[1] === 'number' ? coords[1] : Number.parseFloat(coords[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const props = feature.properties || {};
    const tsMs = props.ts ? Date.parse(props.ts) : NaN;
    records.push({
      lon,
      lat,
      type: String(props.t || ''),
      category: String(props.c || 'other'),
      ts: String(props.ts || ''),
      tsMs: Number.isFinite(tsMs) ? tsMs : NaN,
      loc: String(props.loc || ''),
      gq: String(props.gq || ''),
      sensitive: props.sens === 1 || props.sens === true,
    });
  }
  return records;
}

/**
 * Keep the records inside a named time window.
 *
 * A record with no parsable timestamp is kept only by `all`. Treating it as
 * "now" would park the whole undated tail inside every window.
 *
 * @param {{tsMs:number}[]} records
 * @param {string} windowId
 * @param {number} nowMs
 * @returns {any[]}
 */
export function filterByWindow(records, windowId, nowMs = Date.now()) {
  const window = pulaskiWindow(windowId);
  if (!window.hours) return records.slice();
  const cutoff = nowMs - window.hours * 3600 * 1000;
  return records.filter((record) => Number.isFinite(record.tsMs) && record.tsMs >= cutoff);
}

/**
 * Count records per category, highest first.
 *
 * @param {{category:string}[]} records
 * @returns {{category:string,count:number}[]}
 */
export function categoryCounts(records) {
  const counts = new Map();
  for (const record of records) {
    counts.set(record.category, (counts.get(record.category) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/**
 * Render a timestamp as an age.
 *
 * @param {number} tsMs
 * @param {number} nowMs
 * @returns {string}
 */
export function formatAge(tsMs, nowMs = Date.now()) {
  if (!Number.isFinite(tsMs)) return 'time unknown';
  const seconds = Math.max(0, Math.round((nowMs - tsMs) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Build the click-card copy for one call.
 *
 * The trailing provenance line is mandatory, not decorative — see the module
 * header.
 *
 * @param {any} record
 * @param {number} nowMs
 * @returns {{title:string,details:string[]}}
 */
export function dispatchCardCopy(record, nowMs = Date.now()) {
  const title = record?.type || pulaskiCategoryLabel(record?.category);
  const details = [];

  const when = formatAge(record?.tsMs, nowMs);
  const category = pulaskiCategoryLabel(record?.category);
  details.push(title === category ? when : `${category} · ${when}`);

  if (record?.loc) details.push(record.loc);

  const geocodeNote = GEOCODE_QUALITY_NOTES[record?.gq];
  if (geocodeNote) details.push(geocodeNote);

  if (record?.sensitive) {
    details.push('Sensitive call type — nature not published');
  }

  details.push('Call for service, not a confirmed offense');
  return { title, details };
}
