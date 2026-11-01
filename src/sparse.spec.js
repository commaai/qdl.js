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

  test.skipIf(platform() !== "linux")("simg2img", async () => {
    const outputPath = `/tmp/${Bun.randomUUIDv7()}.img`;
    await simg2img(inputData.name, outputPath);
    await Bun.$`cmp ${outputPath} ${expectedPath}`;
  });
});

describe("coalesced sparse writes", () => {
  function image(chunks) {
    const header = new Uint8Array(28);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0xed26ff3a, true);
    hv.setUint16(4, 1, true);
    hv.setUint16(8, 28, true);
    hv.setUint16(10, 12, true);
    hv.setUint32(16, chunks.reduce((total, c) => total + c.blocks, 0), true);
    hv.setUint32(12, 4096, true);
    hv.setUint32(20, chunks.length, true);
    return new Blob([header, ...chunks.flatMap(({ type, blocks, data }) => {
      const chunk = new Uint8Array(12);
      const cv = new DataView(chunk.buffer);
      cv.setUint16(0, type, true);
      cv.setUint32(4, blocks, true);
      cv.setUint32(8, 12 + data.length, true);
      return [chunk, data];
    })]);
  }

  test("fills small zero ranges exactly while preserving DONT_CARE and large holes", async () => {
    const raw = new Uint8Array(4096).fill(7);
    const zero = new Uint8Array(4);
    const input = image([
      { type: 0xcac1, blocks: 1, data: raw },
      { type: 0xcac2, blocks: 1, data: zero },
      { type: 0xcac1, blocks: 1, data: raw },
      { type: 0xcac3, blocks: 1, data: new Uint8Array() },
      { type: 0xcac1, blocks: 1, data: raw },
      { type: 0xcac2, blocks: 100, data: zero },
      { type: 0xcac1, blocks: 1, data: raw },
    ]);
    const sparse = await Sparse.from(input);
    const writes = await Array.fromAsync(sparse.readCoalesced(4096));
    expect(writes.map(([offset, data, size]) => [offset / 4096, !!data, size / 4096])).toEqual([
      [0, true, 3], [3, false, 1], [4, true, 1], [5, false, 100], [105, true, 1],
    ]);
    expect(Buffer.concat(await Promise.all(writes[0][1].map(async (part) => Buffer.from(await part.arrayBuffer()))))).toEqual(Buffer.concat([raw, new Uint8Array(4096), raw]));
  });

  test("coalesced fixture has identical expanded bytes", async () => {
    const sparse = await Sparse.from(inputData);
    const result = new Uint8Array(sparse.header.totalBlocks * sparse.header.blockSize);
    for await (const [offset, data] of sparse.readCoalesced()) {
      if (data) {
        let position = offset;
        for (const part of data) {
          result.set(new Uint8Array(await part.arrayBuffer()), position);
          position += part.size;
        }
      }
    }
    expect(Buffer.from(result).equals(Buffer.from(await Bun.file(expectedPath).arrayBuffer()))).toBe(true);
  });
});
