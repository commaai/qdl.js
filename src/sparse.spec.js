import * as Bun from "bun";
import { describe, expect, test } from "bun:test";

import * as Sparse from "./sparse";

const inputData = Bun.file("./test/fixtures/boot-sparse.img");
const expectedData = Bun.file("./test/fixtures/boot.img");

describe("sparse", () => {
  test("parseFileHeader", async () => {
    expect(await Sparse.parseFileHeader(inputData)).toEqual({
      magic: 0xED26FF3A,
      majorVersion: 1,
      minorVersion: 0,
      fileHeaderSize: 28,
      chunkHeaderSize: 12,
      blockSize: 2048,
      totalBlocks: 7827,
      totalChunks: 3,
      crc32: 0,
    });
  });
});
