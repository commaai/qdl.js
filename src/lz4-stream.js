import { validateSparseProgramMetadata } from "./sparse-program.js";

const SECTOR_SIZE = 4096;
const HEADER_SIZE = 16;
const MAX_DECODED_BYTES = 1024 * 1024;
const MAX_WIRE_BYTES = MAX_DECODED_BYTES + SECTOR_SIZE;
const MAX_INPUT_CHUNK = 4 * 1024 * 1024;

function check(condition, message) {
  if (!condition) throw new Error(`LZ4 stream: ${message}`);
}

function validWireSize(bytes) {
  return Number.isSafeInteger(bytes) && bytes >= SECTOR_SIZE && bytes <= MAX_WIRE_BYTES && bytes % SECTOR_SIZE === 0;
}

/**
 * @typedef {object} Lz4Metadata
 * @property {number} sectorSize
 * @property {number} numPartitionSectors
 * @property {number} dataSectors
 * @property {[bigint, bigint][]} extents
 * @property {number} compressedBytes
 * @property {number} firstFrameBytes
 * @property {Uint8Array} [table]
 */

/**
 * Validate and copy the native destination index before opening its source.
 * @param {Lz4Metadata} metadata
 * @param {number | bigint} [partitionSectors]
 * @param {number} [maxExtents=4096]
 * @returns {Lz4Metadata & {table: Uint8Array}}
 */
export function validateLz4Metadata(metadata, partitionSectors = metadata.numPartitionSectors, maxExtents = 4096) {
  check(metadata.sectorSize === SECTOR_SIZE, "sector size must be 4096");
  const table = validateSparseProgramMetadata(metadata, SECTOR_SIZE, partitionSectors, maxExtents);
  check(Number.isSafeInteger(metadata.compressedBytes) && metadata.compressedBytes > 0
    && metadata.compressedBytes % SECTOR_SIZE === 0, "invalid compressed byte count");
  check(BigInt(metadata.compressedBytes) <= 2n * BigInt(metadata.dataSectors) * BigInt(SECTOR_SIZE), "compressed byte count exceeds payload bound");
  check(validWireSize(metadata.firstFrameBytes) && metadata.firstFrameBytes <= metadata.compressedBytes, "invalid first frame size");
  return {
    sectorSize: SECTOR_SIZE,
    numPartitionSectors: Number(metadata.numPartitionSectors),
    dataSectors: Number(metadata.dataSectors),
    extents: metadata.extents.map(([start, count]) => [BigInt(start), BigInt(count)]),
    compressedBytes: metadata.compressedBytes,
    firstFrameBytes: metadata.firstFrameBytes,
    table,
  };
}

/**
 * Validate chained native LZ4 frames from an authenticated source stream.
 * The complete final frame is held until the exact source length and EOF pass.
 * @param {ReadableStream<Uint8Array>} source
 * @param {Lz4Metadata} metadata
 * @param {(progress: {wireBytes: number, dataBytes: number}) => void} [onFrame]
 * @returns {ReadableStream<Uint8Array>}
 */
export function validateLz4Stream(source, metadata, onFrame = undefined) {
  const plan = validateLz4Metadata(metadata);
  check(onFrame === undefined || typeof onFrame === "function", "invalid frame callback");
  const reader = source.getReader();
  let cancelled = false;
  let cleanupPromise;
  const cleanup = (cancel, reason = undefined) => {
    cleanupPromise ??= (async () => {
      let cancellation;
      try {
        if (cancel) cancellation = reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
      await cancellation;
    })();
    return cleanupPromise;
  };
  let input = new Uint8Array();
  let inputSize = 0;
  let inputOffset = 0;
  let received = 0;
  const readFrame = async (size) => {
    const frame = new Uint8Array(size);
    for (let offset = 0; offset < size;) {
      check(input.length === inputSize, "source buffer was detached during streaming");
      if (inputOffset === inputSize) {
        const next = await reader.read();
        check(!next.done, "truncated frame");
        check(next.value instanceof Uint8Array && next.value.length <= MAX_INPUT_CHUNK, "invalid or oversized source chunk");
        check(next.value.length <= plan.compressedBytes - received, "source exceeds compressed byte count");
        input = next.value;
        inputSize = input.length;
        inputOffset = 0;
        received += inputSize;
        if (!inputSize) continue;
      }
      const count = Math.min(size - offset, inputSize - inputOffset);
      frame.set(input.subarray(inputOffset, inputOffset + count), offset);
      inputOffset += count;
      offset += count;
    }
    return frame;
  };

  async function* frames() {
    let completed = false;
    let failed = false;
    try {
      let frameBytes = plan.firstFrameBytes;
      let wireBytes = 0;
      let dataBytes = 0;
      let extentIndex = 0;
      let extentRemaining = plan.extents[0][1];
      for (;;) {
        check(frameBytes <= plan.compressedBytes - wireBytes, "frame exceeds compressed byte count");
        const frame = await readFrame(frameBytes);
        const header = new DataView(frame.buffer);
        const nextFrameBytes = header.getUint32(0, true);
        const encodedBytes = header.getUint32(4, true);
        const decodedBytes = header.getUint32(8, true);
        const flags = header.getUint32(12, true);
        check(decodedBytes > 0 && decodedBytes <= MAX_DECODED_BYTES && decodedBytes % SECTOR_SIZE === 0, "invalid decoded frame size");
        check(encodedBytes > 0 && encodedBytes <= decodedBytes, "invalid encoded frame size");
        check(flags === 0 || flags === 1, "invalid frame flags");
        check(flags !== 1 || encodedBytes === decodedBytes, "RAW frame sizes differ");
        check(Math.ceil((HEADER_SIZE + encodedBytes) / SECTOR_SIZE) * SECTOR_SIZE === frameBytes, "wire size differs from encoded frame size");
        const sectors = BigInt(decodedBytes / SECTOR_SIZE);
        check(sectors <= extentRemaining, "frame crosses an extent boundary");
        extentRemaining -= sectors;
        if (extentRemaining === 0n) {
          extentIndex++;
          extentRemaining = plan.extents[extentIndex]?.[1] ?? 0n;
        }
        wireBytes += frameBytes;
        dataBytes += decodedBytes;
        const final = wireBytes === plan.compressedBytes;
        check(final ? nextFrameBytes === 0 : validWireSize(nextFrameBytes), "invalid next frame size");
        check(nextFrameBytes <= plan.compressedBytes - wireBytes, "next frame exceeds compressed byte count");
        check(final === (extentIndex === plan.extents.length), "frame chain differs from decoded extent total");
        if (final) {
          check(dataBytes === plan.dataSectors * SECTOR_SIZE, "decoded byte total differs from metadata");
          check(inputOffset === inputSize, "trailing frame bytes");
          let last;
          do {
            last = await reader.read();
            check(last.done || (last.value instanceof Uint8Array && last.value.length === 0), "source exceeds compressed byte count");
          } while (!last.done);
          completed = true;
          await cleanup(false);
        }
        onFrame?.({ wireBytes, dataBytes });
        yield frame;
        if (final) return;
        frameBytes = nextFrameBytes;
      }
    } catch (error) {
      failed = true;
      cleanup(true, error).catch(() => undefined);
      throw error;
    } finally {
      if (!failed) await cleanup(!completed);
    }
  }

  const iterator = frames();
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
      try { await cleanup(true, reason); } finally { await iterator.return(); }
    },
  }, { highWaterMark: 0 });
}
