import { describe, expect, test } from "bun:test";
import { validateLz4Metadata, validateLz4Stream } from "./lz4-stream.js";

const SECTOR = 4096;

function fixture(specs = [{ decoded: SECTOR }, { decoded: 2 * SECTOR, encoded: 31 }], extents = [[2n, 1n], [8n, 2n]]) {
  const frames = specs.map(({ decoded, encoded = decoded, flags = encoded === decoded ? 1 : 0, padding = 0x91 }, i) => {
    const bytes = new Uint8Array(Math.ceil((16 + encoded) / SECTOR) * SECTOR).fill(padding);
    bytes.fill(i + 1, 16, 16 + encoded);
    const header = new DataView(bytes.buffer);
    header.setUint32(4, encoded, true);
    header.setUint32(8, decoded, true);
    header.setUint32(12, flags, true);
    return bytes;
  });
  frames.forEach((frame, i) => new DataView(frame.buffer).setUint32(0, frames[i + 1]?.length ?? 0, true));
  const bytes = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of frames) { bytes.set(frame, offset); offset += frame.length; }
  return {
    bytes,
    frames,
    metadata: {
      sectorSize: SECTOR,
      numPartitionSectors: Number(extents.at(-1)[0] + extents.at(-1)[1] + 1n),
      dataSectors: Number(extents.reduce((sum, [_, length]) => sum + length, 0n)),
      extents,
      compressedBytes: bytes.length,
      firstFrameBytes: frames[0].length,
    },
  };
}

function source(bytes, sizes = [1, 15, 3, 4096, 19], state = {}) {
  let offset = 0;
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      state.reads = (state.reads ?? 0) + 1;
      if (offset === bytes.length) {
        if (state.tailError) controller.error(state.tailError);
        else controller.close();
        return;
      }
      const count = Math.min(sizes[index++ % sizes.length], bytes.length - offset);
      controller.enqueue(bytes.subarray(offset, offset + count));
      offset += count;
    },
    cancel(reason) {
      state.cancelled = true;
      state.reason = reason;
      if (state.cancelNever) return new Promise(() => { /* Model a stuck upstream cleanup. */ });
      if (state.cancelError) throw state.cancelError;
    },
  }, { highWaterMark: 0 });
}

async function collect(stream, state = {}) {
  const reader = stream.getReader();
  const chunks = [];
  state.bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks.map((part) => Buffer.from(part)));
      chunks.push(next.value);
      state.bytes += next.value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

describe("native LZ4 stream metadata", () => {
  test("validates partition bounds and copies the destination index", () => {
    const { metadata } = fixture();
    const normalized = validateLz4Metadata(metadata);
    expect(normalized.table.length).toBe(SECTOR);
    metadata.extents[0][0] = 99n;
    expect(normalized.extents[0][0]).toBe(2n);
    expect(() => validateLz4Metadata(fixture().metadata, 9n)).toThrow("image exceeds partition");
    expect(() => validateLz4Metadata(fixture().metadata, 100n, 1)).toThrow("extent count");
  });

  test("rejects invalid sizes and table padding before locking the source", () => {
    const { bytes, metadata } = fixture();
    const cases = [
      { ...metadata, sectorSize: 512 },
      { ...metadata, compressedBytes: 0 },
      { ...metadata, compressedBytes: 4097 },
      { ...metadata, compressedBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...metadata, compressedBytes: 7 * SECTOR },
      { ...metadata, firstFrameBytes: 0 },
      { ...metadata, firstFrameBytes: 4097 },
      { ...metadata, firstFrameBytes: 1024 * 1024 + 2 * SECTOR },
      { ...metadata, compressedBytes: SECTOR },
      { ...metadata, table: new Uint8Array(SECTOR).fill(1) },
      { ...metadata, extents: [[2n, 2n], [3n, 1n]] },
    ];
    for (const invalid of cases) {
      const input = source(bytes);
      expect(() => validateLz4Stream(input, invalid)).toThrow();
      expect(input.locked).toBe(false);
    }
  });
});

