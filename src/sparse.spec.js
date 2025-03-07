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

  test("from", async () => {
    const chunks = await Sparse.from(inputData.stream());
    const result = await Bun.readableStreamToArray(chunks);
    expect(result.length).toBe(result[0].header.totalChunks);
  });

  test("read", async () => {
    const chunks = await Sparse.from(inputData.stream());
    const stream = Sparse.read(chunks);
    let prevOffset = undefined;
    for (const [offset, chunk, size] of await Bun.readableStreamToArray(stream)) {
      expect(offset).toBeGreaterThanOrEqual(prevOffset ?? 0);
      if (chunk) expect(chunk.byteLength).toBe(size);
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
