import * as Bun from "bun";
import { describe, expect, test } from "bun:test";

import * as Sparse from "./sparse";

const inputData = Bun.file("./test/fixtures/sparse.img");
const expectedData = Bun.file("./test/fixtures/raw.img");

describe("sparse", () => {
  test("parseFileHeader", async () => {
    expect(await Sparse.parseFileHeader(inputData)).toEqual({
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

  describe("splitBlob", () => {
    test("compare output", async () => {
      const receivedData = new Blob(await Array.fromAsync(Sparse.splitBlob(inputData)));
      expect(receivedData.size).toEqual(expectedData.size);
      expect(Buffer.from(new Uint8Array(await receivedData.arrayBuffer())).compare(new Uint8Array(await expectedData.arrayBuffer()))).toBe(0);
    });

    test.each([1024, 8192])("splitSize: %p", async () => {
      const splitSize = 8192;
      let prevSize = 0;
      for await (const part of Sparse.splitBlob(inputData, splitSize)) {
        expect(part.size).toBeGreaterThan(0);
        expect(part.size).toBeLessThanOrEqual(splitSize);
        if (prevSize) expect(part.size + prevSize).toBeGreaterThan(splitSize);
        prevSize = part.size;
      }
    });
  });
});
