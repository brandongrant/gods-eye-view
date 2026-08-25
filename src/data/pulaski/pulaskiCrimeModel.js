/**
 * Pure model behind the Pulaski reported-offense layer.
 *
 * Unlike the dispatch feed, these ARE reported offenses — LRPD index/Part-I
 * crimes, 2017 → 3 Feb 2025 — so the "not a confirmed offense" hedge that every
 * dispatch card carries would be wrong here. Two different honesty problems
 * apply instead:
 *
 *   1. **6,073 of 114,742 incidents are counted but never plotted.** LRPD
 *      suppresses their location (every RAPE row, among others). The map is
 *      therefore a view of *locatable* offenses, and the count has to say so or
 *      the map quietly under-reports.
 *   2. **The series ends 3 Feb 2025.** A 2025 bar next to a 2024 bar is not a
 *      like-for-like year; it is five weeks.
 *
 * Upstream ships an interned structure rather than GeoJSON — 114,742 records at
 * 5.3 MB instead of tens of megabytes. Each record is a fixed 7-tuple:
 *
 *   [lon, lat, offenseIdx, dateInt(YYYYMMDD), statusIdx, weaponIdx, locIdx]
 *
 * @module data/pulaski/pulaskiCrimeModel
 */

/** Eras offered on the row. Nine individual year chips would not fit. */
export const CRIME_ERAS = Object.freeze([
  { id: 'all', label: 'ALL', from: 0, to: 9999 },
  { id: '2017-2019', label: "'17–'19", from: 2017, to: 2019 },
  { id: '2020-2022', label: "'20–'22", from: 2020, to: 2022 },
  { id: '2023-2025', label: "'23–'25", from: 2023, to: 2025 },
]);

export const CRIME_DEFAULT_ERA = 'all';

/**
 * @param {string} id
 * @returns {{id:string,label:string,from:number,to:number}}
 */
export function crimeEra(id) {
  return CRIME_ERAS.find((era) => era.id === id) || CRIME_ERAS[0];
}

/**
 * Expand the interned payload into flat records.
 *
 * Index lookups are bounds-checked: a corrupt index would otherwise surface as
 * `undefined` in a card, which reads like a real value with a rendering bug
 * rather than like bad data.
 *
 * @param {any} payload Parsed crimes.json.
 * @returns {{lon:number,lat:number,offense:string,category:string,year:number,date:number,weapon:string,loc:string}[]}
 */
export function expandCrimes(payload) {
  const rows = Array.isArray(payload?.crime) ? payload.crime : [];
  const offenses = payload?.offenses || [];
  const categories = payload?.off_cat || [];
  const weapons = payload?.weapons || [];
  const locs = payload?.locs || [];
  const at = (list, index) => (Number.isInteger(index) && index >= 0 && index < list.length ? list[index] : '');

  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const lon = typeof row[0] === 'number' ? row[0] : Number.parseFloat(row[0]);
    const lat = typeof row[1] === 'number' ? row[1] : Number.parseFloat(row[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const date = Number(row[3]);
    out.push({
      lon,
      lat,
      offense: at(offenses, row[2]),
      category: at(categories, row[2]) || 'other',
      year: Number.isFinite(date) ? Math.floor(date / 10000) : NaN,
      date: Number.isFinite(date) ? date : NaN,
      weapon: at(weapons, row[5]),
      loc: at(locs, row[6]),
    });
  }
  return out;
}

/**
 * @param {{year:number}[]} records
 * @param {string} eraId
 * @returns {any[]}
 */
export function filterByEra(records, eraId) {
  const era = crimeEra(eraId);
  if (era.id === 'all') return records.slice();
  return records.filter((record) => record.year >= era.from && record.year <= era.to);
}

/**
 * @param {{category:string}[]} records
 * @returns {{category:string,count:number}[]}
 */
export function crimeCategoryCounts(records) {
  const counts = new Map();
  for (const record of records) counts.set(record.category, (counts.get(record.category) || 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/**
 * Format a YYYYMMDD integer as an ISO date.
 *
 * @param {number} date
 * @returns {string}
 */
export function formatCrimeDate(date) {
  if (!Number.isFinite(date) || date < 10000101) return 'date unknown';
  const text = String(Math.trunc(date));
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

/**
 * Weapon values worth showing. `UNKNOWN`, blank, and the stray `"1"` in
 * upstream's vocabulary are noise, and printing them implies a finding.
 *
 * @param {string} weapon
 * @returns {boolean}
 */
export function isMeaningfulWeapon(weapon) {
  const text = String(weapon || '').trim();
  if (!text || text.toUpperCase() === 'UNKNOWN') return false;
  return /[A-Za-z]/.test(text);
}

/**
 * Build the click-card copy for one offense.
 *
 * The case status code is deliberately NOT rendered. Upstream ships bare codes
 * (`OP`, `AD`, `AC`, `AR`, …) with no published key, and guessing that `AR`
 * means an arrest would put an invented claim about a real case on the screen.
 *
 * @param {any} record
 * @returns {{title:string,details:string[]}}
 */
export function crimeCardCopy(record) {
  const title = record?.offense || 'Reported offense';
  const details = [formatCrimeDate(record?.date)];
  if (record?.loc) details.push(record.loc);
  if (isMeaningfulWeapon(record?.weapon)) details.push(`Weapon: ${record.weapon}`);
  details.push('Reported offense · LRPD');
  return { title, details };
}

/**
 * One-line provenance for the layer row.
 *
 * Names the suppressed count in the same breath as the plotted one, so the
 * shortfall is never something a reader has to go looking for.
 *
 * @param {number} plotted
 * @param {number} notPlotted
 * @returns {string}
 */
export function crimeSourceLabel(plotted, notPlotted) {
  const suppressed = Number(notPlotted) || 0;
  if (!suppressed) return 'LRPD 2017–2025';
  return `LRPD 2017–2025 · ${suppressed.toLocaleString('en-US')} locations suppressed`;
}
