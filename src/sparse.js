import { readBlobAsBuffer } from "./utils";

const FILE_MAGIC = 0xed26ff3a;
export const FILE_HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;

const ChunkType = {
  Raw : 0xCAC1,
  Fill : 0xCAC2,
  Skip : 0xCAC3,
  Crc32 : 0xCAC4,
}


class QCSparse {
  /**
   * @param {Blob} blob
   * @param header
   */
  constructor(blob, header) {
    this.blob = blob;
    this.blockSize = header.blockSize;
    this.totalChunks = header.totalChunks;
    this.blobOffset = 0;
  }

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

  async getSize() {
    this.blobOffset = FILE_HEADER_SIZE;
    let length = 0, chunk = 0;
    while (chunk < this.totalChunks) {
      let tlen = await this.getChunkSize();
      length += tlen;
      chunk += 1;
    }
    this.blobOffset = FILE_HEADER_SIZE;
    return length;
  }
}


export async function getSparseRealSize(blob, header) {
  const sparseImage = new QCSparse(blob, header);
  return await sparseImage.getSize();
}


async function parseChunkHeader(blobChunkHeader) {
  let chunkHeader = await readBlobAsBuffer(blobChunkHeader);
  let view = new DataView(chunkHeader);
  return {
    type : view.getUint16(0, true),
    blocks : view.getUint32(4, true),
    dataBytes : view.getUint32(8, true) - CHUNK_HEADER_SIZE,
    data : null,
  }
}

export async function parseFileHeader(blobHeader) {
  let header = await readBlobAsBuffer(blobHeader);
  let view = new DataView(header);

  let magic = view.getUint32(0, true);
  let majorVersion = view.getUint16(4, true);
  let minorVersion = view.getUint16(6, true);
  let fileHeadrSize = view.getUint16(8, true);
  let chunkHeaderSize = view.getUint16(10, true);
  let blockSize = view.getUint32(12, true);
  let totalBlocks = view.getUint32(16, true);
  let totalChunks = view.getUint32(20, true);
  let crc32 = view.getUint32(24, true);

  if (magic !== FILE_MAGIC) {
    return null;
  }
  if (fileHeadrSize !== FILE_HEADER_SIZE) {
    console.error(`The file header size was expected to be 28, but is ${fileHeadrSize}.`);
    return null;
  }
  if (chunkHeaderSize !== CHUNK_HEADER_SIZE) {
    console.error(`The chunk header size was expected to be 12, but is ${chunkHeaderSize}.`);
    return null;
  }

  return {
    magic : magic,
    majorVersion : majorVersion,
    minorVersion : minorVersion,
    fileHeadrSize : fileHeadrSize,
    chunkHeaderSize : chunkHeaderSize,
    blockSize : blockSize,
    totalBlocks : totalBlocks,
    totalChunks : totalChunks,
    crc32 : crc32,
  }
}

/**
 * @param chunks
 * @param {number} blockSize
 * @returns {Promise<Blob>}
 */
async function populate(chunks, blockSize) {
  const nBlocks = calcChunksBlocks(chunks);
  let ret = new Uint8Array(nBlocks * blockSize);
  let offset = 0;

  for (const chunk of chunks) {
    const chunkType = chunk.type;
    const blocks = chunk.blocks;
    const dataSize = chunk.dataBytes;
    const data = chunk.data;

    if (chunkType === ChunkType.Raw) {
      let rawData = new Uint8Array(await readBlobAsBuffer(data));
      ret.set(rawData, offset);
      offset += blocks * blockSize;
    } else if (chunkType === ChunkType.Fill) {
      const fillBin = new Uint8Array(await readBlobAsBuffer(data));
      const bufferSize = blocks * blockSize;
      for (let i = 0; i < bufferSize; i += dataSize) {
        ret.set(fillBin, offset);
        offset += dataSize;
      }
    } else if (chunkType === ChunkType.Skip) {
      let byteToSend = blocks * blockSize;
      let skipData = new Uint8Array(byteToSend).fill(0);
      ret.set(skipData, offset);
      offset += byteToSend;
    } else if (chunkType === ChunkType.Crc32) {
      continue;
    } else {
      throw "Sparse - Unknown chunk type";
    }
  }
  return new Blob([ret.buffer]);
}


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


function calcChunksSize(chunks, blockSize) {
  return chunks.map((chunk) => calcChunksRealDataBytes(chunk, blockSize)).reduce((total, c) => total + c, 0);
}


function calcChunksBlocks(chunks) {
  return chunks.map((chunk) => chunk.blocks).reduce((total, c) => total + c, 0);
}


/**
 * @param {Blob} blob
 * @param {number} splitSize
 */
export async function* splitBlob(blob, splitSize = 1048576 /* maxPayloadSizeToTarget */) {
  const safeToSend = splitSize;

  let header = await parseFileHeader(blob.slice(0, FILE_HEADER_SIZE));
  if (header === null) {
    yield blob;
    return;
  }

  header.crc32 = 0;
  blob = blob.slice(FILE_HEADER_SIZE);
  let splitChunks = [];
  for (let i = 0; i < header.totalChunks; i++) {
    let originalChunk = await parseChunkHeader(blob.slice(0, CHUNK_HEADER_SIZE));
    originalChunk.data = blob.slice(CHUNK_HEADER_SIZE, CHUNK_HEADER_SIZE + originalChunk.dataBytes);
    blob = blob.slice(CHUNK_HEADER_SIZE + originalChunk.dataBytes);

    let chunksToProcess = [];
    let realBytesToWrite = calcChunksRealDataBytes(originalChunk, header.blockSize)

    const isChunkTypeSkip = originalChunk.type === ChunkType.Skip;
    const isChunkTypeFill = originalChunk.type === ChunkType.Fill;

    if (realBytesToWrite > safeToSend) {
      let bytesToWrite = isChunkTypeSkip ? 1 : originalChunk.dataBytes;
      let originalChunkData = originalChunk.data;

      while (bytesToWrite > 0) {
        const toSend = Math.min(safeToSend, bytesToWrite);
        let tmpChunk;

        if (isChunkTypeFill || isChunkTypeSkip) {
          while (realBytesToWrite > 0) {
            const realSend = Math.min(safeToSend, realBytesToWrite);
            tmpChunk = {
              type : originalChunk.type,
              blocks : realSend / header.blockSize,
              dataBytes : isChunkTypeSkip ? 0 : toSend,
              data : isChunkTypeSkip ? new Blob([]) : originalChunkData.slice(0, toSend),
            }
            chunksToProcess.push(tmpChunk);
            realBytesToWrite -= realSend;
          }
        } else {
          tmpChunk = {
            type : originalChunk.type,
            blocks : toSend / header.blockSize,
            dataBytes : toSend,
            data : originalChunkData.slice(0, toSend),
          }
          chunksToProcess.push(tmpChunk);
        }
        bytesToWrite -= toSend;
        originalChunkData = originalChunkData?.slice(toSend);
      }
    } else {
      chunksToProcess.push(originalChunk)
    }
    for (const chunk of chunksToProcess) {
      const remainingBytes = splitSize - calcChunksSize(splitChunks);
      const realChunkBytes = calcChunksRealDataBytes(chunk);
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
