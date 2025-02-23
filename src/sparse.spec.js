import * as Bun from "bun";
import { describe, expect, test } from "bun:test";

import * as Sparse from "./sparse";

const inputData = Bun.file("./test/fixtures/boot-sparse.img");
const expectedData = Bun.file("./test/fixtures/boot.img");

describe("sparse", () => {
  test("parseFileHeader", async () => {
    expect(await Sparse.parseSparseHeader(inputData)).toEqual({
      magic: 0xED26FF3A,
      majorVersion: 1,
      minorVersion: 0,
      size: 28,
      chunkHeaderSize: 12,
      blockSize: 2048,
      blockCount: 7827,
      chunkCount: 3,
      imageChecksum: 0,
    });
  });

  test("splitBlob", async () => {
    const receivedData = new Blob(await Array.fromAsync(Sparse.splitBlob(inputData)));
    const receivedBytes = new Uint8Array(await receivedData.arrayBuffer());
    const expectedBytes = new Uint8Array(await expectedData.arrayBuffer());
    expect(receivedBytes.byteLength).toEqual(expectedBytes.byteLength);
    expect(Buffer.from(receivedBytes).compare(Buffer.from(expectedBytes))).toBe(0);
  });
});
