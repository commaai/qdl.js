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


function assert(condition) {
  if (!condition) throw new Error("Assertion failed");
}


/**
 * @param {ReadableStream<Uint8Array>} stream
 * @param {number} maxSize
 * @returns {Promise<AsyncGenerator<[number, Uint8Array | null, number], void, *> | null>}
 */
export async function from(stream, maxSize = 1024 * 1024) {
  let buffer = new ArrayBuffer(0, { maxByteLength: maxSize });
  let view = new Uint8Array(buffer);

  /**
   * @param {number} byteLength
   */
  const readUntil = async (byteLength) => {
    assert(byteLength <= buffer.maxByteLength);
    if (buffer.byteLength >= byteLength) return;
    const reader = stream.getReader();
    let offset = buffer.byteLength;
    try {
      while (offset < byteLength) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Unexpected end of stream");
        size += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    buffer = buffer.transfer(size);
    view = new Uint8Array(buffer);
    for (let j = 0; j < i; j++) {
      const part = parts[j];
      view.set(part, offset);
      offset += part.byteLength;
    }
  }

  await readUntil(FILE_HEADER_SIZE);
  const header = parseFileHeader(buffer.buffer);
  if (!header) return null;
  buffer = buffer.slice(FILE_HEADER_SIZE);

  /**
   * @returns {AsyncGenerator<[number, Uint8Array | null, number], void, *>}
   */
  async function* inflateChunks() {
    let offset = 0;
    for (let i = 0; i < header.totalChunks; i++) {
      await readUntil(CHUNK_HEADER_SIZE);
      const view = new DataView(buffer.buffer);
      const type = view.getUint16(0, true);
      const blockCount = view.getUint32(4, true);
      const totalBytes = view.getUint32(8, true);
      const size = blockCount * header.blockSize;

      if (type === ChunkType.Raw) {
        let readBytes = CHUNK_HEADER_SIZE;
        while (readBytes < totalBytes) {
          const dataChunkSize = Math.min(totalBytes - readBytes, maxSize);
          await readUntil(readBytes + dataChunkSize);  // TODO: maybe read smaller chunks?
          const data = buffer.subarray(readBytes, readBytes + dataChunkSize);
          assert(data.byteLength === dataChunkSize);
          yield [offset, data, dataChunkSize];
          // buffer = buffer.slice(dataChunkSize);
          readBytes += dataChunkSize;
          offset += dataChunkSize;
        }
        assert(readBytes === size);
        buffer = buffer.slice(totalBytes);
      } else if (type === ChunkType.Fill) {
        await readUntil(totalBytes);
        const data = buffer.slice(CHUNK_HEADER_SIZE, totalBytes);
        buffer = buffer.slice(totalBytes);
        if (data.some((byte) => byte !== 0)) {
          assert(data.byteLength === 4);
          let readBytes = 0;
          while (readBytes < size) {
            const fillSize = Math.min(size - readBytes, maxSize);
            const fill = new Uint8Array(fillSize);
            for (let i = 0; i < fillSize; i += 4) fill.set(data, i);
            yield [offset, fill, fillSize];
            offset += fillSize;
            readBytes += fillSize;
          }
          assert(readBytes === size);
        } else {
          yield [offset, null, size];
          offset += size;
        }
      } else {
        if (type === ChunkType.Skip) {
          yield [offset, null, size];
          offset += size;
        }
        await readUntil(totalBytes);
        buffer = buffer.slice(totalBytes);
      }
    }
    if (buffer.byteLength > 0) {
      console.warn("Sparse - Backing data larger than expected");
    }
  }

  return inflateChunks();
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
