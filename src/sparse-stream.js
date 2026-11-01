import { validateSparseProgramMetadata } from "./sparse-program";

const MAX_INPUT_CHUNK = 4 * 1024 * 1024;
const MAX_RANGES = 65536;

function check(condition, message) {
  if (!condition) throw new Error(`Sparse stream: ${message}`);
}

/**
 * @typedef {object} SparseStreamMetadata
 * @property {number} sectorSize
 * @property {number} numPartitionSectors
 * @property {number} dataSectors
 * @property {[bigint, bigint][]} extents
 * @property {number[][]} sourceRanges Source offset/length pairs; a third field repeats a four-byte FILL pattern.
 */

/**
 * Validate and copy an index before opening its source or sending a command.
 * @param {SparseStreamMetadata} metadata
 * @param {number} fileSize
 * @returns {SparseStreamMetadata}
 */
export function validateSparseStreamMetadata(metadata, fileSize) {
  validateSparseProgramMetadata(metadata, metadata.sectorSize);
  check(Number.isSafeInteger(fileSize) && fileSize >= 40, "invalid file size");
  check(Array.isArray(metadata.sourceRanges) && metadata.sourceRanges.length > 0 && metadata.sourceRanges.length <= MAX_RANGES, "invalid source range count");
  let end = 28;
  let bytes = 0n;
  const sourceRanges = metadata.sourceRanges.map((range) => {
    check(Array.isArray(range) && (range.length === 2 || range.length === 3), "invalid source range");
    const [offset, size, repeat = 1] = range;
    check(Number.isSafeInteger(offset) && Number.isSafeInteger(size) && Number.isSafeInteger(repeat)
      && offset >= 40 && size > 0 && repeat > 0 && offset >= end && size <= fileSize - offset, "source range out of bounds or unordered");
    check(range.length === 2 || size === 4, "only four-byte FILL patterns can repeat");
    const length = BigInt(size) * BigInt(repeat);
    check(length % BigInt(metadata.sectorSize) === 0n, "unaligned source payload");
    bytes += length;
    end = offset + size;
    return [...range];
  });
  check(bytes === BigInt(metadata.dataSectors) * BigInt(metadata.sectorSize), "source payload differs from data sectors");
  return {
    sectorSize: metadata.sectorSize,
    numPartitionSectors: Number(metadata.numPartitionSectors),
    dataSectors: Number(metadata.dataSectors),
    extents: metadata.extents.map(([start, count]) => [BigInt(start), BigInt(count)]),
    sourceRanges,
  };
}

/**
 * Select the native sparse payload from one verified, bounded source stream.
 * Headers and zero-fill patterns must agree with the index before data is emitted.
 * The last sector is held until the exact source length and EOF are validated.
 * @param {ReadableStream<Uint8Array>} source
 * @param {SparseStreamMetadata} metadata
 * @param {number} fileSize
 * @returns {ReadableStream<Uint8Array>}
 */
