const MAGIC = 0xed26ff3a;
const HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;
const RAW = 0xcac1;
const FILL = 0xcac2;
const SKIP = 0xcac3;
const CRC32 = 0xcac4;
const TABLE_ALIGNMENT = 4096;
const MAX_EXTENTS = 4096;
const MAX_PARTS = 65536;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const UINT64_MAX = (1n << 64n) - 1n;
const plans = new WeakMap();

/**
 * @typedef {object} ProgramPart
 * @property {number} size
 * @property {(start: number, end: number) => {arrayBuffer: () => Promise<ArrayBuffer>}} slice
 */

/**
 * @typedef {object} SparseProgram
 * @property {ProgramPart[]} parts
 * @property {[bigint, bigint][]} extents
 * @property {number} numPartitionSectors
 * @property {number} dataSectors
 * @property {Uint8Array} [table]
 */

function check(condition, message) {
  if (!condition) throw new Error(`Sparse program: ${message}`);
}

function count(value, name, positive = false) {
  check(typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value)), `${name} must be an integer`);
  const result = BigInt(value);
  check(result >= (positive ? 1n : 0n) && result <= UINT64_MAX, `${name} out of range`);
  return result;
}

function checkOptions(sectorSize, maxExtents) {
  check(Number.isSafeInteger(sectorSize) && sectorSize >= 4 && sectorSize <= 0xffffffff && sectorSize % 4 === 0, "invalid sector size");
  check(Number.isInteger(maxExtents) && maxExtents > 0 && maxExtents <= MAX_EXTENTS, "invalid extent limit");
}

class FillPart {
  #pattern;
  constructor(pattern, size) {
    this.#pattern = pattern;
    this.size = size;
  }

  slice(start, end) {
    check(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= this.size, "fill slice out of bounds");
    return {
      arrayBuffer: () => {
        const data = new Uint8Array(end - start);
        const initial = Math.min(4, data.length);
        for (let i = 0; i < initial; i++) data[i] = this.#pattern[(start + i) % 4];
        for (let filled = initial; filled < data.length; filled *= 2) {
          data.copyWithin(filled, 0, Math.min(filled, data.length - filled));
        }
        return Promise.resolve(data.buffer);
      },
    };
  }
}

/**
 * Validate both generated and externally supplied plans before sending USB data.
 * @param {SparseProgram} plan
 * @param {number} sectorSize
 * @param {number | bigint} [partitionSectors]
 * @param {number} [maxExtents=4096]
 * @returns {Uint8Array}
 */
export function validateSparseProgram(plan, sectorSize, partitionSectors = plan.numPartitionSectors, maxExtents = MAX_EXTENTS) {
  checkOptions(sectorSize, maxExtents);
  const logical = count(plan.numPartitionSectors, "logical sectors", true);
  const data = count(plan.dataSectors, "data sectors", true);
  check(logical <= count(partitionSectors, "partition sectors", true), "image exceeds partition");
  check(logical * BigInt(sectorSize) <= MAX_SAFE && data * BigInt(sectorSize) <= MAX_SAFE, "byte count exceeds safe integer range");
  check(Array.isArray(plan.extents) && plan.extents.length > 0 && plan.extents.length <= maxExtents, "invalid extent count");
  check(Array.isArray(plan.parts) && plan.parts.length > 0 && plan.parts.length <= MAX_PARTS, "invalid payload part count");

  let end = 0n;
  let sectors = 0n;
  const tableBytes = Math.ceil(plan.extents.length * 16 / TABLE_ALIGNMENT) * TABLE_ALIGNMENT;
  const table = new Uint8Array(tableBytes);
  const view = new DataView(table.buffer);
  for (let i = 0; i < plan.extents.length; i++) {
    const extent = plan.extents[i];
    check(Array.isArray(extent) && extent.length === 2, "invalid extent");
    const start = count(extent[0], "extent start");
    const length = count(extent[1], "extent length", true);
    check(start >= end && start + length <= logical, "overlapping, unordered, or out-of-bounds extent");
    end = start + length;
    sectors += length;
    view.setBigUint64(i * 16, start, true);
    view.setBigUint64(i * 16 + 8, length, true);
  }
  check(sectors === data, "extent sum differs from data sectors");
  let bytes = 0n;
  for (const part of plan.parts) {
    check(part && Number.isSafeInteger(part.size) && part.size > 0 && typeof part.slice === "function", "invalid payload part");
    check(part.size % sectorSize === 0, "unaligned payload part");
    bytes += BigInt(part.size);
  }
  check(bytes === data * BigInt(sectorSize), "payload size differs from extent sum");
  if (plan.table !== undefined) {
    check(plan.table instanceof Uint8Array && plan.table.length === table.length, "invalid table size");
    check(plan.table.every((byte, index) => byte === table[index]), "table differs from extents or has nonzero padding");
  }
  return table;
}

