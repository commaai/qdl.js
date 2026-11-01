import { describe, expect, test } from "bun:test";
import { prepareSparseProgram, validateSparseProgram } from "./sparse-program";
import { selectSparseRanges, validateSparseStreamMetadata } from "./sparse-stream";

function image(chunks) {
  const header = new Uint8Array(28);
  const v = new DataView(header.buffer);
  v.setUint32(0, 0xed26ff3a, true);
  v.setUint16(4, 1, true);
  v.setUint16(8, 28, true);
  v.setUint16(10, 12, true);
  v.setUint32(12, 4096, true);
  v.setUint32(16, chunks.reduce((sum, [_, blocks]) => sum + blocks, 0), true);
  v.setUint32(20, chunks.length, true);
  return new Blob([header, ...chunks.flatMap(([type, blocks, body]) => {
    const chunk = new Uint8Array(12);
    const view = new DataView(chunk.buffer);
    view.setUint16(0, type, true);
    view.setUint32(4, blocks, true);
    view.setUint32(8, 12 + body.length, true);
    return [chunk, body];
  })]);
}

const raw = (value, blocks = 1) => [0xcac1, blocks, new Uint8Array(blocks * 4096).fill(value)];
const fill = (blocks, bytes = [0, 0, 0, 0]) => [0xcac2, blocks, new Uint8Array(bytes)];
const skip = (blocks) => [0xcac3, blocks, new Uint8Array()];

function source(bytes, sizes = [1, 11, 4, 32, 17, 4096], state = {}) {
  let offset = 0;
  let count = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) {
        if (state.tailError) controller.error(state.tailError);
        else controller.close();
        return;
      }
      const size = sizes[count++ % sizes.length];
      controller.enqueue(bytes.subarray(offset, offset + size));
      offset = Math.min(offset + size, bytes.length);
    },
    cancel() { state.cancelled = true; },
  });
}

