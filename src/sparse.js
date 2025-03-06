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
      console.warn("Sparse - Backing data larger expected");
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
 * @param {Blob} blob
 * @returns {Promise<Sparse|null>}
 */
export async function from(blob) {
  const header = parseFileHeader(await blob.slice(0, FILE_HEADER_SIZE).arrayBuffer());
  if (!header) return null;
  return new Sparse(blob, header);
}


/**
 * @param {Uint8Array} buffer
 * @returns {Header|null}
 */
export function parseFileHeader(buffer) {
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== FILE_MAGIC) {
    // Not a sparse file.
    return null;
  }
  const fileHeaderSize = view.getUint16(8, true);
  const chunkHeaderSize = view.getUint16(10, true);
  if (fileHeaderSize !== FILE_HEADER_SIZE) {
    throw `Sparse - The file header size was expected to be 28, but is ${fileHeaderSize}.`;
  }
  if (chunkHeaderSize !== CHUNK_HEADER_SIZE) {
    throw `Sparse - The chunk header size was expected to be 12, but is ${chunkHeaderSize}.`;
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
