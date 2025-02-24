import * as Bun from "bun";
import { beforeAll, describe, expect, test } from "bun:test";

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
      totalBlocks: 5,
      totalChunks: 5,
      crc32: 0,
    });
  });

  describe("Sparse", async () => {
    /** @type {Sparse.Sparse} */
    let sparse;

    beforeAll(async () => {
      const header = await Sparse.parseFileHeader(inputData);
      sparse = new Sparse.Sparse(inputData, header);
    });

    test("properties", () => {
      expect(sparse.blockSize).toBe(4096);
      expect(sparse.totalChunks).toBe(5);
    });

    test("chunk iterator", async () => {
      const chunks = await Array.fromAsync(sparse);
      expect(chunks.length).toBe(5);
    });

    test("getSize", async () => {
      expect(await sparse.getSize()).toBe(20480);
    });
  });

  test("splitBlob", async () => {
    const receivedData = new Blob(await Array.fromAsync(Sparse.splitBlob(inputData)));
    expect(receivedData.size).toEqual(expectedData.size);
    expect(Buffer.from(new Uint8Array(await receivedData.arrayBuffer())).compare(new Uint8Array(await expectedData.arrayBuffer()))).toBe(0);
  });
});
