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
    const { type: chunkType, blocks, data } = chunk;
    const dataSize = data.size;
    if (chunkType === ChunkType.Raw) {
      if (dataSize !== (blocks * this.header.blockSize)) {
        throw "Sparse - Chunk input size does not match output size";
      } else {
        return dataSize;
      }
    } else if (chunkType === ChunkType.Fill) {
      if (dataSize !== 4) {
        throw "Sparse - Fill chunk should have 4 bytes";
      } else {
        return blocks * this.header.blockSize;
      }
    } else if (chunkType === ChunkType.Skip) {
      return blocks * this.header.blockSize;
    } else if (chunkType === ChunkType.Crc32) {
      if (dataSize !== 4) {
        throw "Sparse - CRC32 chunk should have 4 bytes";
      } else {
        return 0;
      }
    } else {
      throw "Sparse - Unknown chunk type";
    }
  }

  /**
   * @returns {AsyncIterator<Chunk>}
   */
  async *[Symbol.asyncIterator]() {
    let blobOffset = FILE_HEADER_SIZE;
    for (let i = 0; i < this.header.totalChunks; i++) {
      const chunk = await this.blob.slice(blobOffset, blobOffset + CHUNK_HEADER_SIZE).arrayBuffer();
      const view = new DataView(chunk);
      const totalBytes = view.getUint32(8, true);
      yield {
        type: view.getUint16(0, true),
        blocks: view.getUint32(4, true),
        data: this.blob.slice(blobOffset + CHUNK_HEADER_SIZE, blobOffset + totalBytes),
      };
      blobOffset += totalBytes;
    }
  }

  /**
   * @returns {Promise<number>}
   */
  async getSize() {
    let length = 0;
    for await (const chunk of this) {
      length += this.calcChunkRealSize(chunk);
    }
    return length;
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

/**
 * @param {Chunk[]} chunks
 * @param {number} blockSize
 * @returns {Promise<Blob>}
 */
async function populate(chunks, blockSize) {
  const blockCount = chunks.reduce((total, chunk) => total + chunk.blocks, 0);
  const ret = new Uint8Array(blockCount * blockSize);
  let offset = 0;

  for (const chunk of chunks) {
    const { type: chunkType, blocks, data } = chunk;
    const dataSize = data.size;

    if (chunkType === ChunkType.Raw) {
      const rawData = new Uint8Array(await data.arrayBuffer());
      ret.set(rawData, offset);
      offset += blocks * blockSize;
    } else if (chunkType === ChunkType.Fill) {
      const fillBin = new Uint8Array(await data.arrayBuffer());
      const bufferSize = blocks * blockSize;
      for (let i = 0; i < bufferSize; i += dataSize) {
        ret.set(fillBin, offset);
        offset += dataSize;
      }
    } else if (chunkType === ChunkType.Skip) {
      const byteToSend = blocks * blockSize;
      const skipData = new Uint8Array(byteToSend).fill(0);
      ret.set(skipData, offset);
      offset += byteToSend;
    } else if (chunkType === ChunkType.Crc32) {
      continue;
    } else {
      throw "Sparse - Unknown chunk type";
    }
  }
  return new Blob([ret]);
}


/**
 * @param {Blob} blob
 * @param {number} splitSize
 */
export async function* splitBlob(blob, splitSize = 1048576 /* maxPayloadSizeToTarget */) {
  const safeToSend = splitSize;

  const header = await parseFileHeader(blob.slice(0, FILE_HEADER_SIZE));
  if (header === null) {
    yield blob;
    return;
  }

  /** @type {Chunk[]} */
  let splitChunks = [];
  const sparse = new Sparse(blob, header);
  for await (const originalChunk of sparse) {
    /** @type {Chunk[]} */
    const chunksToProcess = [];
    let realBytesToWrite = sparse.calcChunkRealSize(originalChunk);

    const isChunkTypeSkip = originalChunk.type === ChunkType.Skip;
    const isChunkTypeFill = originalChunk.type === ChunkType.Fill;

    if (realBytesToWrite > safeToSend) {
      let bytesToWrite = isChunkTypeSkip ? 1 : originalChunk.dataBytes;

      while (bytesToWrite > 0) {
        const toSend = Math.min(safeToSend, bytesToWrite);
        if (isChunkTypeFill || isChunkTypeSkip) {
          while (realBytesToWrite > 0) {
            const realSend = Math.min(safeToSend, realBytesToWrite);
            chunksToProcess.push({
              type: originalChunk.type,
              blocks: realSend / header.blockSize,
              dataBytes: isChunkTypeSkip ? 0 : toSend,
              data: isChunkTypeSkip ? new Blob([]) : originalChunk.data.slice(0, toSend),
            });
            realBytesToWrite -= realSend;
          }
        } else {
          chunksToProcess.push({
            type: originalChunk.type,
            blocks: toSend / header.blockSize,
            dataBytes: toSend,
            data: originalChunk.data.slice(0, toSend),
          });
        }
        bytesToWrite -= toSend;
        originalChunk.data = originalChunk.data.slice(toSend);
      }
    } else {
      chunksToProcess.push(originalChunk);
    }
    for (const chunk of chunksToProcess) {
      const remainingBytes = splitSize - splitChunks.reduce((total, c) => total + sparse.calcChunkRealSize(c), 0);
      const realChunkBytes = sparse.calcChunkRealSize(chunk);
      if (remainingBytes >= realChunkBytes) {
        splitChunks.push(chunk);
      } else {
        yield await populate(splitChunks, header.blockSize);
        splitChunks = [chunk];
      }
    }
  }
  if (splitChunks.length > 0) {
    yield await populate(splitChunks, header.blockSize);
  }
}
