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
 * @typedef {object} ChunkHeader
 * @property {number} type
 * @property {number} blocks
 * @property {number} byteLength
 * @property {number} dataByteLength
 */


/**
 * @typedef {object} Chunk
 * @property {number} type
 * @property {number} blocks
 * @property {number} dataByteLength
 * @property {Blob} data
 * @property {number} [realByteLength]
 */


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
  const type = view.getUint16(0, true);
  const byteLength = view.getUint32(8, true);
  return {
    type,
    _typeName: Object.entries(ChunkType).find((it) => it[1] === type)?.[0],
    blocks: view.getUint32(4, true),
    byteLength,
    dataByteLength: byteLength - CHUNK_HEADER_SIZE,
  };
}


/**
 * @typedef {object} FileHeader
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
 * @param {Blob} blob
 * @returns {Promise<FileHeader|null>}
 */
export async function parseFileHeader(blob) {
  const view = new DataView(await blob.slice(0, FILE_HEADER_SIZE).arrayBuffer());
  const magic = view.getUint32(0, true);
  if (magic !== FILE_MAGIC) {
    return null;
  }
  const fileHeaderSize = view.getUint16(8, true);
  if (fileHeaderSize !== FILE_HEADER_SIZE) {
    console.error(`The file header size was expected to be 28, but is ${fileHeaderSize}.`);
    return null;
  }
  const chunkHeaderSize = view.getUint16(10, true);
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
 * @param {Chunk} chunk
 * @param {number} blockSize
 * @returns {number}
 */
function getChunkRealByteLength(chunk, blockSize) {
  switch (chunk.type) {
    case ChunkType.Raw:
      if (chunk.dataByteLength !== (chunk.blocks * blockSize)) throw "Sparse - Chunk input size does not match output size";
      return chunk.dataByteLength;
    case ChunkType.Fill:
      if (chunk.dataByteLength !== 4) throw "Sparse - Fill chunk should have 4 bytes";
      return chunk.blocks * blockSize;
    case ChunkType.Skip:
      return chunk.blocks * blockSize;
    case ChunkType.Crc32:
      if (chunk.dataByteLength !== 4) throw "Sparse - CRC32 chunk should have 4 bytes";
      return 0;
    default:
      console.trace("Sparse - Unknown chunk type", chunk);
      throw `Sparse - Unknown chunk type: ${chunk.type}`;
  }
}


/**
 * @param {Blob} blob
 * @param {FileHeader} header
 * @returns {Promise<number>}
 */
export async function getFileRealByteLength(blob, header) {
  let byteOffset = FILE_HEADER_SIZE, chunk = 0, realSize = 0;
  while (chunk < header.totalChunks) {
    if (byteOffset + CHUNK_HEADER_SIZE > blob.size) {
      console.trace("Sparse - Unexpectedly reached end of blob", { blob, header, chunk });
      throw "Sparse - Unexpectedly reached end of blob";
    }
    const { byteLength, ...chunkHeader } = parseChunkHeader(blob.slice(byteOffset, byteOffset + CHUNK_HEADER_SIZE));
    byteOffset += byteLength;
    chunk += 1;
    realSize += getChunkRealByteLength(chunkHeader, header.blockSize);
  }
  if (byteOffset < blob.size) {
    console.trace("Sparse - Blob contains extra data", { blob, header });
  }
  return realSize;
}


/**
 * @param {Chunk[]} chunks
 * @param {number} blockSize
 * @returns {Promise<Blob>}
 */
async function populate(chunks, blockSize) {
  const totalBlocks = chunks.reduce((acc, it) => acc + it.blocks, 0);
  const ret = new Uint8Array(totalBlocks * blockSize);
  let offset = 0;
  for (const { type, blocks, dataByteLength, data } of chunks) {
    switch (type) {
      case ChunkType.Raw: {
        const rawData = new Uint8Array(data.arrayBuffer());
        ret.set(rawData, offset);
        offset += blocks * blockSize;
        break;
      }
      case ChunkType.Fill: {
        const fillBin = new Uint8Array(data.arrayBuffer());
        const bufferSize = blocks * blockSize;
        for (let i = 0; i < bufferSize; i += dataByteLength) {
          ret.set(fillBin, offset);
          offset += dataByteLength;
        }
        break;
      }
      case ChunkType.Skip: {
        const byteToSend = blocks * blockSize;
        const skipData = new Uint8Array(byteToSend).fill(0);
        ret.set(skipData, offset);
        offset += byteToSend;
        break;
      }
      case ChunkType.Crc32:
        break;
      default:
        throw "Sparse - Unknown chunk type";
    }
  }
  return new Blob([ret]);
}


/**
 * @param {Chunk[]} chunks
 * @param {number} blockSize
 * @returns {*}
 */
function calcChunksRealByteLength(chunks, blockSize) {
  return chunks.reduce((acc, chunk) => {
    if (chunk.realByteLength === undefined) chunk.realByteLength = getChunkRealByteLength(chunk, blockSize);
    return acc + chunk.realByteLength;
  }, 0);
}


/**
 * @param {Blob} blob
 * @param {number} splitSize
 * @returns {AsyncIterable<Blob>}
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
    console.log("originalChunk", originalChunk);
    originalChunk.data = blob.slice(CHUNK_HEADER_SIZE, CHUNK_HEADER_SIZE + originalChunk.byteLength);
    blob = blob.slice(CHUNK_HEADER_SIZE + originalChunk.byteLength);

    /** @type {Chunk[]} */
    const chunksToProcess = [];
    let realBytesToWrite = getChunkRealByteLength(originalChunk, header.blockSize);
    console.log("realBytesToWrite", realBytesToWrite);

    const isChunkTypeSkip = originalChunk.type === ChunkType.Skip;
    const isChunkTypeFill = originalChunk.type === ChunkType.Fill;

    if (realBytesToWrite > safeToSend) {
      let bytesToWrite = isChunkTypeSkip ? 1 : originalChunk.byteLength;
      let originalChunkData = originalChunk.data;

      while (bytesToWrite > 0) {
        const toSend = Math.min(safeToSend, bytesToWrite);
        /** @type {Chunk} */
        let tmpChunk;

        if (isChunkTypeFill || isChunkTypeSkip) {
          while (realBytesToWrite > 0) {
            const realSend = Math.min(safeToSend, realBytesToWrite);
            tmpChunk = {
              type: originalChunk.type,
              blocks: realSend / header.blockSize,
              dataByteLength: isChunkTypeSkip ? 0 : toSend,
              data: isChunkTypeSkip ? new Blob([]) : originalChunkData.slice(0, toSend),
            };
            chunksToProcess.push(tmpChunk);
            realBytesToWrite -= realSend;
          }
        } else {
          tmpChunk = {
            type: originalChunk.type,
            blocks: toSend / header.blockSize,
            dataByteLength: toSend,
            data: originalChunkData.slice(0, toSend),
          };
          chunksToProcess.push(tmpChunk);
        }
        bytesToWrite -= toSend;
        originalChunkData = originalChunkData.slice(toSend);
      }
    } else {
      chunksToProcess.push(originalChunk);
    }
    for (const chunk of chunksToProcess) {
      const remainingBytes = splitSize - calcChunksRealByteLength(splitChunks, header.blockSize);
      const realChunkBytes = getChunkRealByteLength(chunk, header.blockSize);
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
