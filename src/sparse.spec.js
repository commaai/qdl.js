import * as Bun from "bun";
import { beforeAll, describe, expect, test } from "bun:test";

import * as Sparse from "./sparse";
import { simg2img } from "../scripts/simg2img.js";

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

  describe("Sparse", () => {
    /** @type {Sparse.Sparse} */
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

    test.each([4096, 8192])("read(maxSize: %p)", async (splitSize) => {
      let prevLength = 0;
      for await (const data of sparse.read(splitSize)) {
        expect(data.byteLength).toBeGreaterThan(0);
        expect(data.byteLength).toBeLessThanOrEqual(splitSize);
        if (prevLength) expect(data.byteLength + prevLength).toBeGreaterThan(splitSize);
        prevLength = data.byteLength;
      }
    });
  });

  test("simg2img", async () => {
    const outputPath = `/tmp/${Bun.randomUUIDv7()}.img`;
    await simg2img(inputData.name, outputPath);
    await Bun.$`cmp ${outputPath} ${expectedData.name}`;
  });
});
