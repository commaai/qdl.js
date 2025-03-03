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
   * @param {Chunk} chunk
   * @returns {number}
   */
  calcChunkRealSize(chunk) {
    switch (chunk.type) {
      case ChunkType.Raw:
        if (chunk.data.size !== (chunk.blocks * this.header.blockSize)) throw "Sparse - Chunk input size does not match output size";
        return chunk.data.size;
      case ChunkType.Fill:
        if (chunk.data.size !== 4) throw "Sparse - Fill chunk should have 4 bytes";
        return chunk.blocks * this.header.blockSize;
      case ChunkType.Skip:
        return chunk.blocks * this.header.blockSize;
      case ChunkType.Crc32:
        if (chunk.data.size !== 4) throw "Sparse - CRC32 chunk should have 4 bytes";
        return 0;
      default:
        throw "Sparse - Unknown chunk type";
    }
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
   * @returns {AsyncIterator<[number, Uint8Array]>}
   */
  async *read() {
    let offset = 0;
    for await (const { type, blocks, data } of this.chunks()) {
      const size = blocks * this.header.blockSize;
      if (type === ChunkType.Raw) {
        yield [offset, new Uint8Array(await data.arrayBuffer())];
        offset += size;
      } else if (type === ChunkType.Fill) {
        const fill = new Uint8Array(await data.arrayBuffer());
        if (fill.some((byte) => byte !== 0)) {
          const buffer = new Uint8Array(size);
          for (let i = 0; i < buffer.byteLength; i += 4) buffer.set(fill, i);
          yield [offset, buffer];
        }
        offset += size;
      } else if (type === ChunkType.Skip) {
        offset += size;
      }
    }
  }

  /**
   * @returns {Promise<number>}
   */
  async getSize() {
    let length = 0;
    for await (const chunk of this.chunks()) {
      length += this.calcChunkRealSize(chunk);
    }
    return length;
  }

  /**
   * @param {Blob} blob
   * @returns {Promise<Sparse|null>}
   */
  static async from(blob) {
    const header = await parseFileHeader(blob);
    if (!header) return null;
    return new Sparse(blob, header);
  }
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
    console.error(`The file header size was expected to be 28, but is ${fileHeaderSize}.`);
    return null;
  }
  if (chunkHeaderSize !== CHUNK_HEADER_SIZE) {
    console.error(`The chunk header size was expected to be 12, but is ${chunkHeaderSize}.`);
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
