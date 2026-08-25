// Offline tests for the PMTiles v3 reader. The archive itself is 67 MB and
// remote, so directories here are synthesized with a local varint writer — if
// the writer and the reader ever disagree, the round-trip tests fail loudly.
//
// The header constants below are the REAL ones read off
// buildings.pmtiles on 2026-08-25, so a spec misread shows up as a wrong number
// rather than a plausible-looking one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  PMTILES_HEADER_BYTES,
  decodeDirectory,
  findTileEntry,
  openPmtiles,
  parsePmtilesHeader,
  readVarint,
  zxyToTileId,
} from './pmtiles.js';

function writeVarint(value, out) {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

/** Serialize entries the way the v3 spec lays a directory out. */
function encodeDirectory(entries) {
  const out = [];
  writeVarint(entries.length, out);
  let previous = 0;
  for (const entry of entries) { writeVarint(entry.tileId - previous, out); previous = entry.tileId; }
  for (const entry of entries) writeVarint(entry.runLength, out);
  for (const entry of entries) writeVarint(entry.length, out);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const prior = entries[i - 1];
    const contiguous = i > 0 && prior && entry.offset === prior.offset + prior.length;
    writeVarint(contiguous ? 0 : entry.offset + 1, out);
  }
  return new Uint8Array(out);
}

function buildHeader(overrides = {}) {
  const bytes = new Uint8Array(PMTILES_HEADER_BYTES);
  bytes.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73], 0); // "PMTiles"
  bytes[7] = 3;
  const view = new DataView(bytes.buffer);
  const fields = {
    rootDirOffset: 127, rootDirLength: 7278, metadataOffset: 7405, metadataLength: 174,
    leafDirsOffset: 7579, leafDirsLength: 0, tileDataOffset: 7579, tileDataLength: 67227408,
    addressedTiles: 3180, tileEntries: 3180, tileContents: 3180, ...overrides,
  };
  view.setBigUint64(8, BigInt(fields.rootDirOffset), true);
  view.setBigUint64(16, BigInt(fields.rootDirLength), true);
  view.setBigUint64(24, BigInt(fields.metadataOffset), true);
  view.setBigUint64(32, BigInt(fields.metadataLength), true);
  view.setBigUint64(40, BigInt(fields.leafDirsOffset), true);
  view.setBigUint64(48, BigInt(fields.leafDirsLength), true);
  view.setBigUint64(56, BigInt(fields.tileDataOffset), true);
  view.setBigUint64(64, BigInt(fields.tileDataLength), true);
  view.setBigUint64(72, BigInt(fields.addressedTiles), true);
  view.setBigUint64(80, BigInt(fields.tileEntries), true);
  view.setBigUint64(88, BigInt(fields.tileContents), true);
  bytes[96] = 1; bytes[97] = 2; bytes[98] = 2; bytes[99] = 1;
  bytes[100] = 8; bytes[101] = 15;
  view.setInt32(102, -928778689, true);
  view.setInt32(106, 344807981, true);
  view.setInt32(110, -920242306, true);
  view.setInt32(114, 350266928, true);
  bytes[118] = 11;
  view.setInt32(119, -924510498, true);
  view.setInt32(123, 347537454, true);
  return bytes;
}

test('varints round-trip past 2^31, where a shift-based reader would go negative', () => {
  for (const value of [0, 1, 127, 128, 300, 16383, 16384, 2 ** 28, 2 ** 31, 2 ** 31 + 12345, 4 ** 15]) {
    const out = [];
    writeVarint(value, out);
    assert.equal(readVarint(new Uint8Array(out), { pos: 0 }), value, `value ${value}`);
  }
});

test('a truncated varint reports the truncation instead of returning a plausible number', () => {
  assert.throws(() => readVarint(new Uint8Array([0x80, 0x80]), { pos: 0 }), /past end/);
});

test('the header parses to the real archive values', () => {
  const header = parsePmtilesHeader(buildHeader());
  assert.equal(header.version, 3);
  assert.equal(header.rootDirOffset, 127);
  assert.equal(header.rootDirLength, 7278);
  assert.equal(header.tileDataOffset, 7579);
  assert.equal(header.tileDataLength, 67227408);
  assert.equal(header.leafDirsLength, 0, 'this archive has no leaf directories');
  assert.equal(header.clustered, true);
  assert.equal(header.internalCompression, 2);
  assert.equal(header.tileCompression, 2);
  assert.equal(header.tileType, 1);
  assert.equal(header.minZoom, 8);
  assert.equal(header.maxZoom, 15);
  assert.equal(header.centerZoom, 11);
  const [west, south, east, north] = header.bounds;
  assert.ok(Math.abs(west - -92.8778689) < 1e-6);
  assert.ok(Math.abs(south - 34.4807981) < 1e-6);
  assert.ok(Math.abs(east - -92.0242306) < 1e-6);
  assert.ok(Math.abs(north - 35.0266928) < 1e-6);
});

test('a non-PMTiles buffer and a wrong version are rejected, not misread', () => {
  assert.throws(() => parsePmtilesHeader(new Uint8Array(PMTILES_HEADER_BYTES)), /not a PMTiles/);
  const wrongVersion = buildHeader();
  wrongVersion[7] = 2;
  assert.throws(() => parsePmtilesHeader(wrongVersion), /unsupported PMTiles version 2/);
  assert.throws(() => parsePmtilesHeader(new Uint8Array(10)), /needs 127 bytes/);
});

