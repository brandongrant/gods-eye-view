// A coloured dot on a map reads as a fact about an address, so the wording on a
// dispatch card is load-bearing, not cosmetic. These pin the two claims the card
// must never lose — that a call is not a confirmed offense, and that an
// interpolated position is an estimate — plus the windowing that decides which
// dots exist at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryCounts,
  dispatchCardCopy,
  filterByWindow,
  formatAge,
  parseDispatchFeatures,
} from './pulaskiDispatchModel.js';

const NOW = Date.parse('2026-08-25T12:00:00Z');
const hoursAgo = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString();

function feature(props, coords = [-92.26, 34.72]) {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: props };
}

test('parses the abbreviated upstream keys into flat records', () => {
  const [record] = parseDispatchFeatures({
    features: [feature({
      t: 'Suspicious Person',
      c: 'suspicious',
      ts: '2026-07-06T19:47:52Z',
      loc: '1100 E Roosevelt Rd',
      gq: 'exact_address',
      sens: 0,
    }, [-92.260913, 34.724785])],
  });
  assert.equal(record.type, 'Suspicious Person');
  assert.equal(record.category, 'suspicious');
  assert.equal(record.loc, '1100 E Roosevelt Rd');
  assert.equal(record.lon, -92.260913);
  assert.equal(record.lat, 34.724785);
  assert.equal(record.sensitive, false);
  assert.equal(record.tsMs, Date.parse('2026-07-06T19:47:52Z'));
});

test('sens:1 becomes a real boolean rather than a truthy number', () => {
  const [record] = parseDispatchFeatures({ features: [feature({ c: 'welfare', sens: 1 })] });
  assert.equal(record.sensitive, true);
});

test('a feature with unusable coordinates is dropped, not defaulted to [0,0]', () => {
  const records = parseDispatchFeatures({
    features: [
      feature({ c: 'theft' }, [null, 34.7]),
      feature({ c: 'theft' }, []),
      { type: 'Feature', properties: { c: 'theft' } },
      feature({ c: 'theft' }, [-92.3, 34.8]),
    ],
  });
  // A call defaulted to [0,0] would render in the Gulf of Guinea.
  assert.equal(records.length, 1);
  assert.equal(records[0].lon, -92.3);
});

test('a malformed payload yields no records instead of throwing', () => {
  assert.deepEqual(parseDispatchFeatures(null), []);
  assert.deepEqual(parseDispatchFeatures({}), []);
  assert.deepEqual(parseDispatchFeatures({ features: 'nope' }), []);
});

test('windows slice by age, and ALL keeps everything', () => {
  const records = parseDispatchFeatures({
    features: [
      feature({ c: 'shots', ts: hoursAgo(1) }),
      feature({ c: 'theft', ts: hoursAgo(48) }),
      feature({ c: 'alarm', ts: hoursAgo(24 * 20) }),
      feature({ c: 'other', ts: hoursAgo(24 * 100) }),
    ],
  });
  assert.equal(filterByWindow(records, '24h', NOW).length, 1);
  assert.equal(filterByWindow(records, '7d', NOW).length, 2);
  assert.equal(filterByWindow(records, '30d', NOW).length, 3);
  assert.equal(filterByWindow(records, 'all', NOW).length, 4);
});

test('an unparsable timestamp survives only ALL — otherwise the undated tail joins every window', () => {
  const records = parseDispatchFeatures({ features: [feature({ c: 'other', ts: 'not-a-date' })] });
  assert.equal(records.length, 1);
  assert.ok(Number.isNaN(records[0].tsMs));
  assert.equal(filterByWindow(records, '24h', NOW).length, 0);
  assert.equal(filterByWindow(records, 'all', NOW).length, 1);
});

test('an unknown window id falls back to the default rather than showing nothing', () => {
  const records = parseDispatchFeatures({
    features: [feature({ c: 'shots', ts: hoursAgo(1) }), feature({ c: 'theft', ts: hoursAgo(24 * 60) })],
  });
  assert.equal(filterByWindow(records, 'last-tuesday', NOW).length, 1);
});

test('filtering never mutates the source array', () => {
  const records = parseDispatchFeatures({ features: [feature({ c: 'shots', ts: hoursAgo(1) })] });
  filterByWindow(records, 'all', NOW).push('junk');
  assert.equal(records.length, 1);
});

test('category counts are ordered by size, ties broken by name', () => {
  const counts = categoryCounts([
    { category: 'theft' }, { category: 'theft' }, { category: 'theft' },
    { category: 'shots' }, { category: 'alarm' },
  ]);
  assert.deepEqual(counts, [
    { category: 'theft', count: 3 },
    { category: 'alarm', count: 1 },
    { category: 'shots', count: 1 },
  ]);
});

test('every card states that a call is not a confirmed offense', () => {
  const { title, details } = dispatchCardCopy({
    type: 'Vehicle Abandoned Vehicle',
    category: 'traffic',
    tsMs: NOW - 3600 * 1000,
    loc: '7211 Azalea Dr',
    gq: 'exact_address',
    sensitive: false,
  }, NOW);
  assert.equal(title, 'Vehicle Abandoned Vehicle');
  assert.equal(details.at(-1), 'Call for service, not a confirmed offense');
  assert.ok(details.includes('7211 Azalea Dr'));
  // exact_address is the good case and earns no hedge.
  assert.ok(!details.some((line) => /estimated|intersection/i.test(line)));
});

test('an interpolated position is labelled an estimate, not presented as an address', () => {
  const { details } = dispatchCardCopy(
    { type: 'Shooting', category: 'shots', tsMs: NOW, loc: '200 E 8TH ST', gq: 'interpolated' },
    NOW,
  );
  assert.ok(details.includes('Position estimated along the block'));
});

test('a sensitive call type is flagged as such', () => {
  const { details } = dispatchCardCopy(
    { type: 'Check Condition Of Subject', category: 'welfare', tsMs: NOW, sensitive: true },
    NOW,
  );
  assert.ok(details.includes('Sensitive call type — nature not published'));
  assert.equal(details.at(-1), 'Call for service, not a confirmed offense');
});

test('the category is not repeated when it already is the title', () => {
  const { title, details } = dispatchCardCopy({ category: 'theft', tsMs: NOW }, NOW);
  assert.equal(title, 'Theft');
  assert.equal(details[0], 'just now');
});

test('ages read plainly, and a missing timestamp says so instead of guessing', () => {
  assert.equal(formatAge(NOW - 30 * 1000, NOW), 'just now');
  assert.equal(formatAge(NOW - 20 * 60 * 1000, NOW), '20 min ago');
  assert.equal(formatAge(NOW - 5 * 3600 * 1000, NOW), '5 h ago');
  assert.equal(formatAge(NOW - 4 * 24 * 3600 * 1000, NOW), '4 d ago');
  assert.equal(formatAge(NaN, NOW), 'time unknown');
});
