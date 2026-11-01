import { createLogger } from "./logger";

const FILE_MAGIC = 0xed26ff3a;
export const FILE_HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;

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
    for (let i = 0; i < this.header.totalChunks; i++) {
      if (blobOffset + CHUNK_HEADER_SIZE >= this.blob.size) {
        throw "Sparse - Chunk header out of bounds";
      }
      const chunk = await this.blob.slice(blobOffset, blobOffset + CHUNK_HEADER_SIZE).arrayBuffer();
      const view = new DataView(chunk);
      const totalBytes = view.getUint32(8, true);
      if (blobOffset + totalBytes > this.blob.size) {
        throw "Sparse - Chunk data out of bounds";
      }
      yield {
        type: view.getUint16(0, true),
        blocks: view.getUint32(4, true),
        data: this.blob.slice(blobOffset + CHUNK_HEADER_SIZE, blobOffset + totalBytes),
      };
      blobOffset += totalBytes;
    }
    if (blobOffset !== this.blob.size) {
      logger.warn("Sparse - Backing data larger expected");
    }
  }

  /**
   * @param {number} [maxZeroFill=0]
   * @returns {AsyncIterator<[number, Blob | null, number]>}
   */
  async *read(maxZeroFill = 0) {
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
        } else if (size <= maxZeroFill) {
          yield [offset, new Blob([new Uint8Array(size)]), size];
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

  /**
   * Merge adjacent writes and small zero fills to avoid a command per sparse chunk.
   * DONT_CARE ranges remain untouched.
   * @param {number} [maxZeroFill=65536]
   * @returns {AsyncIterator<[number, Blob[] | null, number]>}
   */
  async *readCoalesced(maxZeroFill = 65536) {
    const maxSize = 64 * 1024 * 1024;
    /** @type {Blob[]} */
    let parts = [];
    let start = 0;
    let length = 0;
    for await (const [offset, data, size] of this.read(maxZeroFill)) {
      if (length && (!data || offset !== start + length)) {
        yield [start, parts, length];
        parts = [];
        length = 0;
      }
      if (!data) {
        yield [offset, null, size];
        continue;
      }
      for (let position = 0; position < size;) {
        if (!length) start = offset + position;
        const count = Math.min(size - position, maxSize - length);
        parts.push(data.slice(position, position + count));
        position += count;
        length += count;
        if (length === maxSize) {
          yield [start, parts, length];
          parts = [];
          length = 0;
        }
      }
    }
    if (length) yield [start, parts, length];
  }
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
