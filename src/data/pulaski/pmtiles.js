/**
 * A minimal PMTiles v3 reader, enough to pull single tiles over HTTP Range.
 *
 * Cesium cannot consume a MapLibre vector tileset, so the Pulaski building
 * footprints (`buildings.pmtiles`, 67 MB, z8–z15, 225,774 footprints) are read
 * here and turned into Cesium geometry by `pulaskiBuildings.js`. Pulling the
 * whole archive would be absurd; PMTiles exists precisely so you can Range-read
 * one tile at a time, and both GitHub hosts serve real `206 Partial Content`.
 *
 * `Range` is a CORS-safelisted request header for simple `bytes=a-b` values, so
 * these requests do not trigger a preflight — which matters, because neither
 * GitHub host answers one. Do not add any other header to these fetches.
 *
 * Format reference: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 *
 * @module data/pulaski/pmtiles
 */

export const PMTILES_HEADER_BYTES = 127;
const PMTILES_MAGIC = 'PMTiles';

/** Compression ids from the v3 spec. */
export const PMTILES_COMPRESSION = Object.freeze({
  unknown: 0, none: 1, gzip: 2, brotli: 3, zstd: 4,
});

/**
 * Read unsigned LEB128.
 *
 * Deliberately arithmetic, not bitwise: `<<` coerces to int32, and tile ids at
 * z15 already exceed 2^31, so a shift-based reader silently wraps negative.
 *
 * @param {Uint8Array} bytes
 * @param {{pos:number}} cursor
 * @returns {number}
 */
export function readVarint(bytes, cursor) {
  let result = 0;
  let shift = 1;
  for (;;) {
    if (cursor.pos >= bytes.length) throw new Error('varint runs past end of buffer');
    const byte = bytes[cursor.pos];
    cursor.pos += 1;
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return result;
    shift *= 128;
    if (shift > Number.MAX_SAFE_INTEGER) throw new Error('varint exceeds safe integer range');
  }
}

/**
 * Parse the fixed 127-byte header.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {object}
 */
export function parsePmtilesHeader(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < PMTILES_HEADER_BYTES) {
    throw new Error(`PMTiles header needs ${PMTILES_HEADER_BYTES} bytes, got ${bytes.length}`);
  }
  const magic = String.fromCharCode(...bytes.subarray(0, 7));
  if (magic !== PMTILES_MAGIC) throw new Error(`not a PMTiles archive (magic "${magic}")`);
  const version = bytes[7];
  if (version !== 3) throw new Error(`unsupported PMTiles version ${version}`);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (offset) => Number(view.getBigUint64(offset, true));
  const e7 = (offset) => view.getInt32(offset, true) / 1e7;

  return {
    version,
    rootDirOffset: u64(8),
    rootDirLength: u64(16),
    metadataOffset: u64(24),
    metadataLength: u64(32),
    leafDirsOffset: u64(40),
    leafDirsLength: u64(48),
    tileDataOffset: u64(56),
    tileDataLength: u64(64),
    addressedTilesCount: u64(72),
    tileEntriesCount: u64(80),
    tileContentsCount: u64(88),
    clustered: bytes[96] === 1,
    internalCompression: bytes[97],
    tileCompression: bytes[98],
    tileType: bytes[99],
    minZoom: bytes[100],
    maxZoom: bytes[101],
    bounds: [e7(102), e7(106), e7(110), e7(114)],
    centerZoom: bytes[118],
    center: [e7(119), e7(123)],
  };
}

/**
 * Map z/x/y to the archive's Hilbert-ordered tile id.
 *
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function zxyToTileId(z, x, y) {
  if (z < 0 || z > 26) throw new Error(`zoom ${z} out of range`);
  const side = 2 ** z;
  if (x < 0 || y < 0 || x >= side || y >= side) throw new Error(`tile ${z}/${x}/${y} out of range`);

  // Tiles are laid out zoom-major, so skip every tile in the zooms below: the
  // count of those is the geometric series (4^z - 1) / 3.
  let id = (4 ** z - 1) / 3;
  let rx;
  let ry;
  let tx = x;
  let ty = y;
  for (let s = side / 2; s >= 1; s /= 2) {
    rx = (tx & s) > 0 ? 1 : 0;
    ry = (ty & s) > 0 ? 1 : 0;
    id += s * s * ((3 * rx) ^ ry);
    // Rotate the quadrant so the curve stays continuous across it.
    if (ry === 0) {
      if (rx === 1) {
        tx = s - 1 - tx;
        ty = s - 1 - ty;
      }
      const swap = tx;
      tx = ty;
      ty = swap;
    }
  }
  return id;
}

/**
 * Decode a directory: entry count, then four parallel varint columns.
 *
 * @param {Uint8Array} bytes Decompressed directory.
 * @returns {{tileId:number,runLength:number,offset:number,length:number}[]}
 */
