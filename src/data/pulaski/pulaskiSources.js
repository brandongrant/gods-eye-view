/**
 * Where the Pulaski County datasets live, and how their categories are drawn.
 *
 * The upstream project (`brandongrant/pulaski_building_map`) publishes two
 * surfaces, and the split matters:
 *
 *   - **Pages** (`PULASKI_STATIC_BASE`) — the committed snapshot. Correct MIME
 *     types, moves only when the site redeploys.
 *   - **the `data` branch** (`PULASKI_LIVE_BASE`) — rewritten hourly by the
 *     collectors. `Content-Type: text/plain` on everything, and a five-minute
 *     CDN cache, so never assert byte-exact sizes against it.
 *
 * Both send `Access-Control-Allow-Origin: *` and honour Range requests, but
 * **neither answers a CORS preflight**. Any custom request header (an
 * `Authorization`, an `X-*`, a non-safelisted `Accept`) turns a working fetch
 * into a failed preflight in the browser while still passing under curl. Keep
 * every request here header-free.
 *
 * `window.__PULASKI_BASE__` overrides both, so a deployment can repoint at its
 * own mirror without a rebuild.
 *
 * @module data/pulaski/pulaskiSources
 */

const DEFAULT_STATIC_BASE = 'https://brandongrant.github.io/pulaski_building_map/data';
const DEFAULT_LIVE_BASE = 'https://raw.githubusercontent.com/brandongrant/pulaski_building_map/data';

/** @returns {string} Base URL for the committed snapshot assets. */
export function pulaskiStaticBase() {
  return globalThis.__PULASKI_BASE__ || DEFAULT_STATIC_BASE;
}

/** @returns {string} Base URL for the hourly collector outputs. */
export function pulaskiLiveBase() {
  return globalThis.__PULASKI_LIVE_BASE__ || DEFAULT_LIVE_BASE;
}

export const PULASKI_STATIC_BASE = DEFAULT_STATIC_BASE;
export const PULASKI_LIVE_BASE = DEFAULT_LIVE_BASE;

/**
 * Dispatch/offense categories and their colours.
 *
 * Ordered by how much they draw the eye, not alphabetically: violence first,
 * then property, then quality-of-life, then the service calls. `domestic` and
 * `juvenile` appear in the 30-day grid but not in the headline category totals,
 * so they are included here to keep the palette total.
 */
export const PULASKI_CATEGORIES = Object.freeze({
  shots: { label: 'Shots fired', color: '#ff2d2d', violent: true },
  assault: { label: 'Assault', color: '#ff5a36', violent: true },
  robbery: { label: 'Robbery', color: '#ff3d81', violent: true },
  sex: { label: 'Sex offense', color: '#d64ea8', violent: true, sensitive: true },
  domestic: { label: 'Domestic', color: '#e0559b', violent: true, sensitive: true },
  burglary: { label: 'Burglary', color: '#ff9f1c', violent: false },
  theft: { label: 'Theft', color: '#ffc233', violent: false },
  vandalism: { label: 'Vandalism', color: '#ffe066', violent: false },
  fraud: { label: 'Fraud', color: '#d4b483', violent: false },
  drugs: { label: 'Drugs', color: '#b565d8', violent: false },
  disturbance: { label: 'Disturbance', color: '#4dabf7', violent: false },
  suspicious: { label: 'Suspicious', color: '#74c0fc', violent: false },
  trespass: { label: 'Trespass', color: '#63e6be', violent: false },
  alarm: { label: 'Alarm', color: '#38d9a9', violent: false },
  welfare: { label: 'Welfare check', color: '#9775fa', violent: false, sensitive: true },
  juvenile: { label: 'Juvenile', color: '#a5d8ff', violent: false, sensitive: true },
  animal: { label: 'Animal', color: '#8ce99a', violent: false },
  traffic: { label: 'Traffic', color: '#adb5bd', violent: false },
  assist: { label: 'Assist', color: '#868e96', violent: false },
  other: { label: 'Other', color: '#6c757d', violent: false },
});

/** Fallback colour for a category the upstream taxonomy adds later. */
export const PULASKI_UNKNOWN_COLOR = '#94a3b8';

/**
 * @param {string} category
 * @returns {string} CSS colour for a dispatch/offense category.
 */
export function pulaskiCategoryColor(category) {
  return PULASKI_CATEGORIES[category]?.color || PULASKI_UNKNOWN_COLOR;
}

/**
 * @param {string} category
 * @returns {string} Human label for a dispatch/offense category.
 */
export function pulaskiCategoryLabel(category) {
  return PULASKI_CATEGORIES[category]?.label || (category ? String(category) : 'Unknown');
}

/**
 * Time windows offered on the dispatch row.
 *
 * `all` reaches back to the start of collection (2026-07-06), not to the start
 * of time — the archive simply does not exist before then.
 */
export const PULASKI_WINDOWS = Object.freeze([
  { id: '24h', label: '24H', hours: 24 },
  { id: '7d', label: '7D', hours: 24 * 7 },
  { id: '30d', label: '30D', hours: 24 * 30 },
  { id: 'all', label: 'ALL', hours: null },
]);

export const PULASKI_DEFAULT_WINDOW = '30d';

/**
 * @param {string} id
 * @returns {{id:string,label:string,hours:number|null}} Window descriptor, defaulted.
 */
export function pulaskiWindow(id) {
  return PULASKI_WINDOWS.find((entry) => entry.id === id)
    || PULASKI_WINDOWS.find((entry) => entry.id === PULASKI_DEFAULT_WINDOW);
}
