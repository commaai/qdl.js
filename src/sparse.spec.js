import * as Bun from "bun";
import { beforeAll, describe, expect, test } from "bun:test";

import { parseFileHeader, Sparse } from "./sparse";

const inputData = Bun.file("./test/fixtures/sparse.img");
const expectedData = Bun.file("./test/fixtures/raw.img");

describe("sparse", () => {
  test("parseFileHeader", async () => {
    expect(await parseFileHeader(inputData)).toEqual({
      magic: 0xED26FF3A,
      majorVersion: 1,
      minorVersion: 0,
      fileHeaderSize: 28,
      chunkHeaderSize: 12,
      blockSize: 4096,
      totalBlocks: 9,
      totalChunks: 6,
      crc32: 0,
    });
  });

  describe("Sparse", () => {
    /** @type {Sparse} */
    let sparse;

    beforeAll(async () => {
      sparse = await Sparse.from(inputData);
    });

    test("chunks", async () => {
      const chunks = await Array.fromAsync(sparse.chunks());
      expect(chunks.length).toBe(sparse.header.totalChunks);
    });

    test("getSize", async () => {
      expect(await sparse.getSize()).toBe(sparse.header.totalBlocks * sparse.header.blockSize);
    });

    describe("read", () => {
      test("compare output", async () => {
        let offset = 0;
        for await (const data of sparse.read()) {
          const receivedChunkBuffer = Buffer.from(data);
          const [start, end] = [offset, offset + data.byteLength];
          offset += data.byteLength;
          const expectedSlice = expectedData.slice(start, end);
          const expectedChunkBuffer = Buffer.from(new Uint8Array(await expectedSlice.arrayBuffer()));
          const result = receivedChunkBuffer.compare(expectedChunkBuffer);
          if (result) {
            console.debug("Expected:", expectedChunkBuffer.toString("hex"));
            console.debug("Received:", receivedChunkBuffer.toString("hex"));
          }
          expect(result, `range ${start} to ${end} differs`).toBe(0);
        }
        expect(offset).toEqual(expectedData.size);
      });

      test.each([4096, 8192])("maxSize: %p", async (splitSize) => {
        let prevLength = 0;
        for await (const data of sparse.read(splitSize)) {
          expect(data.byteLength).toBeGreaterThan(0);
          expect(data.byteLength).toBeLessThanOrEqual(splitSize);
          if (prevLength) expect(data.byteLength + prevLength).toBeGreaterThan(splitSize);
          prevLength = data.byteLength;
        }
      });
    });
  });
});