describe("native LZ4 frames", () => {
  test("forwards exact frames across arbitrary input boundaries, including nonzero padding", async () => {
    const { bytes, metadata, frames } = fixture();
    const marks = [];
    const input = source(bytes);
    expect(await collect(validateLz4Stream(input, metadata, mark => marks.push(mark)))).toEqual(Buffer.from(bytes));
    expect(marks).toEqual([
      { wireBytes: frames[0].length, dataBytes: SECTOR },
      { wireBytes: bytes.length, dataBytes: 3 * SECTOR },
    ]);
    expect(input.locked).toBe(false);
  });

  test("supports maximum RAW frames and multiple frames in a single extent", async () => {
    const { bytes, metadata } = fixture([{ decoded: 1024 * 1024 }, { decoded: SECTOR }], [[0n, 257n]]);
    expect(metadata.firstFrameBytes).toBe(1052672);
    expect(await collect(validateLz4Stream(source(bytes, [bytes.length]), metadata))).toEqual(Buffer.from(bytes));
  });

  test("copies metadata and emits independent frame storage", async () => {
    const { bytes, metadata, frames } = fixture();
    const input = source(bytes, [bytes.length]);
    const output = validateLz4Stream(input, metadata);
    metadata.extents[0][0] = 99n;
    metadata.firstFrameBytes = 0;
    const reader = output.getReader();
    const first = await reader.read();
    expect(first.value).toEqual(frames[0]);
    structuredClone(first.value, { transfer: [first.value.buffer] });
    expect((await reader.read()).value).toEqual(frames[1]);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  test("rejects malformed headers before emitting the affected frame", async () => {
    const mutations = [
      [0, 0, "next frame"],
      [0, SECTOR + 1, "next frame"],
      [0, 1052672 + SECTOR, "next frame"],
      [0, 2 * SECTOR, "exceeds compressed"],
      [4, 0, "encoded"],
      [4, SECTOR + 1, "encoded"],
      [4, 31, "RAW frame"],
      [8, 0, "decoded"],
      [8, SECTOR + 1, "decoded"],
      [8, 1024 * 1024 + SECTOR, "decoded"],
      [12, 2, "flags"],
    ];
    for (const [offset, value, message] of mutations) {
      const { bytes, metadata } = fixture();
      new DataView(bytes.buffer).setUint32(offset, value, true);
      const state = {};
      const progress = {};
      const input = source(bytes, [bytes.length], state);
      await expect(collect(validateLz4Stream(input, metadata), progress)).rejects.toThrow(message);
      expect(progress.bytes).toBe(0);
      expect(state.cancelled).toBe(true);
      expect(input.locked).toBe(false);
    }
  });

  test("rejects noncanonical wire sizes and frames crossing even adjacent extents", async () => {
    const first = fixture();
    const header = new DataView(first.bytes.buffer);
    header.setUint32(4, 31, true);
    header.setUint32(12, 0, true);
    await expect(collect(validateLz4Stream(source(first.bytes), first.metadata))).rejects.toThrow("wire size");
    const second = fixture([{ decoded: 2 * SECTOR }], [[0n, 1n], [1n, 1n]]);
    await expect(collect(validateLz4Stream(source(second.bytes), second.metadata))).rejects.toThrow("crosses an extent");
  });

  test("requires the chain and decoded extent totals to finish together", async () => {
    const early = fixture([{ decoded: SECTOR }], [[0n, 2n]]);
    await expect(collect(validateLz4Stream(source(early.bytes), early.metadata))).rejects.toThrow("decoded extent total");
    const late = fixture([{ decoded: SECTOR }, { decoded: SECTOR, encoded: 32 }], [[0n, 1n]]);
    // The declared wire byte bound is still valid for one sector of payload.
    const compressed = fixture([{ decoded: SECTOR, encoded: 32 }, { decoded: SECTOR, encoded: 32 }], [[0n, 1n]]);
    await expect(collect(validateLz4Stream(source(compressed.bytes), compressed.metadata))).rejects.toThrow("decoded extent total");
    expect(() => validateLz4Metadata(late.metadata)).toThrow("payload bound");
  });

  test("withholds the complete final frame until EOF and late authentication succeed", async () => {
    const { bytes, metadata, frames } = fixture();
    for (const kind of ["error", "extra", "truncated"]) {
      const progress = {};
      const state = kind === "error" ? { tailError: new Error("source hash mismatch") } : {};
      const data = kind === "extra" ? new Uint8Array([...bytes, 1]) : kind === "truncated" ? bytes.subarray(0, bytes.length - 1) : bytes;
      const input = source(data, [frames[0].length, frames[1].length], state);
      await expect(collect(validateLz4Stream(input, metadata), progress)).rejects.toThrow();
      expect(progress.bytes).toBe(frames[0].length);
      expect(input.locked).toBe(false);
    }
    const single = fixture([{ decoded: SECTOR }], [[0n, 1n]]);
    const progress = {};
    await expect(collect(validateLz4Stream(source(single.bytes, [single.bytes.length], { tailError: new Error("bad hash") }), single.metadata), progress)).rejects.toThrow("bad hash");
    expect(progress.bytes).toBe(0);
  });

  test("does not emit a malformed final frame or report it as progress", async () => {
    for (const [offset, value] of [[0, SECTOR], [4, 0], [8, 3 * SECTOR], [12, 2]]) {
      const { bytes, metadata, frames } = fixture();
      new DataView(bytes.buffer).setUint32(frames[0].length + offset, value, true);
      const progress = {};
      const marks = [];
      await expect(collect(validateLz4Stream(source(bytes), metadata, mark => marks.push(mark)), progress)).rejects.toThrow();
      expect(progress.bytes).toBe(frames[0].length);
      expect(marks.length).toBe(1);
    }
  });

  test("rejects truncated headers and bounded source violations", async () => {
    const { bytes, metadata } = fixture();
    await expect(collect(validateLz4Stream(source(bytes.subarray(0, 15)), metadata))).rejects.toThrow("truncated");
    for (const value of [new Uint8Array(4 * 1024 * 1024 + 1), "not bytes"]) {
      const input = new ReadableStream({ start(controller) { controller.enqueue(value); } });
      await expect(collect(validateLz4Stream(input, metadata))).rejects.toThrow("source chunk");
      expect(input.locked).toBe(false);
    }
  });

  test("does not prefetch or retain progress history", async () => {
    const { bytes, metadata, frames } = fixture();
    const state = {};
    const marks = [];
    const input = source(bytes, frames.map(frame => frame.length), state);
    const output = validateLz4Stream(input, metadata, mark => marks.push(mark));
    await Promise.resolve();
    expect(state.reads).toBeUndefined();
    const reader = output.getReader();
    await reader.read();
    await Promise.resolve();
    expect(state.reads).toBe(1);
    expect(marks.length).toBe(1);
    await reader.cancel("stop");
    expect(state.cancelled).toBe(true);
    expect(input.locked).toBe(false);
    reader.releaseLock();
  });

  test("cancels before the first pull and while a source read is pending", async () => {
    const { bytes, metadata } = fixture();
    const state = {};
    const input = source(bytes, [1], state);
    await validateLz4Stream(input, metadata).cancel("before pull");
    expect(state.cancelled).toBe(true);
    expect(state.reads).toBeUndefined();
    expect(input.locked).toBe(false);
    let cancelled = false;
    const pending = new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const reader = validateLz4Stream(pending, metadata).getReader();
    const read = reader.read();
    await reader.cancel("pending read");
    expect((await read).done).toBe(true);
    expect(cancelled).toBe(true);
    expect(pending.locked).toBe(false);
    reader.releaseLock();
  });

  test("cancels callback failures and preserves validation errors if cancellation fails", async () => {
    const { bytes, metadata } = fixture();
    const state = {};
    const input = source(bytes, [bytes.length], state);
    await expect(collect(validateLz4Stream(input, metadata, () => { throw new Error("progress failed"); }))).rejects.toThrow("progress failed");
    expect(state.cancelled).toBe(true);
    expect(input.locked).toBe(false);
    const bad = bytes.slice();
    new DataView(bad.buffer).setUint32(12, 9, true);
    const broken = source(bad, [bad.length], { cancelError: new Error("cleanup failed") });
    await expect(collect(validateLz4Stream(broken, metadata))).rejects.toThrow("invalid frame flags");
    expect(broken.locked).toBe(false);
  });

  test("reports malformed frames promptly when source cancellation never settles", async () => {
    for (const frameIndex of [0, 1]) {
      const { bytes, metadata, frames } = fixture();
      new DataView(bytes.buffer).setUint32((frameIndex ? frames[0].length : 0) + 12, 9, true);
      const state = { cancelNever: true };
      const input = source(bytes, [bytes.length], state);
      const reader = validateLz4Stream(input, metadata).getReader();
      let timer;
      try {
        if (frameIndex) expect((await reader.read()).value).toEqual(frames[0]);
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("validation waited for cancellation")), 1000);
        });
        await expect(Promise.race([reader.read(), deadline])).rejects.toThrow("invalid frame flags");
        expect(state.cancelled).toBe(true);
        expect(input.locked).toBe(false);
      } finally {
        clearTimeout(timer);
        reader.releaseLock();
      }
    }
  });
});
