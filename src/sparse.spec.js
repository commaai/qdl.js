import * as Bun from "bun";
import { beforeAll, describe, expect, test } from "bun:test";

import * as Sparse from "./sparse";

const inputData = Bun.file("./test/fixtures/sparse.img");
const expectedData = Bun.file("./test/fixtures/raw.img");
// const inputData = Bun.file("/home/cameron/comma/agnos-builder/output/system.img");
// const expectedData = Bun.file("/home/cameron/comma/agnos-builder/output/system-raw2.img");

describe("sparse", () => {
  /** @type {import("./sparse").Header} */
  let header;

  beforeAll(async () => {
    header = await Sparse.parseFileHeader(inputData);
  });

  test("parseFileHeader", () => {
    expect(header).toEqual({
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
    /** @type {Sparse.Sparse} */
    let sparse;

    beforeAll(() => {
      sparse = new Sparse.Sparse(inputData, header);
    });

    test("chunk iterator", async () => {
      const chunks = await Array.fromAsync(sparse);
      expect(chunks.length).toBe(sparse.header.totalChunks);
    });

    test("getSize", async () => {
      expect(await sparse.getSize()).toBe(sparse.header.totalBlocks * sparse.header.blockSize);
    });
  });

  describe("splitBlob", () => {
    test("compare output", async () => {
      let offset = 0;
      for await (const blob of Sparse.splitBlob(inputData)) {
        const receivedChunkBuffer = Buffer.from(new Uint8Array(await blob.arrayBuffer()));
        const [start, end] = [offset, offset + blob.size];
        offset += blob.size;
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
    test.each([1024, 8192])("splitSize: %p", async (splitSize) => {
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