async function parsePlan(blob, sectorSize) {
  check(Number.isSafeInteger(blob.size) && blob.size >= 0, "invalid image size");
  if (blob.size < 4) return null;
  const headerBytes = await blob.slice(0, HEADER_SIZE).arrayBuffer();
  const header = new DataView(headerBytes);
  if (header.getUint32(0, true) !== MAGIC) return null;
  check(headerBytes.byteLength === HEADER_SIZE, "truncated file header");
  check(header.getUint16(4, true) === 1 && header.getUint16(6, true) === 0, "unsupported sparse version");
  check(header.getUint16(8, true) === HEADER_SIZE && header.getUint16(10, true) === CHUNK_HEADER_SIZE, "unsupported header sizes");
  const blockSize = header.getUint32(12, true);
  const blocks = header.getUint32(16, true);
  const chunks = header.getUint32(20, true);
  check(blockSize > 0 && blockSize % 4 === 0, "invalid sparse block size");
  const logicalBytes = BigInt(blockSize) * BigInt(blocks);
  check(logicalBytes > 0n && logicalBytes <= MAX_SAFE && logicalBytes % BigInt(sectorSize) === 0n, "invalid expanded image size");
  check(chunks <= Math.floor((blob.size - HEADER_SIZE) / CHUNK_HEADER_SIZE), "chunk count exceeds image size");

  /** @type {ProgramPart[]} */
  let parts = [];
  /** @type {[bigint, bigint][]} */
  let extents = [];
  let supported = true;
  let position = HEADER_SIZE;
  let offset = 0;
  let dataBytes = 0;
  let windowOffset = 0;
  let window = new Uint8Array();
  for (let i = 0; i < chunks; i++) {
    check(position + CHUNK_HEADER_SIZE <= blob.size, "truncated chunk header");
    if (position + CHUNK_HEADER_SIZE > windowOffset + window.length) {
      windowOffset = position;
      window = new Uint8Array(await blob.slice(position, position + 4096).arrayBuffer());
    }
    const chunk = new DataView(window.buffer, position - windowOffset, CHUNK_HEADER_SIZE);
    const type = chunk.getUint16(0, true);
    const chunkBlocks = chunk.getUint32(4, true);
    const total = chunk.getUint32(8, true);
    check(total >= CHUNK_HEADER_SIZE && position + total <= blob.size, "invalid chunk byte count");
    const sizeBig = BigInt(chunkBlocks) * BigInt(blockSize);
    check(sizeBig <= MAX_SAFE && sizeBig % BigInt(sectorSize) === 0n, "unaligned or oversized chunk");
    const size = Number(sizeBig);
    check(BigInt(offset) + sizeBig <= logicalBytes, "chunk exceeds expanded image");
    const bodySize = total - CHUNK_HEADER_SIZE;
    const bodyOffset = position + CHUNK_HEADER_SIZE;
    let part = null;
    if (type === RAW) {
      check(size > 0 && bodySize === size, "RAW length differs from block count");
      if (supported) part = blob.slice(bodyOffset, position + total);
    } else if (type === FILL) {
      check(size > 0 && bodySize === 4, "invalid FILL chunk");
      const pattern = position + total <= windowOffset + window.length
        ? window.slice(bodyOffset - windowOffset, position + total - windowOffset)
        : new Uint8Array(await blob.slice(bodyOffset, position + total).arrayBuffer());
      if (pattern.some((byte) => byte !== 0) && supported) part = new FillPart(pattern, size);
    } else if (type === SKIP) {
      check(size > 0 && bodySize === 0, "invalid DONT_CARE chunk");
    } else if (type === CRC32) {
      check(chunkBlocks === 0 && bodySize === 4, "invalid CRC32 chunk");
    } else {
      throw new Error(`Sparse program: unknown chunk type ${type}`);
    }
    if (part) {
      const start = BigInt(offset / sectorSize);
      const length = BigInt(size / sectorSize);
      const previous = extents.at(-1);
      if (previous && previous[0] + previous[1] === start) previous[1] += length;
      else extents.push([start, length]);
      parts.push(part);
      dataBytes += size;
      if (extents.length > MAX_EXTENTS || parts.length > MAX_PARTS) {
        supported = false;
        extents = [];
        parts = [];
      }
    }
    offset += size;
    position += total;
  }
  check(BigInt(offset) === logicalBytes, "chunk blocks differ from expanded image size");
  check(position === blob.size, "trailing bytes after final chunk");
  const numPartitionSectors = Number(logicalBytes / BigInt(sectorSize));
  if (!supported || extents.length === 0) return { numPartitionSectors, plan: null };
  const plan = { parts, extents, numPartitionSectors, dataSectors: dataBytes / sectorSize };
  return { numPartitionSectors, plan: { ...plan, table: validateSparseProgram(plan, sectorSize) } };
}

/**
 * Compile a sparse image once per Blob identity. Cached data consists only of
 * ranges, file-backed slices, and four-byte fill patterns. The destination must
 * be erased first, as zero FILL ranges are omitted just like Sparse.read().
 * DONT_CARE ranges are never included in the payload.
 * @param {Blob} blob
 * @param {number} sectorSize
 * @param {number | bigint} partitionSectors
 * @param {number} [maxExtents=4096]
 * @returns {Promise<SparseProgram | null>}
 */
export async function prepareSparseProgram(blob, sectorSize, partitionSectors, maxExtents = MAX_EXTENTS) {
  checkOptions(sectorSize, maxExtents);
  const partition = count(partitionSectors, "partition sectors", true);
  let cached = plans.get(blob);
  if (!cached || cached.sectorSize !== sectorSize) {
    cached = { sectorSize, plan: parsePlan(blob, sectorSize) };
    plans.set(blob, cached);
  }
  const compiled = await cached.plan;
  if (!compiled) return null;
  check(BigInt(compiled.numPartitionSectors) <= partition, "image exceeds partition");
  const plan = compiled.plan;
  if (!plan || plan.extents.length > maxExtents) return null;
  validateSparseProgram(plan, sectorSize, partition, maxExtents);
  return plan;
}
