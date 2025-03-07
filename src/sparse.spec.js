import * as Bun from "bun";
import { describe, expect, test } from "bun:test";

import * as Sparse from "./sparse";
import { simg2img } from "../scripts/simg2img.js";

const inputData = Bun.file("./test/fixtures/sparse.img");
const expectedPath = "./test/fixtures/raw.img";

describe("sparse", () => {
  describe("parseFileHeader", () => {
    test("valid sparse file", async () => {
      expect(Sparse.parseFileHeader(await inputData.arrayBuffer())).toEqual({
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

    test("invalid sparse file", async () => {
      expect(Sparse.parseFileHeader(await Bun.file(expectedPath).arrayBuffer())).toBeNull();
    });
  });

  test("from", async () => {
    const sparse = await Sparse.from(inputData.stream());
    if (!sparse) throw "Failed to parse sparse";
    let expectedOffset = 0;
    for await (const [offset, data, size] of sparse) {
      expect(offset).toBe(expectedOffset);
      if (data) expect(data.byteLength).toBe(size);
      expect(size).toBeGreaterThan(0);
      expectedOffset = offset + size;
    }
  });

  test("simg2img", async () => {
    const outputPath = `/tmp/${Bun.randomUUIDv7()}.img`;
    await simg2img(inputData.name, outputPath);
    await Bun.$`cmp ${outputPath} ${expectedPath}`;
  });
});
