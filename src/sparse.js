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
 * @typedef {object} SparseHeader
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
 * @property {SparseHeader} header
 * @property {number} type
 * @property {number} blocks
 * @property {Uint8Array} data
 */


/**
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<ReadableStream<SparseChunk> | null>}
 */
export async function from(stream) {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);

  const readUntil = async (byteLength) => {
    if (buffer.byteLength >= byteLength) return;
    const parts = [buffer];
    let size = buffer.byteLength;
    while (size < byteLength) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Unexpected end of stream");
      parts.push(value);
      size += value.byteLength;
    }
    buffer = concatUint8Array(parts);
  }

  let header;
  try {
    await readUntil(FILE_HEADER_SIZE);
    header = parseFileHeader(buffer.buffer);
    if (header === null) return null;
    buffer = buffer.slice(FILE_HEADER_SIZE);
  } catch (e) {
    reader.releaseLock();
    throw e;
  }

  let chunkIndex = 0;
  return new ReadableStream({
    async pull(controller) {
      await readUntil(CHUNK_HEADER_SIZE);
      while (buffer.byteLength >= CHUNK_HEADER_SIZE && chunkIndex < header.totalChunks) {
        const view = new DataView(buffer.buffer);
        const chunkType = view.getUint16(0, true);
        const chunkBlockCount = view.getUint32(4, true);
        const chunkTotalBytes = view.getUint32(8, true);
        await readUntil(chunkTotalBytes);
        controller.enqueue({
          header,
          type: chunkType,
          blocks: chunkBlockCount,
          data: buffer.slice(CHUNK_HEADER_SIZE, chunkTotalBytes),
        });
        chunkIndex++;
        buffer = buffer.slice(chunkTotalBytes);
      }
      if (chunkIndex === header.totalChunks) {
        controller.close();
        if (buffer.byteLength > 0) {
          console.warn("Sparse - Backing data larger than expected");
        }
      }
    },
    cancel() {
      reader.releaseLock();
    },
  });
}


/**
 * @param {ReadableStream<SparseChunk>} stream
 * @returns {ReadableStream<[number, Uint8Array | null, number]>}
 */
export function read(stream) {
  const reader = stream.getReader();
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      const { header, type, blocks, data } = value;
      const size = blocks * header.blockSize;
      if (type === ChunkType.Raw) {
        controller.enqueue([offset, data, size]);
        offset += size;
      } else if (type === ChunkType.Fill) {
        if (data.some((byte) => byte !== 0)) {
          const buffer = new Uint8Array(size);
          for (let i = 0; i < buffer.byteLength; i += 4) buffer.set(data, i);
          controller.enqueue([offset, buffer, size]);
        } else {
          controller.enqueue([offset, null, size]);
        }
        offset += size;
      } else if (type === ChunkType.Skip) {
        controller.enqueue([offset, null, size]);
        offset += size;
      }
    },
    cancel() {
      reader.releaseLock();
    },
  });
}


/**
 * @param {ArrayBufferLike} buffer
 * @returns {SparseHeader | null}
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
