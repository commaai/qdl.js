import { createLogger } from "./logger";

const FILE_MAGIC = 0xed26ff3a;
export const FILE_HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;
const HEADER_WINDOW_SIZE = 64 * 1024;

const ChunkType = {
  Raw: 0xCAC1,
  Fill: 0xCAC2,
  Skip: 0xCAC3,
  Crc32: 0xCAC4,
};


/**
 * @typedef {object} Header
 * @property {number} magic
 * @property {number} majorVersion
 * @property {number} minorVersion
 * @property {number} fileHeaderSize
 * @property {number} chunkHeaderSize
 * @property {number} blockSize
 * @property {number} totalBlocks
 * @property {number} totalChunks
 * @property {number} crc32
 */


/**
 * @typedef {object} Chunk
 * @property {number} type
 * @property {number} blocks
 * @property {Blob} data
 * @property {number} dataOffset - where data starts in the sparse file
 */

const logger = createLogger("sparse");


export class Sparse {
  /**
   * @param {Blob} blob
   * @param {Header} header
   */
  constructor(blob, header) {
    this.blob = blob;
    this.header = header;
  }

  /**
   * @returns {AsyncIterator<Chunk>}
   */
  async* chunks() {
    let blobOffset = FILE_HEADER_SIZE;
    // read headers through a window, consecutive small chunks then cost one read
    let window = new Uint8Array(0), windowStart = 0;
    for (let i = 0; i < this.header.totalChunks; i++) {
      if (blobOffset + CHUNK_HEADER_SIZE >= this.blob.size) {
        throw "Sparse - Chunk header out of bounds";
      }
      if (blobOffset < windowStart || blobOffset + CHUNK_HEADER_SIZE > windowStart + window.byteLength) {
        windowStart = blobOffset;
        window = new Uint8Array(await this.blob.slice(blobOffset, blobOffset + HEADER_WINDOW_SIZE).arrayBuffer());
      }
      const view = new DataView(window.buffer, blobOffset - windowStart, CHUNK_HEADER_SIZE);
      const totalBytes = view.getUint32(8, true);
      if (blobOffset + totalBytes > this.blob.size) {
        throw "Sparse - Chunk data out of bounds";
      }
      yield {
        type: view.getUint16(0, true),
        blocks: view.getUint32(4, true),
        data: this.blob.slice(blobOffset + CHUNK_HEADER_SIZE, blobOffset + totalBytes),
        dataOffset: blobOffset + CHUNK_HEADER_SIZE,
      };
      blobOffset += totalBytes;
    }
    if (blobOffset !== this.blob.size) {
      logger.warn("Sparse - Backing data larger expected");
    }
  }

  /**
   * @returns {AsyncIterator<[number, Blob | null, number]>}
   */
  async *read() {
    let offset = 0;
    for await (const { type, blocks, data } of this.chunks()) {
      const size = blocks * this.header.blockSize;
      if (type === ChunkType.Raw) {
        yield [offset, data, size];
        offset += size;
      } else if (type === ChunkType.Fill) {
        const fill = new Uint8Array(await data.arrayBuffer());
        if (fill.some((byte) => byte !== 0)) {
          const buffer = new Uint8Array(size);
          for (let i = 0; i < buffer.byteLength; i += 4) buffer.set(fill, i);
          yield [offset, new Blob([buffer]), size];
        } else {
          yield [offset, null, size];
        }
        offset += size;
      } else if (type === ChunkType.Skip) {
        yield [offset, null, size];
        offset += size;
      }
    }
  }
}


/**
 * @typedef {object} RunPart
 * @property {number} size
 * @property {number} [fileOffset] - raw data stored in the sparse file
 * @property {Uint8Array} [fill] - 4 byte pattern; zeros if neither is set
 */

/**
 * Contiguous run of an image, read lazily from its parts.
 */
export class Run {
  /**
   * @param {Blob} file
   * @param {RunPart[]} parts
   */
  constructor(file, parts) {
    this.file = file;
    this.parts = parts;
    this.size = parts.reduce((total, part) => total + part.size, 0);
  }