async function collect(stream, state = {}) {
  const reader = stream.getReader();
  const chunks = [];
  state.bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return Buffer.concat(chunks.map((part) => Buffer.from(part)));
      chunks.push(result.value);
      state.bytes += result.value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

async function fixture(chunks = [raw(7), fill(2), raw(9)]) {
  const blob = image(chunks);
  const plan = await prepareSparseProgram(blob, 4096, 10000n);
  return { blob, bytes: new Uint8Array(await blob.arrayBuffer()), metadata: { ...plan, sectorSize: 4096 } };
}

describe("continuous sparse streams", () => {
  test("selects indexed RAW payload across arbitrary input boundaries", async () => {
    const { blob, bytes, metadata } = await fixture();
    const stream = source(bytes);
    const result = await collect(selectSparseRanges(stream, metadata, blob.size));
    expect(result).toEqual(Buffer.concat([Buffer.alloc(4096, 7), Buffer.alloc(4096, 9)]));
    expect(stream.locked).toBe(false);
  });

  test("accepts equivalent adjacent target extents", async () => {
    const { blob, bytes, metadata } = await fixture([raw(8, 2)]);
    metadata.table = undefined;
    metadata.extents = [[0n, 1n], [1n, 1n]];
    expect(await collect(selectSparseRanges(source(bytes), metadata, blob.size))).toEqual(Buffer.alloc(8192, 8));
  });

  test("supports original nonzero FILL ranges without expanding the image in memory", async () => {
    const { blob, bytes, metadata } = await fixture([raw(5), fill(2, [1, 2, 3, 4]), skip(1), raw(6)]);
    const expected = Buffer.alloc(4 * 4096);
    expected.fill(5, 0, 4096);
    for (let i = 4096; i < 3 * 4096; i++) expected[i] = ((i - 4096) % 4) + 1;
    expected.fill(6, 3 * 4096);
    expect(await collect(selectSparseRanges(source(bytes), metadata, blob.size))).toEqual(expected);
  });

  test("rejects a stale source index before emitting its RAW range", async () => {
    const { blob, bytes, metadata } = await fixture();
    metadata.sourceRanges[0][0] += 4;
    const progress = {};
    await expect(collect(selectSparseRanges(source(bytes), metadata, blob.size), progress)).rejects.toThrow("source range differs");
    expect(progress.bytes).toBe(0);
  });

  test("rejects a stale target index before emitting its RAW range", async () => {
    const { blob, bytes, metadata } = await fixture();
    metadata.table = undefined;
    metadata.extents[0][0] = 1n;
    const progress = {};
    await expect(collect(selectSparseRanges(source(bytes), metadata, blob.size), progress)).rejects.toThrow("target extent differs");
    expect(progress.bytes).toBe(0);
  });

  test("checks zero FILL patterns against omitted ranges", async () => {
    const { blob, bytes, metadata } = await fixture();
    bytes[28 + 12 + 4096 + 12] = 1;
    const progress = {};
    await expect(collect(selectSparseRanges(source(bytes), metadata, blob.size), progress)).rejects.toThrow("target extent differs");
    expect(progress.bytes).toBeLessThan(metadata.dataSectors * 4096);
  });

  test("never emits the complete payload before late source verification succeeds", async () => {
    const { blob, bytes, metadata } = await fixture([raw(3, 2), fill(1)]);
    const progress = {};
    const stream = source(bytes, [bytes.length], { tailError: new Error("chunk hash mismatch") });
    await expect(collect(selectSparseRanges(stream, metadata, blob.size), progress)).rejects.toThrow("chunk hash mismatch");
    expect(progress.bytes).toBeLessThan(metadata.dataSectors * 4096);
  });

  test("rejects truncated data, truncated metadata, and trailing source bytes", async () => {
    const { blob, bytes, metadata } = await fixture();
    for (const length of [10, 28 + 12 + 100, bytes.length - 1]) {
      await expect(collect(selectSparseRanges(source(bytes.subarray(0, length)), metadata, blob.size))).rejects.toThrow("truncated source");
    }
    const extended = new Uint8Array(bytes.length + 1);
    extended.set(bytes);
    await expect(collect(selectSparseRanges(source(extended), metadata, blob.size))).rejects.toThrow("exceeds file size");
    await expect(collect(selectSparseRanges(source(extended), metadata, extended.length))).rejects.toThrow("trailing bytes");
  });

  test("cancels the upstream source and releases its reader", async () => {
    const { blob, bytes, metadata } = await fixture([raw(2, 32)]);
    const state = {};
    const input = source(bytes, [4096], state);
    const reader = selectSparseRanges(input, metadata, blob.size).getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("stopped");
    expect(state.cancelled).toBe(true);
    expect(input.locked).toBe(false);
    reader.releaseLock();
  });

  test("releases the source when cancelled before the first pull", async () => {
    const { blob, bytes, metadata } = await fixture();
    const state = {};
    const input = source(bytes, [4096], state);
    const output = selectSparseRanges(input, metadata, blob.size);
    await output.cancel("stopped immediately");
    expect(state.cancelled).toBe(true);
    expect(input.locked).toBe(false);
  });

  test("copies the index and rejects unbounded input chunks", async () => {
    const { blob, bytes, metadata } = await fixture();
    const output = selectSparseRanges(source(bytes), metadata, blob.size);
    metadata.extents[0][0] = 1n;
    metadata.sourceRanges[0][0] += 1;
    expect((await collect(output)).length).toBe(8192);
    const fresh = await fixture();
    const huge = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); controller.close(); } });
    await expect(collect(selectSparseRanges(huge, fresh.metadata, fresh.blob.size))).rejects.toThrow("oversized source chunk");
  });

  test("rejects invalid indexes before locking or consuming the source", async () => {
    const { blob, bytes, metadata } = await fixture();
    const cases = [
      { ...metadata, sourceRanges: [[0, 4096], metadata.sourceRanges[1]] },
      { ...metadata, sourceRanges: [[40, 4095], metadata.sourceRanges[1]] },
      { ...metadata, sourceRanges: [...metadata.sourceRanges].reverse() },
      { ...metadata, sourceRanges: [[40, blob.size]] },
      { ...metadata, sourceRanges: [] },
      { ...metadata, dataSectors: 3 },
    ];
    for (const invalid of cases) {
      const input = source(bytes);
      expect(() => selectSparseRanges(input, invalid, blob.size)).toThrow();
      expect(input.locked).toBe(false);
    }
  });

  test("accepts a stream-only program part", async () => {
    const { blob, bytes, metadata } = await fixture();
    const plan = { ...metadata, parts: [{ size: metadata.dataSectors * 4096, stream: () => selectSparseRanges(source(bytes), metadata, blob.size) }] };
    expect(validateSparseProgram(plan, 4096).length).toBe(4096);
    expect(validateSparseStreamMetadata(metadata, blob.size).sourceRanges).toEqual(metadata.sourceRanges);
  });
});
