import * as Bun from "bun";
import { beforeAll, describe, expect, test } from "bun:test";
import { platform } from "node:os";

import { simg2img } from "./bin/simg2img.js";
import * as Sparse from "./sparse";

const inputData = Bun.file("./test/fixtures/sparse.img");
const expectedPath = "./test/fixtures/raw.img";

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

    test("read", async () => {
      let prevOffset = undefined;
      for await (const [offset, chunk, size] of sparse.read()) {
        expect(offset).toBeGreaterThanOrEqual(prevOffset ?? 0);
        if (chunk) expect(chunk.size).toBe(size);
        expect(size).toBeGreaterThan(0);
        prevOffset = offset + size;
      }
    });
  });

  test.each([0, 4096, 1 << 20])("runs with maxGap %d match the raw image", async (maxGap) => {
    const sparse = await Sparse.from(inputData);
    const expected = new Uint8Array(await Bun.file(expectedPath).arrayBuffer());
    const image = new Uint8Array(expected.length);
    let prevEnd = 0;
    for await (const [offset, run] of Sparse.runs(sparse, maxGap)) {
      expect(offset).toBeGreaterThanOrEqual(prevEnd);
      // read in odd-sized pieces to cross part boundaries
      for (let pos = 0; pos < run.size; pos += 3000) {
        const end = Math.min(run.size, pos + 3000);
        image.set(new Uint8Array(await run.slice(pos, end).arrayBuffer()), offset + pos);
      }
      prevEnd = offset + run.size;
    }
    expect(image).toEqual(expected);
  });

  test.skipIf(platform() !== "linux")("simg2img", async () => {
    const outputPath = `/tmp/${Bun.randomUUIDv7()}.img`;
    await simg2img(inputData.name, outputPath);
    await Bun.$`cmp ${outputPath} ${expectedPath}`;
  });
});