  /**
   * @param {number} start
   * @param {number} end
   */
  slice(start, end) {
    return {
      arrayBuffer: async () => {
        /** @type {[RunPart, number, number][]} */
        const pieces = [];
        let partStart = 0;
        for (const part of this.parts) {
          const lo = Math.max(start, partStart), hi = Math.min(end, partStart + part.size);
          if (lo < hi) pieces.push([part, lo - partStart, hi - partStart]);
          partStart += part.size;
          if (partStart >= end) break;
        }
        // raw chunks sit next to each other in the file, so read their span at once
        const raw = pieces.filter(([part]) => part.fileOffset !== undefined);
        if (raw.length === 1 && pieces.length === 1) {
          const [part, lo, hi] = raw[0];
          const fileOffset = /** @type {number} */ (part.fileOffset);
          return await this.file.slice(fileOffset + lo, fileOffset + hi).arrayBuffer();
        }
        let span = null, spanStart = 0;
        if (raw.length) {
          spanStart = /** @type {number} */ (raw[0][0].fileOffset) + raw[0][1];
          const last = raw[raw.length - 1];
          const spanEnd = /** @type {number} */ (last[0].fileOffset) + last[2];
          span = new Uint8Array(await this.file.slice(spanStart, spanEnd).arrayBuffer());
        }
        const out = new Uint8Array(end - start);
        let pos = 0;
        for (const [part, lo, hi] of pieces) {
          if (part.fileOffset !== undefined && span) {
            const from = part.fileOffset + lo - spanStart;
            out.set(span.subarray(from, from + hi - lo), pos);
          } else if (part.fill) {
            const tile = new Uint8Array(4096 + 4);
            for (let i = 0; i < tile.length; i++) tile[i] = part.fill[i % 4];
            for (let k = lo; k < hi; k += 4096) {
              const n = Math.min(4096, hi - k);
              out.set(tile.subarray(k % 4, k % 4 + n), pos + k - lo);
            }
          }
          pos += hi - lo;
        }
        return out.buffer;
      },
    };
  }
}


/**
 * Merge the data chunks into runs, writing holes of up to maxGap bytes as zeros,
 * so the image goes out as a few large programs instead of one per chunk.
 * @param {Sparse} sparse
 * @param {number} maxGap
 * @returns {AsyncGenerator<[number, Run]>}
 */
export async function* runs(sparse, maxGap) {
  /** @type {RunPart[]} */
  let parts = [];
  let start = 0, end = 0, offset = 0;
  for await (const { type, blocks, data, dataOffset } of sparse.chunks()) {
    const size = blocks * sparse.header.blockSize;
    /** @type {RunPart | null} */
    let part = null;
    if (type === ChunkType.Raw) {
      part = { size, fileOffset: dataOffset };
    } else if (type === ChunkType.Fill) {
      const fill = new Uint8Array(await data.arrayBuffer());
      if (fill.some((byte) => byte !== 0)) part = { size, fill };
    }
    if (part) {
      if (parts.length && offset - end > maxGap) {
        yield [start, new Run(sparse.blob, parts)];
        parts = [];
      }
      if (!parts.length) start = offset;
      else if (offset > end) parts.push({ size: offset - end });
      parts.push(part);
      end = offset + size;
    }
    if (type === ChunkType.Raw || type === ChunkType.Fill || type === ChunkType.Skip) offset += size;
  }
  if (parts.length) yield [start, new Run(sparse.blob, parts)];
}


/**
 * @param {Blob} blob
 * @returns {Promise<Sparse|null>}
 */
export async function from(blob) {
  const header = await parseFileHeader(blob);
  if (!header) return null;
  return new Sparse(blob, header);
}


/**
 * @param {Blob} blob
 * @returns {Promise<Header|null>}
 */
export async function parseFileHeader(blob) {
  const view = new DataView(await blob.slice(0, FILE_HEADER_SIZE).arrayBuffer());
  const magic = view.getUint32(0, true);
  if (magic !== FILE_MAGIC) {
    return null;
  }
  const fileHeaderSize = view.getUint16(8, true);
  const chunkHeaderSize = view.getUint16(10, true);
  if (fileHeaderSize !== FILE_HEADER_SIZE) {
    logger.error(`The file header size was expected to be 28, but is ${fileHeaderSize}`);
    return null;
  }
  if (chunkHeaderSize !== CHUNK_HEADER_SIZE) {
    logger.error(`The chunk header size was expected to be 12, but is ${chunkHeaderSize}`);
    return null;
  }
  return {
    magic,
    majorVersion: view.getUint16(4, true),
    minorVersion: view.getUint16(6, true),
    fileHeaderSize,
    chunkHeaderSize,
    blockSize: view.getUint32(12, true),
    totalBlocks: view.getUint32(16, true),
    totalChunks: view.getUint32(20, true),
    crc32: view.getUint32(24, true),
  };
}