export function selectSparseRanges(source, metadata, fileSize) {
  const plan = validateSparseStreamMetadata(metadata, fileSize);
  const reader = source.getReader();
  let cancelled = false;
  let buffer = new Uint8Array();
  let bufferOffset = 0;
  let received = 0;
  let position = 0;
  const take = async (length) => {
    check(bufferOffset <= buffer.length, "source buffer was detached during streaming");
    while (bufferOffset === buffer.length) {
      const next = await reader.read();
      check(!next.done, "truncated source");
      check(next.value instanceof Uint8Array && next.value.length <= MAX_INPUT_CHUNK, "invalid or oversized source chunk");
      buffer = next.value;
      bufferOffset = 0;
      received += buffer.length;
      check(received <= fileSize, "source exceeds file size");
    }
    const count = Math.min(length, buffer.length - bufferOffset);
    check(count > 0, "source made no progress");
    const result = buffer.subarray(bufferOffset, bufferOffset + count);
    bufferOffset += count;
    position += count;
    return result;
  };
  const exact = async (length) => {
    const first = await take(length);
    if (first.length === length) return first;
    const data = new Uint8Array(length);
    data.set(first);
    for (let offset = first.length; offset < length;) {
      const part = await take(length - offset);
      data.set(part, offset);
      offset += part.length;
    }
    return data;
  };
  const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  async function* payload() {
    let completed = false;
    try {
      const header = view(await exact(28));
      check(header.getUint32(0, true) === 0xed26ff3a && header.getUint16(4, true) === 1 && header.getUint16(6, true) === 0, "invalid sparse header");
      check(header.getUint16(8, true) === 28 && header.getUint16(10, true) === 12, "unsupported header sizes");
      const blockSize = header.getUint32(12, true);
      const blocks = header.getUint32(16, true);
      const chunks = header.getUint32(20, true);
      check(blockSize > 0 && blockSize % 4 === 0, "invalid block size");
      check(BigInt(blockSize) * BigInt(blocks) === BigInt(plan.numPartitionSectors) * BigInt(plan.sectorSize), "expanded size differs from index");
      check(chunks <= Math.floor((fileSize - 28) / 12), "chunk count exceeds file size");
      let logical = 0;
      let rangeIndex = 0;
      let extentIndex = 0;
      let extentOffset = plan.extents[0][0];
      let emitted = 0;
      let tail;
      const totalPayload = plan.dataSectors * plan.sectorSize;
      const matchExtent = (size) => {
        check(size > 0 && size % plan.sectorSize === 0 && logical % plan.sectorSize === 0, "unaligned sparse chunk");
        let start = BigInt(logical / plan.sectorSize);
        let remaining = BigInt(size / plan.sectorSize);
        while (remaining) {
          const extent = plan.extents[extentIndex];
          check(extent && start === extentOffset, "target extent differs from sparse chunk");
          const available = extent[0] + extent[1] - extentOffset;
          const count = remaining < available ? remaining : available;
          extentOffset += count;
          start += count;
          remaining -= count;
          if (extentOffset === extent[0] + extent[1]) {
            extentIndex++;
            extentOffset = plan.extents[extentIndex]?.[0];
          }
        }
      };
      const matchSource = (offset, size, repeat = 1) => {
        const expected = plan.sourceRanges[rangeIndex++];
        check(expected && expected[0] === offset && expected[1] === size && (expected[2] ?? 1) === repeat, "source range differs from sparse chunk");
      };
      const finishPiece = (data) => {
        emitted += data.length;
        check(emitted <= totalPayload, "too much payload");
        if (emitted !== totalPayload) return data;
        const held = Math.min(plan.sectorSize, data.length);
        tail = data.slice(data.length - held);
        return data.subarray(0, data.length - held);
      };
      for (let i = 0; i < chunks; i++) {
        const chunk = view(await exact(12));
        const type = chunk.getUint16(0, true);
        const chunkBlocks = chunk.getUint32(4, true);
        const total = chunk.getUint32(8, true);
        const sizeBig = BigInt(chunkBlocks) * BigInt(blockSize);
        check(sizeBig <= BigInt(Number.MAX_SAFE_INTEGER) && sizeBig % BigInt(plan.sectorSize) === 0n, "invalid sparse chunk size");
        const size = Number(sizeBig);
        check(total >= 12 && total - 12 <= fileSize - position, "invalid encoded chunk size");
        check(logical + size <= plan.numPartitionSectors * plan.sectorSize, "chunk exceeds expanded image");
        if (type === 0xcac1) {
          check(total - 12 === size, "RAW size differs from block count");
          matchExtent(size);
          matchSource(position, size);
          for (let remaining = size; remaining > 0;) {
            const part = await take(remaining);
            remaining -= part.length;
            const output = finishPiece(part);
            if (output.length) yield output;
          }
        } else if (type === 0xcac2) {
          check(size > 0 && total === 16, "invalid FILL chunk");
          const sourceOffset = position;
          const pattern = await exact(4);
          if (pattern.some((byte) => byte !== 0)) {
            matchExtent(size);
            matchSource(sourceOffset, 4, size / 4);
            for (let remaining = size; remaining > 0;) {
              const count = Math.min(remaining, 65536);
              const filled = new Uint8Array(count);
              filled.set(pattern);
              for (let written = 4; written < count; written *= 2) filled.copyWithin(written, 0, Math.min(written, count - written));
              remaining -= count;
              const output = finishPiece(filled);
              if (output.length) yield output;
            }
          }
        } else if (type === 0xcac3) {
          check(size > 0 && total === 12, "invalid DONT_CARE chunk");
        } else if (type === 0xcac4) {
          check(chunkBlocks === 0 && total === 16, "invalid CRC32 chunk");
          await exact(4);
        } else {
          throw new Error(`Sparse stream: unsupported chunk type ${type}`);
        }
        logical += size;
      }
      check(logical === plan.numPartitionSectors * plan.sectorSize, "sparse block total differs from index");
      check(rangeIndex === plan.sourceRanges.length && extentIndex === plan.extents.length && emitted === totalPayload, "unused index entries or missing payload");
      check(position === fileSize, "trailing bytes after sparse image");
      let last;
      do {
        last = await reader.read();
        check(last.done || (last.value instanceof Uint8Array && last.value.length === 0), "source exceeds file size");
      } while (!last.done);
      completed = true;
      if (tail?.length) yield tail;
    } finally {
      try {
        if (!completed) await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }

  const iterator = payload();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        try { await iterator.return(); } finally { reader.releaseLock(); }
      }
    },
  });
}
