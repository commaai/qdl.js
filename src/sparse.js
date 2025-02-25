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
 * @typedef {object} ChunkHeader
 * @property {number} type
 * @property {number} blocks
 * @property {number} dataBytes
 */


/**
 * @typedef {object} Chunk
 * @extends {ChunkHeader}
 * @property {number} type
 * @property {number} blocks
 * @property {number} dataBytes
 * @property {Blob|null} data
 */


class Sparse {
  /**
   * @param {Blob} blob
   * @param {Header} header
   */
  constructor(blob, header) {
    this.blob = blob;
    this.blockSize = header.blockSize;
    this.totalChunks = header.totalChunks;
    this.blobOffset = 0;
  }

  /**
   * @returns {Promise<number>}
   */
  async getChunkSize() {
    const chunkHeader = await parseChunkHeader(this.blob.slice(this.blobOffset, this.blobOffset + CHUNK_HEADER_SIZE));
    const chunkType = chunkHeader.type;
    const blocks = chunkHeader.blocks;
    const dataSize = chunkHeader.dataBytes;
    this.blobOffset += CHUNK_HEADER_SIZE + dataSize;

    if (chunkType === ChunkType.Raw) {
      if (dataSize !== (blocks * this.blockSize)) {
        throw "Sparse - Chunk input size does not match output size";
      } else {
        return dataSize;
      }
    } else if (chunkType === ChunkType.Fill) {
      if (dataSize !== 4) {
        throw "Sparse - Fill chunk should have 4 bytes";
      } else {
        return blocks * this.blockSize;
      }
    } else if (chunkType === ChunkType.Skip) {
      return blocks * this.blockSize;
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
   * @returns {Promise<number>}
   */
  async getSize() {
    this.blobOffset = FILE_HEADER_SIZE;
    let length = 0, chunk = 0;
    while (chunk < this.totalChunks) {
      length += await this.getChunkSize();
      chunk += 1;
    }
    this.blobOffset = FILE_HEADER_SIZE;
    return length;
  }
}


/**
 * @param {Blob} blob
 * @param {Header} header
 * @returns {Promise<number>}
 */
export async function getSparseRealSize(blob, header) {
  const sparseImage = new Sparse(blob, header);
  return await sparseImage.getSize();
}


/**
 * @param {Blob} blob
 * @returns {Promise<ChunkHeader>}
 */
async function parseChunkHeader(blob) {
  if (blob.size !== CHUNK_HEADER_SIZE) {
    console.trace("Sparse - Incorrectly sized blob passed to parseChunkHeader", blob);
    throw "Sparse - Incorrectly sized blob passed to parseChunkHeader";
  }
  const view = new DataView(await blob.arrayBuffer());
  return {
    type: view.getUint16(0, true),
    blocks: view.getUint32(4, true),
    dataBytes: view.getUint32(8, true) - CHUNK_HEADER_SIZE,
  };
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
    const chunkType = chunk.type;
    const blocks = chunk.blocks;
    const dataSize = chunk.dataBytes;
    const data = chunk.data;

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
 * @param {ChunkHeader} chunk
 * @param {number} blockSize
 * @returns {number}
 */
function calcChunksRealDataBytes(chunk, blockSize) {
  switch (chunk.type) {
    case ChunkType.Raw:
      return chunk.dataBytes;
    case ChunkType.Fill:
      return chunk.blocks * blockSize;
    case ChunkType.Skip:
      return chunk.blocks * blockSize;
    case ChunkType.Crc32:
      return 0;
    default:
      throw "Sparse - Unknown chunk type";
  }
}


/**
 * @param {ChunkHeader[]} chunks
 * @param {number} blockSize
 * @returns {number}
 */
function calcChunksSize(chunks, blockSize) {
  return chunks.map((chunk) => calcChunksRealDataBytes(chunk, blockSize)).reduce((total, c) => total + c, 0);
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

  header.crc32 = 0;
  blob = blob.slice(FILE_HEADER_SIZE);
  /** @type {Chunk[]} */
  let splitChunks = [];
  for (let i = 0; i < header.totalChunks; i++) {
    const originalChunk = await parseChunkHeader(blob.slice(0, CHUNK_HEADER_SIZE));
    let originalChunkData = blob.slice(CHUNK_HEADER_SIZE, CHUNK_HEADER_SIZE + originalChunk.dataBytes);
    blob = blob.slice(CHUNK_HEADER_SIZE + originalChunk.dataBytes);

    /** @type {Chunk[]} */
    const chunksToProcess = [];
    let realBytesToWrite = calcChunksRealDataBytes(originalChunk, header.blockSize);

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
              data: isChunkTypeSkip ? new Blob([]) : originalChunkData.slice(0, toSend),
            });
            realBytesToWrite -= realSend;
          }
        } else {
          chunksToProcess.push({
            type: originalChunk.type,
            blocks: toSend / header.blockSize,
            dataBytes: toSend,
            data: originalChunkData.slice(0, toSend),
          });
        }
        bytesToWrite -= toSend;
        originalChunkData = originalChunkData.slice(toSend);
      }
    } else {
      chunksToProcess.push({ ...originalChunk, data: originalChunkData });
    }
    for (const chunk of chunksToProcess) {
      const remainingBytes = splitSize - calcChunksSize(splitChunks);
      const realChunkBytes = calcChunksRealDataBytes(chunk, header.blockSize);
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
