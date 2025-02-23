const SPARSE_HEADER_MAGIC = 0xED26FF3A;
export const SPARSE_HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;


/**
 * @enum SparseChunkType
 */
const SparseChunkType = {
  Raw: 0xCAC1,
  Fill: 0xCAC2,
  Skip: 0xCAC3,
  Crc32: 0xCAC4,
};


/**
 * @typedef {object} SparseHeader
 * @property {number} magic - 0xED26FF3A
 * @property {number} majorVersion
 * @property {number} minorVersion
 * @property {number} size - 28 bytes
 * @property {number} chunkHeaderSize - 12 bytes
 * @property {number} blockSize - bytes - Must be a multiple of 4 (4096)
 * @property {number} blockCount - Non-sparse output image
 * @property {number} chunkCount - Sparse input image
 * @property {number} imageChecksum - CRC32 checksum of the original data
 */


/**
 * @typedef {object} SparseChunkHeader
 * @property {number} type - Raw/Fill/Skip/Crc32
 * @property {number} blockCount - Output image
 * @property {number} totalSize - [byte] Input file chunk header + data
 * @property {number} dataSize - [byte]
 */


/**
 * @typedef {object} SparseChunk
 * @property {number} type - Raw/Fill/Skip/Crc32
 * @property {number} blockCount - In img file
 * @property {number} dataSize - Data size in sparse file (without header)
 * @property {Blob} data
 * @property {number} [realDataSize]
 */


/**
 * @param {Blob} blob
 * @returns {Promise<SparseHeader|null>}
 */
export async function parseSparseHeader(blob) {
  const view = new DataView(await blob.slice(0, SPARSE_HEADER_SIZE).arrayBuffer());
  const magic = view.getUint32(0, true);
  if (magic !== SPARSE_HEADER_MAGIC) {
    return null;
  }
  const size = view.getUint16(8, true);
  if (size !== SPARSE_HEADER_SIZE) {
    console.error(`The sparse header size was expected to be 28, but is ${size}.`);
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
    size,
    chunkHeaderSize,
    blockSize: view.getUint32(12, true),
    blockCount: view.getUint32(16, true),
    chunkCount: view.getUint32(20, true),
    imageChecksum: view.getUint32(24, true),
  };
}


/**
 * @param {Blob} blob
 * @returns {Promise<SparseChunkHeader>}
 */
async function parseChunkHeader(blob) {
  if (blob.size !== CHUNK_HEADER_SIZE) {
    console.trace("Sparse - Incorrectly sized blob passed to parseChunkHeader", blob);
    throw "Sparse - Incorrectly sized blob passed to parseChunkHeader";
  }
  const view = new DataView(await blob.arrayBuffer());
  const type = view.getUint16(0, true);
  const totalSize = view.getUint32(8, true);
  return {
    type,
    _typeName: Object.entries(SparseChunkType).find((it) => it[1] === type)?.[0],
    blockCount: view.getUint32(4, true),
    totalSize,
    dataSize: totalSize - CHUNK_HEADER_SIZE,
  };
}


/**
 * @param {SparseChunk} chunk
 * @param {number} blockSize
 * @returns {number}
 */
function getChunkRealByteLength(chunk, blockSize) {
  switch (chunk.type) {
    case SparseChunkType.Raw:
      if (chunk.dataSize !== (chunk.blockCount * blockSize)) throw "Sparse - Chunk input size does not match output size";
      return chunk.dataSize;
    case SparseChunkType.Fill:
      if (chunk.dataSize !== 4) throw "Sparse - Fill chunk should have 4 bytes";
      return chunk.blockCount * blockSize;
    case SparseChunkType.Skip:
      return chunk.blockCount * blockSize;
    case SparseChunkType.Crc32:
      if (chunk.dataSize !== 4) throw "Sparse - CRC32 chunk should have 4 bytes";
      return 0;
    default:
      console.trace("Sparse - Unknown chunk type", chunk);
      throw `Sparse - Unknown chunk type: ${chunk.type}`;
  }
}


/**
 * @param {Blob} blob
 * @param {SparseHeader} header
 * @returns {Promise<number>}
 */
