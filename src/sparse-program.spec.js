import { describe, expect, test } from "bun:test";
import { prepareSparseProgram, validateSparseProgram } from "./sparse-program";

const RAW = 0xcac1;
const FILL = 0xcac2;
const SKIP = 0xcac3;
const CRC32 = 0xcac4;
const raw = (value = 7) => ({ type: RAW, blocks: 1, data: new Uint8Array(4096).fill(value) });
const fill = (blocks, pattern = [1, 2, 3, 4]) => ({ type: FILL, blocks, data: new Uint8Array(pattern) });
const skip = (blocks = 1) => ({ type: SKIP, blocks, data: new Uint8Array() });

function image(chunks, { blockSize = 4096, totalBlocks, totalChunks = chunks.length, changeHeader } = {}) {
  const header = new Uint8Array(28);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0xed26ff3a, true);
  view.setUint16(4, 1, true);
  view.setUint16(8, 28, true);
  view.setUint16(10, 12, true);
  view.setUint32(12, blockSize, true);
  view.setUint32(16, totalBlocks ?? chunks.reduce((sum, chunk) => sum + chunk.blocks, 0), true);
  view.setUint32(20, totalChunks, true);
  changeHeader?.(view);
  return new Blob([header, ...chunks.flatMap(({ type, blocks, data, total }) => {
    const chunk = new Uint8Array(12);
    const cv = new DataView(chunk.buffer);
    cv.setUint16(0, type, true);
    cv.setUint32(4, blocks, true);
    cv.setUint32(8, total ?? 12 + data.length, true);
    return [chunk, data];
  })]);
}

function mixedImage() {
  return image([raw(), fill(2), fill(1, [0, 0, 0, 0]), raw(8), skip(), raw(9), { type: CRC32, blocks: 0, data: new Uint8Array(4) }]);
}

describe("native sparse plans", () => {
  test("merges adjacent RAW/FILL data and preserves zero and DONT_CARE gaps", async () => {
    const plan = await prepareSparseProgram(mixedImage(), 4096, 7n);
    expect(plan.extents).toEqual([[0n, 3n], [4n, 1n], [6n, 1n]]);
    expect(plan.numPartitionSectors).toBe(7);
    expect(plan.dataSectors).toBe(5);
    expect(plan.parts.map((part) => part.size)).toEqual([4096, 8192, 4096, 4096]);
    const bytes = Buffer.concat(await Promise.all(plan.parts.map(async (part) => Buffer.from(await part.slice(0, part.size).arrayBuffer()))));
    expect(bytes.length).toBe(5 * 4096);
    expect(bytes.subarray(4096, 4104)).toEqual(Buffer.from([1, 2, 3, 4, 1, 2, 3, 4]));
    expect(bytes[3 * 4096]).toBe(8);
    expect(bytes[4 * 4096]).toBe(9);
    const table = new DataView(plan.table.buffer);
    expect(plan.table.length).toBe(4096);
    expect(table.getBigUint64(0, true)).toBe(0n);
    expect(table.getBigUint64(8, true)).toBe(3n);
    expect(table.getBigUint64(16, true)).toBe(4n);
    expect(table.getBigUint64(24, true)).toBe(1n);
    expect(plan.table.subarray(48).every((byte) => byte === 0)).toBe(true);
  });

  test("keeps multi-gigabyte nonzero fills lazy and preserves slice pattern alignment", async () => {
    const blob = image([fill(1024 * 1024)]);
    const plan = await prepareSparseProgram(blob, 4096, 1024n * 1024n);
    expect(blob.size).toBe(44);
    expect(plan.parts[0].size).toBe(4 * 1024 * 1024 * 1024);
    const bytes = new Uint8Array(await plan.parts[0].slice(4095, 4105).arrayBuffer());
    expect([...bytes]).toEqual([4, 1, 2, 3, 4, 1, 2, 3, 4, 1]);
    expect((await plan.parts[0].slice(0, 0).arrayBuffer()).byteLength).toBe(0);
    expect(() => plan.parts[0].slice(0, plan.parts[0].size + 1)).toThrow("out of bounds");
  });

  test("reuses one Blob plan but checks each A/B partition and firmware limit", async () => {
    const source = mixedImage();
    let reads = 0;
    const blob = { size: source.size, slice: (start, end) => { reads++; return source.slice(start, end); } };
    const [a, b] = await Promise.all([prepareSparseProgram(blob, 4096, 7n), prepareSparseProgram(blob, 4096, 8n)]);
    expect(a).toBe(b);
    const previousReads = reads;
    expect(await prepareSparseProgram(blob, 4096, 8n)).toBe(a);
    expect(reads).toBe(previousReads);
    await expect(prepareSparseProgram(blob, 4096, 6n)).rejects.toThrow("exceeds partition");
    expect(await prepareSparseProgram(blob, 4096, 8n, 2)).toBeNull();
    expect(await prepareSparseProgram(blob, 4096, 8n, 3)).toBe(a);
    const smallerSectors = await prepareSparseProgram(blob, 512, 56n);
    expect(smallerSectors.extents).toEqual([[0n, 24n], [32n, 8n], [48n, 8n]]);
  });

  test("falls back for raw and zero-data images, but never skips partition bounds", async () => {
    expect(await prepareSparseProgram(new Blob([new Uint8Array(2)]), 4096, 1n)).toBeNull();
    expect(await prepareSparseProgram(new Blob([new Uint8Array(4096)]), 4096, 1n)).toBeNull();
    const zero = image([fill(8, [0, 0, 0, 0]), skip(1)]);
    expect(await prepareSparseProgram(zero, 4096, 9n)).toBeNull();
    await expect(prepareSparseProgram(zero, 4096, 8n)).rejects.toThrow("exceeds partition");
  });

  test("packs all 4096 supported extents into a 64 KiB table", async () => {
    const chunks = [];
    for (let i = 0; i < 4096; i++) chunks.push(fill(1), skip());
    const plan = await prepareSparseProgram(image(chunks), 4096, 8192n);
    expect(plan.extents.length).toBe(4096);
    expect(plan.table.length).toBe(65536);
    const view = new DataView(plan.table.buffer);
    expect(view.getBigUint64(65520, true)).toBe(8190n);
    expect(view.getBigUint64(65528, true)).toBe(1n);
  });

  test("falls back above 4096 extents while still validating the entire image", async () => {
    const chunks = [];
    for (let i = 0; i < 4097; i++) chunks.push(fill(1), skip());
    const valid = image(chunks);
    expect(await prepareSparseProgram(valid, 4096, 8194n)).toBeNull();
    await expect(prepareSparseProgram(valid, 4096, 8193n)).rejects.toThrow("exceeds partition");
    await expect(prepareSparseProgram(new Blob([valid, new Uint8Array(1)]), 4096, 8194n)).rejects.toThrow("trailing bytes");
  });
});

