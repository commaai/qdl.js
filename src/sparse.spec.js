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
      totalBlocks: 5,
      totalChunks: 5,
      crc32: 0,
    });
  });

  test("splitBlob", async () => {
    const receivedData = new Blob(await Array.fromAsync(Sparse.splitBlob(inputData)));
    expect(receivedData.size).toEqual(expectedData.size);
    expect(Buffer.from(new Uint8Array(await receivedData.arrayBuffer())).compare(new Uint8Array(await expectedData.arrayBuffer()))).toBe(0);
  });
});
