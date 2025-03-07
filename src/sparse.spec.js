import * as Bun from "bun";
import { describe, expect, test } from "bun:test";

import * as Sparse from "./sparse";
import { simg2img } from "../scripts/simg2img.js";

const inputData = Bun.file("./test/fixtures/sparse.img");
const expectedPath = "./test/fixtures/raw.img";

describe("sparse", () => {
  test("parseFileHeader", async () => {
    expect(await Sparse.parseFileHeader(await inputData.arrayBuffer())).toEqual({
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

  test("readChunks", async () => {
    const chunks = await Array.fromAsync(await Sparse.readChunks(inputData.stream()));
    expect(chunks.length).toBe(chunks[0].header.totalChunks);
  });

  test("inflateChunks", async () => {
    const chunks = await Sparse.readChunks(inputData.stream());
    let prevOffset = undefined;
    for await (const [offset, data, size] of Sparse.inflateChunks(chunks)) {
      expect(offset).toBeGreaterThanOrEqual(prevOffset ?? 0);
      if (data) expect(data.byteLength).toBe(size);
      expect(size).toBeGreaterThan(0);
      prevOffset = offset + size;
    }
  });

  test("simg2img", async () => {
    const outputPath = `/tmp/${Bun.randomUUIDv7()}.img`;
    await simg2img(inputData.name, outputPath);
    await Bun.$`cmp ${outputPath} ${expectedPath}`;
  });
});
