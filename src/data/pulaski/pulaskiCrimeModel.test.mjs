// The interned crime payload is a fixed 7-tuple with four parallel lookup
// tables, so an off-by-one in any column produces records that look completely
// valid and describe the wrong crime. These pin the layout against real values
// read out of crimes.json, and pin the two honesty rules: suppressed locations
// are named, and the unpublished case-status codes are never guessed at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CRIME_ERAS,
  crimeCardCopy,
  crimeCategoryCounts,
  crimeEra,
  crimeSourceLabel,
  expandCrimes,
  filterByEra,
  formatCrimeDate,
  isMeaningfulWeapon,
} from './pulaskiCrimeModel.js';

// Trimmed from the real file: the first two records and the real vocabularies.
const PAYLOAD = {
  count: 114742,
  not_plotted: 6073,
  year_min: 2017,
  year_max: 2025,
  offenses: ['AGGRAVATED ASSAULT', 'ALL OTHER LARCENY', 'BURGLARY/B&E', 'ROBBERY'],
  off_cat: ['assault', 'theft', 'burglary', 'robbery'],
  statuses: ['OP', 'AD', 'AC', 'AR'],
  weapons: ['UNKNOWN', '', 'HANDGUN', '1'],
  locs: ['8819 ARCH ST', '1200 MAIN ST', '400 W CAPITOL AVE'],
  crime: [
    [-92.30535, 34.66745, 0, 20180407, 0, 2, 0],
    [-92.35019, 34.66859, 1, 20190503, 0, 1, 1],
    [-92.36628, 34.66034, 2, 20231127, 3, 0, 2],
    [-92.40804, 34.81408, 3, 20250203, 0, 3, 1],
  ],
};

test('the 7-tuple expands with every column landing in the right table', () => {
  const records = expandCrimes(PAYLOAD);
  assert.equal(records.length, 4);
  const [first] = records;
  assert.equal(first.lon, -92.30535);
  assert.equal(first.lat, 34.66745);
  assert.equal(first.offense, 'AGGRAVATED ASSAULT');
  assert.equal(first.category, 'assault');
  assert.equal(first.date, 20180407);
  assert.equal(first.year, 2018);
  assert.equal(first.weapon, 'HANDGUN');
  assert.equal(first.loc, '8819 ARCH ST');
});

test('offence and category come from the SAME index — the tables are parallel', () => {
  const records = expandCrimes(PAYLOAD);
  assert.equal(records[2].offense, 'BURGLARY/B&E');
  assert.equal(records[2].category, 'burglary');
  assert.equal(records[3].offense, 'ROBBERY');
  assert.equal(records[3].category, 'robbery');
});

test('an out-of-range index yields an empty string, never undefined in a card', () => {
  const records = expandCrimes({
    ...PAYLOAD,
    crime: [[-92.3, 34.7, 99, 20200101, 0, 99, 99]],
  });
  assert.equal(records[0].offense, '');
  assert.equal(records[0].weapon, '');
  assert.equal(records[0].loc, '');
  assert.equal(records[0].category, 'other');
});

test('unusable coordinates and malformed rows are dropped, not defaulted', () => {
  const records = expandCrimes({
    ...PAYLOAD,
    crime: [
      [null, 34.7, 0, 20200101, 0, 0, 0],
      [-92.3, '', 0, 20200101, 0, 0, 0],
      [-92.3, 34.7, 0],
      'not-a-row',
      [-92.3, 34.7, 0, 20200101, 0, 0, 0],
    ],
  });
  assert.equal(records.length, 1);
});

test('a malformed payload expands to nothing rather than throwing', () => {
  assert.deepEqual(expandCrimes(null), []);
  assert.deepEqual(expandCrimes({}), []);
  assert.deepEqual(expandCrimes({ crime: 'nope' }), []);
});

test('eras slice by year and ALL keeps everything', () => {
  const records = expandCrimes(PAYLOAD);
  assert.equal(filterByEra(records, 'all').length, 4);
  assert.equal(filterByEra(records, '2017-2019').length, 2);
  assert.equal(filterByEra(records, '2020-2022').length, 0);
  assert.equal(filterByEra(records, '2023-2025').length, 2);
});

test('an unknown era falls back to ALL instead of blanking the map', () => {
  const records = expandCrimes(PAYLOAD);
  assert.equal(filterByEra(records, 'the-nineties').length, 4);
  assert.equal(crimeEra('the-nineties').id, 'all');
  assert.equal(CRIME_ERAS[0].id, 'all');
});

test('filtering never mutates the source array', () => {
  const records = expandCrimes(PAYLOAD);
  filterByEra(records, 'all').push('junk');
  assert.equal(records.length, 4);
});

test('category counts are ordered by size', () => {
  const counts = crimeCategoryCounts([
    { category: 'theft' }, { category: 'theft' }, { category: 'assault' },
  ]);
  assert.deepEqual(counts, [
    { category: 'theft', count: 2 },
    { category: 'assault', count: 1 },
  ]);
});

test('dates render ISO, and an impossible one says so instead of printing garbage', () => {
  assert.equal(formatCrimeDate(20180407), '2018-04-07');
  assert.equal(formatCrimeDate(20250203), '2025-02-03');
  assert.equal(formatCrimeDate(NaN), 'date unknown');
  assert.equal(formatCrimeDate(0), 'date unknown');
});

test('noise weapon values are suppressed — printing one implies a finding', () => {
  assert.equal(isMeaningfulWeapon('HANDGUN'), true);
  assert.equal(isMeaningfulWeapon('KNIFE/CUTTING INSTRUMENT'), true);
  assert.equal(isMeaningfulWeapon('UNKNOWN'), false);
  assert.equal(isMeaningfulWeapon(''), false);
  assert.equal(isMeaningfulWeapon(undefined), false);
  // Upstream's vocabulary really does contain a bare "1".
  assert.equal(isMeaningfulWeapon('1'), false);
});

test('a card names the offence and does NOT hedge it as a mere call for service', () => {
  const [record] = expandCrimes(PAYLOAD);
  const { title, details } = crimeCardCopy(record);
  assert.equal(title, 'AGGRAVATED ASSAULT');
  assert.equal(details[0], '2018-04-07');
  assert.ok(details.includes('8819 ARCH ST'));
  assert.ok(details.includes('Weapon: HANDGUN'));
  assert.equal(details.at(-1), 'Reported offense · LRPD');
  assert.ok(!details.some((line) => /not a confirmed offense/i.test(line)));
});

test('the unpublished case-status code never reaches the card', () => {
  const records = expandCrimes(PAYLOAD);
  // Record 2 carries status index 3 -> "AR". Guessing that means an arrest
  // would put an invented claim about a real case on screen.
  const { details } = crimeCardCopy(records[2]);
  for (const code of ['OP', 'AD', 'AC', 'AR']) {
    assert.ok(!details.some((line) => line.split(/\s+/).includes(code)), `status ${code} leaked`);
  }
});

test('the row label names the suppressed incidents beside the plotted ones', () => {
  assert.equal(
    crimeSourceLabel(108669, 6073),
    'LRPD 2017–2025 · 6,073 locations suppressed',
  );
  assert.equal(crimeSourceLabel(100, 0), 'LRPD 2017–2025');
});