export function decodeDirectory(bytes) {
  const cursor = { pos: 0 };
  const count = readVarint(bytes, cursor);
  const entries = new Array(count);

  let tileId = 0;
  for (let i = 0; i < count; i += 1) {
    tileId += readVarint(bytes, cursor); // delta-encoded
    entries[i] = { tileId, runLength: 0, offset: 0, length: 0 };
  }
  for (let i = 0; i < count; i += 1) entries[i].runLength = readVarint(bytes, cursor);
  for (let i = 0; i < count; i += 1) entries[i].length = readVarint(bytes, cursor);
  for (let i = 0; i < count; i += 1) {
    const value = readVarint(bytes, cursor);
    // 0 is the "packed against the previous entry" shorthand; anything else is
    // the real offset biased by one so that 0 stays available as the sentinel.
    entries[i].offset = value === 0 && i > 0
      ? entries[i - 1].offset + entries[i - 1].length
      : value - 1;
  }
  return entries;
}

/**
 * Binary-search a directory for the entry covering a tile id.
 *
 * An entry with `runLength === 0` is a pointer to a leaf directory rather than
 * a tile, and `runLength > 1` means a run of identical tiles all sharing one
 * blob — which is how a tileset of mostly-empty ocean stays small.
 *
 * @param {{tileId:number,runLength:number,offset:number,length:number}[]} entries
 * @param {number} tileId
 * @returns {{entry:object,isLeaf:boolean}|null}
 */
export function findTileEntry(entries, tileId) {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = entries[mid];
    if (tileId < entry.tileId) {
      high = mid - 1;
    } else if (entry.runLength === 0) {
      // Leaf pointer: it owns everything from here to the next entry.
      const next = entries[mid + 1];
      if (!next || tileId < next.tileId) return { entry, isLeaf: true };
      low = mid + 1;
    } else if (tileId < entry.tileId + entry.runLength) {
      return { entry, isLeaf: false };
    } else {
      low = mid + 1;
    }
  }
  return null;
}

/**
 * Gunzip using the platform's own decompressor.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function inflateGzip(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('gzip decompression unavailable in this runtime');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Open a remote PMTiles archive.
 *
 * The root directory is fetched once and kept; for this archive that is a single
 * 7.3 KB read covering all 3,180 tiles, because it has no leaf directories.
 *
 * @param {{url:string, fetchImpl?:typeof fetch, decompress?:(b:Uint8Array,c:number)=>Promise<Uint8Array>}} options
 * @returns {Promise<{header:object,metadata:object,getTile:(z:number,x:number,y:number)=>Promise<Uint8Array|null>}>}
 */
export async function openPmtiles({ url, fetchImpl = (...args) => fetch(...args), decompress = null }) {
  const inflate = decompress || (async (bytes, compression) => (
    compression === PMTILES_COMPRESSION.gzip ? inflateGzip(bytes) : bytes
  ));

  async function range(offset, length) {
    if (length <= 0) return new Uint8Array(0);
    const response = await fetchImpl(url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    });
    if (!(response.status === 206 || response.status === 200)) {
      throw new Error(`range request failed: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  const header = parsePmtilesHeader(await range(0, PMTILES_HEADER_BYTES));

  const rootBytes = await inflate(
    await range(header.rootDirOffset, header.rootDirLength),
    header.internalCompression,
  );
  const rootEntries = decodeDirectory(rootBytes);

  let metadata = {};
  if (header.metadataLength > 0) {
    try {
      const metaBytes = await inflate(
        await range(header.metadataOffset, header.metadataLength),
        header.internalCompression,
      );
      metadata = JSON.parse(new TextDecoder().decode(metaBytes));
    } catch {
      metadata = {};
    }
  }

  const leafCache = new Map();

  async function getTile(z, x, y) {
    if (z < header.minZoom || z > header.maxZoom) return null;
    const tileId = zxyToTileId(z, x, y);

    let entries = rootEntries;
    // Bounded rather than `while (true)`: a malformed archive whose leaf points
    // at itself would otherwise spin forever.
    for (let depth = 0; depth < 4; depth += 1) {
      const found = findTileEntry(entries, tileId);
      if (!found) return null;
      if (!found.isLeaf) {
        const tile = await range(header.tileDataOffset + found.entry.offset, found.entry.length);
        return inflate(tile, header.tileCompression);
      }
      const key = `${found.entry.offset}:${found.entry.length}`;
      let leaf = leafCache.get(key);
      if (!leaf) {
        leaf = decodeDirectory(await inflate(
          await range(header.leafDirsOffset + found.entry.offset, found.entry.length),
          header.internalCompression,
        ));
        leafCache.set(key, leaf);
      }
      entries = leaf;
    }
    throw new Error('PMTiles leaf directory nesting is too deep');
  }

  return { header, metadata, getTile };
}
