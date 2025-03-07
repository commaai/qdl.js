import { concatUint8Array } from "./utils";

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
 * @typedef {object} SparseChunk
 * @property {Header} header
 * @property {number} type
 * @property {number} blocks
 * @property {Uint8Array} data
 */


/**
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<AsyncIterator<SparseChunk> | null>}
 */
export async function* readChunks(stream) {
  let buffer = new Uint8Array(0);

  const readUntil = async (byteLength) => {
    if (buffer.byteLength >= byteLength) return;
    const reader = stream.getReader();
    try {
      const parts = [buffer];
      let size = buffer.byteLength;
      while (size < byteLength) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Unexpected end of stream");
        parts.push(value);
        size += value.byteLength;
      }
      buffer = concatUint8Array(parts);
    } finally {
      reader.releaseLock();
    }
  }

  await readUntil(FILE_HEADER_SIZE);
  const header = parseFileHeader(buffer.buffer);
  if (header === null) return null;
  buffer = buffer.slice(FILE_HEADER_SIZE);

  for (let i = 0; i < header.totalChunks; i++) {
    await readUntil(CHUNK_HEADER_SIZE);
    const view = new DataView(buffer.buffer);
    const chunkType = view.getUint16(0, true);
    const chunkBlockCount = view.getUint32(4, true);
    const chunkTotalBytes = view.getUint32(8, true);
    await readUntil(chunkTotalBytes);
    yield {
      header,
      type: chunkType,
      blocks: chunkBlockCount,
      data: buffer.slice(CHUNK_HEADER_SIZE, chunkTotalBytes),
    };
    buffer = buffer.slice(chunkTotalBytes);
  }

  if (buffer.byteLength > 0) {
    console.warn("Sparse - Backing data larger than expected");
  }
}


/**
 * @param {AsyncIterator<SparseChunk>} chunks
 * @returns {AsyncIterator<[number, Uint8Array | null, number]>}
 */
export async function* inflateChunks(chunks) {
  let offset = 0;
  for await (const { header, type, blocks, data } of chunks) {
    const size = blocks * header.blockSize;
    if (type === ChunkType.Raw) {
      yield [offset, data, size];
      offset += size;
    } else if (type === ChunkType.Fill) {
      if (data.some((byte) => byte !== 0)) {
        const buffer = new Uint8Array(size);
        for (let i = 0; i < buffer.byteLength; i += 4) buffer.set(data, i);
        yield [offset, buffer, size];
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
 * @param {ArrayBufferLike} buffer
 * @returns {Header | null}
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
    throw new Error(`The file header size was expected to be 28, but is ${fileHeaderSize}.`);
  }
  if (chunkHeaderSize !== CHUNK_HEADER_SIZE) {
    throw new Error(`The chunk header size was expected to be 12, but is ${chunkHeaderSize}.`);
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