export async function getFileRealByteLength(blob, header) {
  let byteOffset = SPARSE_HEADER_SIZE, chunk = 0, realSize = 0;
  while (chunk < header.chunkCount) {
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
 * @param {SparseChunk[]} chunks
 * @param {number} blockSize
 * @returns {Promise<Blob>}
 */
async function populate(chunks, blockSize) {
  const totalBlocks = chunks.reduce((acc, it) => acc + it.blockCount, 0);
  const ret = new Uint8Array(totalBlocks * blockSize);
  let offset = 0;
  for (const { type, blocks, dataByteLength, data } of chunks) {
    switch (type) {
      case SparseChunkType.Raw: {
        const rawData = new Uint8Array(data.arrayBuffer());
        ret.set(rawData, offset);
        offset += blocks * blockSize;
        break;
      }
      case SparseChunkType.Fill: {
        const fillBin = new Uint8Array(data.arrayBuffer());
        const bufferSize = blocks * blockSize;
        for (let i = 0; i < bufferSize; i += dataByteLength) {
          ret.set(fillBin, offset);
          offset += dataByteLength;
        }
        break;
      }
      case SparseChunkType.Skip: {
        const byteToSend = blocks * blockSize;
        const skipData = new Uint8Array(byteToSend).fill(0);
        ret.set(skipData, offset);
        offset += byteToSend;
        break;
      }
      case SparseChunkType.Crc32:
        break;
      default:
        throw "Sparse - Unknown chunk type";
    }
  }
  return new Blob([ret]);
}


/**
 * @param {SparseChunk[]} chunks
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
 * @returns {AsyncIterable<Uint8Array>}
 */
export async function* splitBlob(blob) {
  const header = await parseSparseHeader(blob.slice(0, SPARSE_HEADER_SIZE));
  if (header === null) {
    yield* splitData(new Uint8Array(await blob.arrayBuffer()), splitSize);
    return;
  }

  let offset = 0;
  for (let i = 0; i < header.chunkCount; i++) {
    const chunk = await parseChunkHeader(blob.slice(offset, offset + header.chunkHeaderSize));
    chunk.data = blob.slice(offset + header.chunkHeaderSize, offset + chunk.totalSize);
    chunk.realByteLength = getChunkRealByteLength(chunk);
    offset += chunk.totalSize;

    /** @type {Uint8Array|undefined} */
    if (chunk.type === SparseChunkType.Raw) {
      yield* splitData(new Uint8Array(await chunk.data.arrayBuffer()));
    } else if (chunk.type === SparseChunkType.Fill) {
      const writeSize = chunk.blockCount * header.blockSize;
      const fillSize = Math.min(splitSize, header.blockSize);
      if (writeSize % fillSize !== 0) {
        console.trace("Sparse - Write size not multiple of fill size", { header, chunk });
        throw "Sparse - Write size not multiple of fill size";
      }
      for (let j = 0; j < writeSize; j += fillSize) {
        const buffer = new Uint8Array(fillSize);

      }
    }
  }

  /** @type {SparseChunk[]} */
  // let splitChunks = [];
  // for (let i = 0; i < header.chunkCount; i++) {
  //   const originalChunk = await parseChunkHeader(blob.slice(0, CHUNK_HEADER_SIZE));
  //   console.log("originalChunk", originalChunk);
  //
  //   const [start, end] = [CHUNK_HEADER_SIZE, CHUNK_HEADER_SIZE + originalChunk.totalSize];
  //   originalChunk.data = blob.slice(start, end);
  //   blob = blob.slice(end);
  //
  //   /** @type {SparseChunk[]} */
  //   const chunksToProcess = [];
  //   let realBytesToWrite = getChunkRealByteLength(originalChunk, header.blockSize);
  //   console.log("realBytesToWrite", realBytesToWrite);
  //
  //   const isChunkTypeSkip = originalChunk.type === SparseChunkType.Skip;
  //   const isChunkTypeFill = originalChunk.type === SparseChunkType.Fill;
  //
  //   if (realBytesToWrite > safeToSend) {
  //     let bytesToWrite = isChunkTypeSkip ? 1 : originalChunk.byteLength;
  //     let originalChunkData = originalChunk.data;
  //
  //     while (bytesToWrite > 0) {
  //       const toSend = Math.min(safeToSend, bytesToWrite);
  //       /** @type {SparseChunk} */
  //       let tmpChunk;
  //
  //       if (isChunkTypeFill || isChunkTypeSkip) {
  //         while (realBytesToWrite > 0) {
  //           const realSend = Math.min(safeToSend, realBytesToWrite);
  //           tmpChunk = {
  //             type: originalChunk.type,
  //             blocks: realSend / header.blockSize,
  //             dataByteLength: isChunkTypeSkip ? 0 : toSend,
  //             data: isChunkTypeSkip ? new Blob([]) : originalChunkData.slice(0, toSend),
  //           };
  //           chunksToProcess.push(tmpChunk);
  //           realBytesToWrite -= realSend;
  //         }
  //       } else {
  //         tmpChunk = {
  //           type: originalChunk.type,
  //           blocks: toSend / header.blockSize,
  //           dataByteLength: toSend,
  //           data: originalChunkData.slice(0, toSend),
  //         };
  //         chunksToProcess.push(tmpChunk);
  //       }
  //       bytesToWrite -= toSend;
  //       originalChunkData = originalChunkData.slice(toSend);
  //     }
  //   } else {
  //     chunksToProcess.push(originalChunk);
  //   }
  //   for (const chunk of chunksToProcess) {
  //     const remainingBytes = splitSize - calcChunksRealByteLength(splitChunks, header.blockSize);
  //     const realChunkBytes = getChunkRealByteLength(chunk, header.blockSize);
  //     console.log("remainingBytes", remainingBytes);
  //     console.log("realChunkBytes", realChunkBytes);
  //     if (remainingBytes >= realChunkBytes) {
  //       splitChunks.push(chunk);
  //     } else {
  //       yield await populate(splitChunks, header.blockSize);
  //       splitChunks = [chunk];
  //     }
  //   }
  // }
  // if (splitChunks.length > 0) {
  //   yield await populate(splitChunks, header.blockSize);
  // }
}