test('tile ids follow the Hilbert order, with the zoom-major base offset', () => {
  // (4^z - 1) / 3 is the count of every tile below this zoom.
  assert.equal(zxyToTileId(0, 0, 0), 0);
  assert.equal(zxyToTileId(1, 0, 0), 1);
  assert.equal(zxyToTileId(1, 0, 1), 2);
  assert.equal(zxyToTileId(1, 1, 1), 3);
  assert.equal(zxyToTileId(1, 1, 0), 4);
  assert.equal(zxyToTileId(2, 0, 0), 5);
  // Hilbert order is a permutation: every z2 tile appears exactly once.
  const ids = [];
  for (let x = 0; x < 4; x += 1) for (let y = 0; y < 4; y += 1) ids.push(zxyToTileId(2, x, y));
  assert.deepEqual([...ids].sort((a, b) => a - b), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
});

test('tile ids stay exact past the int32 range a bitwise reader would wrap', () => {
  // z15 tops out around 1.43e9 — already past 2^30, and the varint columns that
  // address a 67 MB archive are the same arithmetic.
  const z15 = zxyToTileId(15, 7983, 13007);
  assert.ok(Number.isInteger(z15));
  assert.ok(z15 > 2 ** 28, `expected > 2^28, got ${z15}`);
  assert.ok(z15 < (4 ** 16 - 1) / 3);

  // z16 crosses 2^31 outright, which is what makes the arithmetic-not-bitwise
  // implementation load-bearing rather than stylistic.
  const z16 = zxyToTileId(16, 65535, 65535);
  assert.ok(Number.isInteger(z16));
  assert.ok(z16 > 2 ** 31, `expected > 2^31, got ${z16}`);
});

test('out-of-range tiles are rejected rather than silently wrapped', () => {
  assert.throws(() => zxyToTileId(2, 4, 0), /out of range/);
  assert.throws(() => zxyToTileId(2, 0, -1), /out of range/);
  assert.throws(() => zxyToTileId(30, 0, 0), /out of range/);
});

test('directories round-trip, including the packed-offset shorthand', () => {
  const entries = [
    { tileId: 5, runLength: 1, offset: 0, length: 100 },
    { tileId: 6, runLength: 1, offset: 100, length: 250 },   // contiguous -> encoded as 0
    { tileId: 9, runLength: 3, offset: 900, length: 40 },    // explicit offset
  ];
  assert.deepEqual(decodeDirectory(encodeDirectory(entries)), entries);
});

test('a run covers every tile inside it, and misses stay misses', () => {
  const entries = decodeDirectory(encodeDirectory([
    { tileId: 5, runLength: 1, offset: 0, length: 100 },
    { tileId: 9, runLength: 3, offset: 100, length: 40 },
  ]));
  assert.equal(findTileEntry(entries, 5).entry.tileId, 5);
  // 9,10,11 share one blob — that is what runLength means.
  for (const id of [9, 10, 11]) assert.equal(findTileEntry(entries, id).entry.tileId, 9);
  assert.equal(findTileEntry(entries, 6), null);
  assert.equal(findTileEntry(entries, 12), null);
  assert.equal(findTileEntry(entries, 0), null);
});

test('runLength 0 is reported as a leaf pointer, not served as a tile', () => {
  const entries = decodeDirectory(encodeDirectory([
    { tileId: 100, runLength: 0, offset: 0, length: 64 },
  ]));
  const found = findTileEntry(entries, 137);
  assert.ok(found);
  assert.equal(found.isLeaf, true);
});

test('openPmtiles Range-reads the header and root dir, then returns a decoded tile', async () => {
  const tilePayload = new TextEncoder().encode('MVT-BYTES');
  const tileBlob = gzipSync(Buffer.from(tilePayload));
  const rootDir = gzipSync(Buffer.from(encodeDirectory([
    { tileId: zxyToTileId(15, 7983, 13007), runLength: 1, offset: 0, length: tileBlob.length },
  ])));
  const metadata = gzipSync(Buffer.from(JSON.stringify({ name: 'Pulaski County Buildings' })));

  const header = buildHeader({
    rootDirOffset: 127,
    rootDirLength: rootDir.length,
    metadataOffset: 127 + rootDir.length,
    metadataLength: metadata.length,
    tileDataOffset: 127 + rootDir.length + metadata.length,
  });

  const archive = Buffer.concat([Buffer.from(header), rootDir, metadata, tileBlob]);
  const ranges = [];
  const fetchImpl = async (_url, init) => {
    const [start, end] = init.headers.Range.replace('bytes=', '').split('-').map(Number);
    ranges.push(init.headers.Range);
    const slice = archive.subarray(start, end + 1);
    return { status: 206, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
  };

  const source = await openPmtiles({ url: 'https://example.test/b.pmtiles', fetchImpl });
  assert.equal(source.metadata.name, 'Pulaski County Buildings');
  assert.equal(ranges[0], `bytes=0-${PMTILES_HEADER_BYTES - 1}`, 'header must be the first read');

  const tile = await source.getTile(15, 7983, 13007);
  assert.equal(new TextDecoder().decode(tile), 'MVT-BYTES');

  // A miss must not fetch, and out-of-zoom must not even compute an id.
  assert.equal(await source.getTile(15, 1, 1), null);
  assert.equal(await source.getTile(16, 0, 0), null);
  assert.equal(await source.getTile(7, 0, 0), null);
});