describe("sparse image validation", () => {
  const malformed = [
    ["truncated file header", new Blob([new Uint8Array([0x3a, 0xff, 0x26, 0xed])])],
    ["unsupported sparse version", image([raw()], { changeHeader: (v) => v.setUint16(4, 2, true) })],
    ["unsupported header sizes", image([raw()], { changeHeader: (v) => v.setUint16(10, 16, true) })],
    ["invalid sparse block size", image([raw()], { blockSize: 0 })],
    ["invalid expanded image size", image([raw()], { blockSize: 512 })],
    ["chunk count exceeds image size", image([raw()], { totalChunks: 10000 })],
    ["invalid chunk byte count", image([{ ...raw(), total: 4 }])],
    ["invalid chunk byte count", image([{ ...raw(), total: 10000 }])],
    ["RAW length differs", image([{ ...raw(), blocks: 2 }])],
    ["invalid FILL chunk", image([{ type: FILL, blocks: 1, data: new Uint8Array(8) }])],
    ["invalid DONT_CARE chunk", image([{ type: SKIP, blocks: 1, data: new Uint8Array(4) }])],
    ["invalid CRC32 chunk", image([{ type: CRC32, blocks: 1, data: new Uint8Array(4) }])],
    ["unknown chunk type", image([{ type: 0xabcd, blocks: 1, data: new Uint8Array(4) }])],
    ["chunk exceeds expanded", image([raw(), raw()], { totalBlocks: 1 })],
    ["chunk blocks differ", image([raw()], { totalBlocks: 2 })],
    ["trailing bytes", new Blob([image([raw()]), new Uint8Array(1)])],
    ["unaligned or oversized chunk", image([{ type: RAW, blocks: 1, data: new Uint8Array(512) }, skip(7)], { blockSize: 512 })],
  ];
  for (const [message, blob] of malformed) {
    test(message, async () => {
      await expect(prepareSparseProgram(blob, 4096, 100000n)).rejects.toThrow(message);
    });
  }
});

describe("wire table validation", () => {
  test("rejects corrupted descriptors, byte totals, table entries, and padding", async () => {
    const valid = await prepareSparseProgram(mixedImage(), 4096, 7n);
    const withoutTable = { ...valid, table: undefined };
    const cases = [
      { ...withoutTable, extents: [[0n, 0n]] },
      { ...withoutTable, extents: [[0n, 3n], [2n, 1n], [6n, 1n]] },
      { ...withoutTable, extents: [[4n, 1n], [0n, 3n], [6n, 1n]] },
      { ...withoutTable, extents: [[0n, 3n], [4n, 1n], [7n, 1n]] },
      { ...withoutTable, extents: [[-1n, 3n]] },
      { ...withoutTable, extents: [[1n << 64n, 1n]] },
      { ...withoutTable, extents: [[0, 1.5]] },
      { ...withoutTable, dataSectors: 6 },
      { ...withoutTable, numPartitionSectors: 0 },
      { ...withoutTable, parts: valid.parts.slice(1) },
      { ...withoutTable, parts: [{ size: 1, slice: () => undefined }] },
      { ...valid, table: new Uint8Array(16) },
    ];
    for (const plan of cases) expect(() => validateSparseProgram(plan, 4096, 7n)).toThrow();
    const changedEntry = valid.table.slice();
    changedEntry[0] = 1;
    expect(() => validateSparseProgram({ ...valid, table: changedEntry }, 4096, 7n)).toThrow("table differs");
    const changedPadding = valid.table.slice();
    changedPadding[48] = 1;
    expect(() => validateSparseProgram({ ...valid, table: changedPadding }, 4096, 7n)).toThrow("padding");
    expect(() => validateSparseProgram(valid, 4096, 6n)).toThrow("exceeds partition");
    expect(() => validateSparseProgram(valid, 4096, 7n, 2)).toThrow("extent count");
    expect(() => validateSparseProgram(valid, 0, 7n)).toThrow("sector size");
    expect(() => validateSparseProgram(valid, 4096, 7n, 4097)).toThrow("extent limit");
  });
});
