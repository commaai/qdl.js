import { expect, test } from "bun:test";
import { Firehose } from "./firehose";

function programTransport(zlp = false) {
  const writes = [];
  const hose = new Firehose({ write: data => { writes.push(data.slice()); return Promise.resolve(); } });
  hose.cfg.MaxPayloadSizeToTargetInBytes = 8192;
  hose.cfg.ZLPAwareHost = Number(zlp);
  hose.xmlSend = async () => ({ resp: true });
  hose.waitForData = async () => new TextEncoder().encode('<?xml version="1.0"?><data><response value="ACK" /></data>');
  return { hose, writes };
}

test("program preserves chunk order, pads the final sector, and omits disabled ZLPs", async () => {
  const { hose, writes } = programTransport();
  const source = Uint8Array.from({ length: 8192 + 4097 }, (_, i) => i % 251);
  const progress = [];
  expect(await hose.cmdProgram(0, 0n, new Blob([source]), bytes => progress.push(bytes))).toBe(true);
  expect(writes.every(data => data.length <= 8192 && data.length % 4096 === 0)).toBe(true);
  const actual = new Uint8Array(16384);
  let offset = 0;
  for (const data of writes) { actual.set(data, offset); offset += data.length; }
  expect(offset).toBe(actual.length);
  expect(actual.subarray(0, source.length)).toEqual(source);
  expect(actual.subarray(source.length).every(byte => byte === 0)).toBe(true);
  expect(progress.at(-1)).toBe(source.length);
});

test("program retains ZLP framing when requested", async () => {
  const { hose, writes } = programTransport(true);
  await hose.cmdProgram(0, 0n, new Blob([new Uint8Array(16384)]));
  expect(writes.map(data => data.length)).toEqual([8192, 0, 8192, 0]);
});

test("configure sends the firmware's case-sensitive ZlpAwareHost setting", async () => {
  let command;
  const hose = new Firehose({ write: data => { command = new TextDecoder().decode(data); return Promise.resolve(); } });
  hose.waitForData = async () => new TextEncoder().encode('<?xml version="1.0"?><data><log value="Calling handler for configure"/><log value="Storage type set to value UFS"/><response value="ACK" MemoryName="UFS"/></data>');
  await hose.configure();
  expect(command).toContain('ZlpAwareHost="0"');
  expect(command).not.toContain('ZLPAwareHost=');
});

test("program drains queued transfers before reporting a write failure", async () => {
  const { hose } = programTransport();
  let submitted = 0;
  let active = 0;
  let peak = 0;
  hose.cdc.write = () => {
    const index = submitted++;
    peak = Math.max(peak, ++active);
    return new Promise((resolve, reject) => setTimeout(() => {
      active--;
      if (index === 2) reject(new Error("disconnected"));
      else resolve();
    }, 1));
  };
  await expect(hose.cmdProgram(0, 0n, new Blob([new Uint8Array(8192 * 20)]))).rejects.toThrow("disconnected");
  expect(active).toBe(0);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
});


test("program streams segments without padding intermediate boundaries", async () => {
  const { hose, writes } = programTransport();
  const data = Uint8Array.from({ length: 8192 * 3 + 17 }, (_, i) => i % 251);
  const parts = [new Blob([]), new Blob([data.subarray(0, 1)]), new Blob([data.subarray(1, 8193)]),
    new Blob([]), new Blob([data.subarray(8193, 20000)]), new Blob([data.subarray(20000)])];
  let sectors;
  hose.xmlSend = command => {
    sectors = Number(command.match(/num_partition_sectors="(\d+)"/)[1]);
    return Promise.resolve({ resp: true });
  };
  expect(await hose.cmdProgram(0, 0n, parts)).toBe(true);
  expect(sectors).toBe(7);
  expect(writes.map(view => view.length)).toEqual([8192, 8192, 8192, 4096]);
  const actual = new Uint8Array(7 * 4096);
  let offset = 0;
  for (const chunk of writes) { actual.set(chunk, offset); offset += chunk.length; }
  expect(actual.subarray(0, data.length)).toEqual(data);
  expect(actual.subarray(data.length).every(byte => byte === 0)).toBe(true);
});


test("program sends aligned segments directly when ZLPs are disabled", async () => {
  const { hose, writes } = programTransport();
  const parts = [new Blob([new Uint8Array(4096).fill(7)]), new Blob([new Uint8Array(4096).fill(42)])];
  expect(await hose.cmdProgram(0, 0n, parts)).toBe(true);
  expect(writes.map(view => view.length)).toEqual([4096, 4096]);
  expect(writes[0].every(byte => byte === 7)).toBe(true);
  expect(writes[1].every(byte => byte === 42)).toBe(true);
  const framed = programTransport(true);
  await framed.hose.cmdProgram(0, 0n, parts);
  expect(framed.writes.map(view => view.length)).toEqual([8192, 0]);
});

function ack(value = "ACK", rawmode = "true") {
  return new TextEncoder().encode(`<?xml version="1.0"?><data><response value="${value}" rawmode="${rawmode}"/></data>`);
}

function nativeTransport(responses = [ack(), ack("ACK", "false")]) {
  const writes = [];
  const hose = new Firehose({ write: data => { writes.push(data.slice()); return Promise.resolve(); } });
  hose.programSparseMaxExtents = 4096;
  const commands = [];
  hose.xmlSend = command => { commands.push(command); return Promise.resolve({ resp: true, data: ack() }); };
  hose.waitForData = () => Promise.resolve(responses.shift());
  const plan = { numPartitionSectors: 5, dataSectors: 2, extents: [[0n, 1n], [3n, 1n]],
    parts: [new Blob([new Uint8Array(4096).fill(7)]), new Blob([new Uint8Array(4096).fill(42)])] };
  return { hose, plan, writes, commands };
}

function lz4Fixture() {
  const wire = new Uint8Array(16384);
  for (let i = 0; i < 2; i++) {
    const header = new DataView(wire.buffer, i * 8192, 16);
    header.setUint32(0, i === 0 ? 8192 : 0, true);
    header.setUint32(4, 4096, true);
    header.setUint32(8, 4096, true);
    header.setUint32(12, 1, true);
    wire.fill(i === 0 ? 7 : 42, i * 8192 + 16, i * 8192 + 4112);
  }
  return { wire, metadata: { sectorSize: 4096, numPartitionSectors: 5, dataSectors: 2,
    extents: [[0n, 1n], [3n, 1n]], compressedBytes: wire.length, firstFrameBytes: 8192 } };
}

function wireSource(wire) {
  return new ReadableStream({ start(controller) { controller.enqueue(wire); controller.close(); } });
}

test("LZ4 programming negotiates table and wire bytes, reporting decoded completions", async () => {
  const { hose, writes, commands } = nativeTransport();
  hose.programSparseLz4 = true;
  const { wire, metadata } = lz4Fixture();
  const progress = [];
  expect(await hose.cmdProgramSparseLz4(0, 100n, metadata, wireSource(wire), bytes => progress.push(bytes))).toBe(true);
  expect(commands[0]).toContain("<program_sparse_lz4 ");
  expect(commands[0]).toContain('compressed_bytes="16384"');
  expect(commands[0]).toContain('first_frame_bytes="8192"');
  expect(commands[0]).toContain('data_sectors="2"');
  expect(writes.map(data => data.length)).toEqual([4096, wire.length]);
  expect(writes[1]).toEqual(wire);
  expect(progress.at(-1)).toBe(8192);
  expect(progress.every(bytes => bytes <= 8192)).toBe(true);
});

test("LZ4 rejects unsupported or invalid requests before sending USB commands", async () => {
  for (const kind of ["unsupported", "wire", "first", "lun", "start", "locked"]) {
    const { hose, writes, commands } = nativeTransport();
    hose.programSparseLz4 = kind !== "unsupported";
    const { wire, metadata } = lz4Fixture();
    if (kind === "wire") metadata.compressedBytes++;
    if (kind === "first") metadata.firstFrameBytes = 0;
    const source = wireSource(wire);
    const reader = kind === "locked" ? source.getReader() : null;
    await expect(hose.cmdProgramSparseLz4(kind === "lun" ? 6 : 0, kind === "start" ? -1n : 100n, metadata, source)).rejects.toThrow();
    expect(writes).toHaveLength(0);
    expect(commands).toHaveLength(0);
    reader?.releaseLock();
  }
});

test("LZ4 waits for table acceptance and never completes malformed final frames", async () => {
  const rejected = nativeTransport([ack("NAK", "false")]);
  rejected.hose.programSparseLz4 = true;
  const fixture = lz4Fixture();
  const untouched = wireSource(fixture.wire);
  expect(await rejected.hose.cmdProgramSparseLz4(0, 0n, fixture.metadata, untouched)).toBe(false);
  expect(rejected.writes).toHaveLength(1);
  expect(untouched.locked).toBe(false);

  const malformed = nativeTransport();
  malformed.hose.programSparseLz4 = true;
  malformed.hose.cfg.MaxPayloadSizeToTargetInBytes = 8192;
  let closed = false;
  malformed.hose.cdc.close = () => { closed = true; return Promise.resolve(); };
  new DataView(fixture.wire.buffer).setUint32(8192 + 12, 2, true);
  await expect(malformed.hose.cmdProgramSparseLz4(0, 0n, fixture.metadata, wireSource(fixture.wire))).rejects.toThrow("power-cycle");
  expect(malformed.writes.map(data => data.length)).toEqual([4096, 8192]);
  expect(closed).toBe(true);
  expect(malformed.hose.failed).toBe(true);
});

test("LZ4 omits the final wire frame after a late authenticated source error", async () => {
  const { hose, writes } = nativeTransport();
  hose.programSparseLz4 = true;
  hose.cfg.MaxPayloadSizeToTargetInBytes = 8192;
  hose.cdc.close = () => Promise.resolve();
  const { wire, metadata } = lz4Fixture();
  let sent = false;
  const source = new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(wire); }
    else controller.error(new Error("late chunk authentication failure"));
  } }, { highWaterMark: 0 });
  await expect(hose.cmdProgramSparseLz4(0, 0n, metadata, source)).rejects.toThrow("late chunk authentication failure");
  expect(writes.map(data => data.length)).toEqual([4096, 8192]);
  expect(hose.failed).toBe(true);
});

test("LZ4 validation errors abort USB even when source cancellation never settles", async () => {
  const { hose, writes } = nativeTransport();
  hose.programSparseLz4 = true;
  let closed = 0;
  let cancelled = 0;
  hose.cdc.close = () => { closed++; return Promise.resolve(); };
  const { wire, metadata } = lz4Fixture();
  new DataView(wire.buffer).setUint32(12, 2, true);
  const source = new ReadableStream({
    start(controller) { controller.enqueue(wire); },
    cancel() { cancelled++; return new Promise(() => undefined); },
  }, { highWaterMark: 0 });
  let timeout;
  try {
    await expect(Promise.race([
      hose.cmdProgramSparseLz4(0, 0n, metadata, source),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Cancellation stalled")), 500); }),
    ])).rejects.toThrow("invalid frame flags; power-cycle");
  } finally {
    clearTimeout(timeout);
  }
  expect(writes.map(data => data.length)).toEqual([4096]);
  expect(hose.failed).toBe(true);
  expect(closed).toBe(1);
  expect(cancelled).toBe(1);
  expect(source.locked).toBe(false);
});

test("native sparse programming waits for table acceptance before streaming packed data", async () => {
  const { hose, plan, writes, commands } = nativeTransport();
  hose.waitForData = () => {
    if (writes.length === 1) {
      expect(writes[0].length).toBe(4096);
      const table = new DataView(writes[0].buffer);
      expect([0, 8, 16, 24].map(offset => table.getBigUint64(offset, true))).toEqual([0n, 1n, 3n, 1n]);
      expect(writes[0].subarray(32).every(byte => byte === 0)).toBe(true);
      return Promise.resolve(ack());
    }
    return Promise.resolve(ack("ACK", "false"));
  };
  expect(await hose.cmdProgramSparse(0, 100n, plan)).toBe(true);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain('<program_sparse ');
  expect(commands[0]).toContain('num_partition_sectors="5"');
  expect(commands[0]).toContain('data_sectors="2"');
  expect(commands[0]).toContain('extent_count="2"');
  expect(writes.map(data => data.length)).toEqual([4096, 4096, 4096]);
  expect(writes[1].every(byte => byte === 7)).toBe(true);
  expect(writes[2].every(byte => byte === 42)).toBe(true);
});

test("native sparse programming stops on initial, table, and final protocol failures", async () => {
  const initial = nativeTransport();
  initial.hose.xmlSend = () => Promise.resolve({ resp: true, data: ack("NAK", "false") });
  expect(await initial.hose.cmdProgramSparse(0, 0n, initial.plan)).toBe(false);
  expect(initial.writes).toHaveLength(0);
  const table = nativeTransport([ack("NAK", "false")]);
  expect(await table.hose.cmdProgramSparse(0, 0n, table.plan)).toBe(false);
  expect(table.writes).toHaveLength(1);
  for (const response of [ack("NAK", "false"), ack("ACK", "true")]) {
    const final = nativeTransport([ack(), response]);
    expect(await final.hose.cmdProgramSparse(0, 0n, final.plan)).toBe(false);
  }
});

test("native sparse programming rejects invalid plans and unsupported framing before USB", async () => {
  for (const mutate of [
    plan => { plan.dataSectors = 3; },
    plan => { plan.extents[1][0] = 0n; },
    plan => { plan.numPartitionSectors = 3; },
  ]) {
    const { hose, plan, writes, commands } = nativeTransport();
    mutate(plan);
    await expect(hose.cmdProgramSparse(0, 0n, plan)).rejects.toThrow("Sparse program:");
    expect(writes).toHaveLength(0);
    expect(commands).toHaveLength(0);
  }
  for (const option of ["unsupported", "zlp"]) {
    const { hose, plan, writes } = nativeTransport();
    if (option === "unsupported") hose.programSparseMaxExtents = 0;
    else hose.cfg.ZLPAwareHost = 1;
    await expect(hose.cmdProgramSparse(0, 0n, plan)).rejects.toThrow("requires negotiated support");
    expect(writes).toHaveLength(0);
  }
});

test("configure enables native sparse only for an explicit valid capability", async () => {
  const hose = new Firehose({ write: () => Promise.resolve() });
  for (const [attribute, expected] of [["4096", 4096], ["12", 12], ["8192", 4096], ["", 0], ["true", 0], ["0", 0], ["-1", 0], ["4e3", 0], ["4096junk", 0], ["9007199254740992", 0]]) {
    hose.waitForData = () => Promise.resolve(new TextEncoder().encode(`<?xml version="1.0"?><data><log value="Calling handler for configure"/><log value="Storage type set to value UFS"/><response value="ACK" MemoryName="UFS" ProgramSparseMaxExtents="${attribute}"/></data>`));
    await hose.configure();
    expect(hose.programSparseMaxExtents).toBe(expected);
  }
  hose.waitForData = () => Promise.resolve(new TextEncoder().encode('<?xml version="1.0"?><data><log value="Calling handler for configure"/><log value="Storage type set to value UFS"/><response value="ACK" MemoryName="UFS" UnknownProgramSparse="4096"/></data>'));
  await hose.configure();
  expect(hose.programSparseMaxExtents).toBe(0);
});

test("configure requires the exact LZ4 v1 capability and a native extent limit", async () => {
  const hose = new Firehose({ write: () => Promise.resolve() });
  for (const [extents, value, expected] of [[4096, "1", true], [4096, "0", false], [4096, "2", false],
    [4096, "true", false], [4096, "01", false], [4096, undefined, false], [0, "1", false]]) {
    hose.waitForData = () => Promise.resolve(new TextEncoder().encode(`<?xml version="1.0"?><data><log value="Calling handler for configure"/><log value="Storage type set to value UFS"/><response value="ACK" MemoryName="UFS" ProgramSparseMaxExtents="${extents}" ${value === undefined ? "" : `ProgramSparseLz4="${value}"`}/></data>`));
    await hose.configure();
    expect(hose.programSparseLz4).toBe(expected);
  }
});

test("native sparse programming reports short image reads and USB failures", async () => {
  const short = nativeTransport();
  short.plan.parts[0] = { size: 4096, slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(2048)) }) };
  await expect(short.hose.cmdProgramSparse(0, 0n, short.plan)).rejects.toThrow("Short image read");
  expect(short.writes).toHaveLength(1);
  const usb = nativeTransport();
  let calls = 0;
  usb.hose.cdc.write = () => ++calls === 2 ? Promise.reject(new Error("USB write failed")) : Promise.resolve();
  await expect(usb.hose.cmdProgramSparse(0, 0n, usb.plan)).rejects.toThrow("USB write failed");
});

test("program handles arbitrary stream chunks and closes the reader", async () => {
  const { hose, writes } = programTransport();
  const data = Uint8Array.from({ length: 24593 }, (_, i) => i % 251);
  let position = 0;
  let cancelled = false;
  const sizes = [1, 3, 4092, 5, 9000, 7, 11485];
  const part = {
    size: data.length,
    slice: () => { throw new Error("Unexpected sliced read"); },
    stream: () => new ReadableStream({
      pull(controller) {
        const count = Math.min(sizes.shift() || 1024, data.length - position);
        controller.enqueue(data.slice(position, position + count));
        position += count;
        if (position === data.length) controller.close();
      },
      cancel() { cancelled = true; },
    }),
  };
  expect(await hose.cmdProgram(0, 0n, part)).toBe(true);
  const actual = new Uint8Array(28672);
  let offset = 0;
  for (const chunk of writes) { actual.set(chunk, offset); offset += chunk.length; }
  expect(offset).toBe(actual.length);
  expect(actual.subarray(0, data.length)).toEqual(data);
  expect(actual.subarray(data.length).every(byte => byte === 0)).toBe(true);
  expect(cancelled || position === data.length).toBe(true);
});

test("program cancels streaming input and drains USB on failure", async () => {
  const { hose } = programTransport();
  let cancelled = false;
  let active = 0;
  const part = {
    size: 8192 * 100,
    stream: () => new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(8192)); },
      cancel() { cancelled = true; },
    }),
  };
  hose.cdc.write = () => {
    active++;
    return new Promise((_, reject) => setTimeout(() => { active--; reject(new Error("USB failed")); }, 1));
  };
  await expect(hose.cmdProgram(0, 0n, part)).rejects.toThrow("USB failed");
  expect(active).toBe(0);
  expect(cancelled).toBe(true);
});

test("program rejects truncated or oversized streams", async () => {
  for (const size of [4096, 16384]) {
    const { hose } = programTransport();
    const part = {
      size: 8192,
      stream: () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(size)); controller.close(); } }),
    };
    await expect(hose.cmdProgram(0, 0n, part)).rejects.toThrow();
  }
});

test("streaming reuses buffers only after their USB transfers finish", async () => {
  const { hose } = programTransport();
  const buffers = new Set();
  const inFlight = new Set();
  let part = 0;
  const source = {
    size: 8192 * 32,
    stream: () => new ReadableStream({
      pull(controller) {
        if (part === 64) { controller.close(); return; }
        controller.enqueue(new Uint8Array(4096).fill(Math.floor(part++ / 2)));
      },
    }),
  };
  let written = 0;
  hose.cdc.write = data => {
    expect(inFlight.has(data.buffer)).toBe(false);
    inFlight.add(data.buffer);
    buffers.add(data.buffer);
    const expected = written++;
    return new Promise(resolve => setTimeout(() => {
      expect(data.every(byte => byte === expected)).toBe(true);
      inFlight.delete(data.buffer);
      resolve();
    }, 1));
  };
  expect(await hose.cmdProgram(0, 0n, source)).toBe(true);
  expect(written).toBe(32);
  expect(buffers.size).toBeLessThanOrEqual(8);
  expect(inFlight.size).toBe(0);
});

test("one-shot sparse streams validate EOF before submitting their final payload", async () => {
  const { hose, plan, writes } = nativeTransport();
  let finish;
  let readingEnd;
  const atEnd = new Promise(resolve => { readingEnd = resolve; });
  let reads = 0;
  const stream = {
    getReader: () => ({
      read: () => {
        if (!reads++) return Promise.resolve({ value: new Uint8Array(8192).fill(7), done: false });
        readingEnd();
        return new Promise(resolve => { finish = resolve; });
      },
      cancel: () => Promise.resolve(),
      releaseLock: () => undefined,
    }),
  };
  plan.parts = [{ size: 8192, stream: () => stream }];
  const operation = hose.cmdProgramSparse(0, 0n, plan);
  await atEnd;
  expect(writes).toHaveLength(1);
  finish({ done: true });
  expect(await operation).toBe(true);
  expect(writes.map(data => data.length)).toEqual([4096, 8192]);
});

test("one-shot stream errors close USB, reject excess bytes, and require a power cycle", async () => {
  for (const tail of ["error", "excess"]) {
    const { hose, plan, writes } = nativeTransport();
    let closed = false;
    hose.cdc.close = () => { closed = true; return Promise.resolve(); };
    let reads = 0;
    plan.parts = [{ size: 8192, stream: () => ({ getReader: () => ({
      read: () => {
        if (!reads++) return Promise.resolve({ value: new Uint8Array(8192), done: false });
        return tail === "error" ? Promise.reject(new Error("hash mismatch")) : Promise.resolve({ value: new Uint8Array(1), done: false });
      },
      cancel: () => Promise.reject(new Error("source stopped")),
      releaseLock: () => undefined,
    }) }) }];
    await expect(hose.cmdProgramSparse(0, 0n, plan)).rejects.toThrow("power-cycle");
    expect(closed).toBe(true);
    expect(hose.failed).toBe(true);
    expect(writes).toHaveLength(1);
    await expect(hose.configure()).rejects.toThrow("power-cycle");
  }
});

test("a source error closes USB before draining otherwise blocked writes", async () => {
  const { hose, plan } = nativeTransport();
  hose.cfg.MaxPayloadSizeToTargetInBytes = 4096;
  let rejectWrite;
  let closeCount = 0;
  let writes = 0;
  hose.cdc.write = () => {
    if (!writes++) return Promise.resolve();
    return new Promise((_, reject) => { rejectWrite = reject; });
  };
  hose.cdc.close = () => {
    closeCount++;
    rejectWrite(new Error("USB closed"));
    return Promise.resolve();
  };
  let reads = 0;
  plan.parts = [{ size: 8192, stream: () => ({ getReader: () => ({
    read: () => reads++ ? Promise.reject(new Error("download failed")) : Promise.resolve({ value: new Uint8Array(4096), done: false }),
    cancel: () => Promise.resolve(),
    releaseLock: () => undefined,
  }) }) }];
  await expect(hose.cmdProgramSparse(0, 0n, plan)).rejects.toThrow("download failed");
  expect(closeCount).toBe(1);
  expect(writes).toBe(2);
});

test("USB failure interrupts a stalled network read without waiting for more source bytes", async () => {
  const { hose, plan } = nativeTransport();
  hose.cfg.MaxPayloadSizeToTargetInBytes = 4096;
  let writes = 0;
  let closed = false;
  let cancelled = false;
  let finishRead;
  let reads = 0;
  hose.cdc.write = () => writes++ ? Promise.reject(new Error("USB unplugged")) : Promise.resolve();
  hose.cdc.close = () => { closed = true; return Promise.resolve(); };
  plan.parts = [{ size: 8192, stream: () => ({ getReader: () => ({
    read: () => reads++ ? new Promise(resolve => { finishRead = resolve; }) : Promise.resolve({ value: new Uint8Array(4096), done: false }),
    cancel: () => { cancelled = true; finishRead?.({ done: true }); return Promise.resolve(); },
    releaseLock: () => undefined,
  }) }) }];
  await expect(hose.cmdProgramSparse(0, 0n, plan)).rejects.toThrow("USB unplugged");
  expect(closed).toBe(true);
  expect(cancelled).toBe(true);
  expect(writes).toBe(2);
});

test("failed programming has bounded cleanup even if transport, source, and writes never settle", async () => {
  const { hose, plan } = nativeTransport();
  hose.cfg.MaxPayloadSizeToTargetInBytes = 4096;
  plan.numPartitionSectors = 8;
  plan.dataSectors = 4;
  plan.extents = [[0n, 4n]];
  let writes = 0;
  let reads = 0;
  let cancelled = false;
  hose.cdc.write = () => {
    const index = writes++;
    return index === 0 ? Promise.resolve() : index === 2 ? Promise.reject(new Error("USB failed")) : new Promise(() => undefined);
  };
  hose.cdc.close = () => new Promise(() => undefined);
  plan.parts = [{ size: 16384, stream: () => ({ getReader: () => ({
    read: () => reads++ < 2 ? Promise.resolve({ value: new Uint8Array(4096), done: false }) : new Promise(() => undefined),
    cancel: () => { cancelled = true; return new Promise(() => undefined); },
    releaseLock: () => undefined,
  }) }) }];
  await expect(hose.cmdProgramSparse(0, 0n, plan)).rejects.toThrow("USB failed");
  expect(hose.failed).toBe(true);
  expect(cancelled).toBe(true);
  expect(writes).toBe(3);
}, 7000);

test("a response timeout poisons the connection instead of queuing another IN read", async () => {
  let reads = 0;
  let closed = false;
  const hose = new Firehose({ read: () => { reads++; return new Promise(() => undefined); },
    close: () => { closed = true; return Promise.resolve(); } });
  await expect(hose.waitForData()).rejects.toThrow("power-cycle");
  expect(reads).toBe(1);
  expect(closed).toBe(true);
  await expect(hose.waitForData()).rejects.toThrow("power-cycle");
  expect(reads).toBe(1);
}, 3000);

test("a later USB failure interrupts a stalled oldest write at queue capacity", async () => {
  const { hose, plan } = nativeTransport();
  hose.cfg.MaxPayloadSizeToTargetInBytes = 4096;
  plan.numPartitionSectors = 12;
  plan.dataSectors = 12;
  plan.extents = [[0n, 12n]];
  plan.parts = [new Blob([new Uint8Array(12 * 4096)])];
  let writes = 0;
  let rejectLater;
  let closed = false;
  hose.cdc.write = () => {
    const index = writes++;
    if (index === 1) return new Promise(() => undefined);
    if (index === 2) return new Promise((_, reject) => { rejectLater = reject; });
    if (index === 8) setTimeout(() => rejectLater(new Error("later USB write failed")), 10);
    return Promise.resolve();
  };
  hose.cdc.close = () => { closed = true; return Promise.resolve(); };
  await expect(hose.cmdProgramSparse(0, 0n, plan)).rejects.toThrow("later USB write failed");
  expect(closed).toBe(true);
  expect(writes).toBe(9);
}, 5000);

test("a command write failure closes and poisons the connection before reading a reply", async () => {
  let closed = false;
  let reads = 0;
  const hose = new Firehose({ write: () => Promise.reject(new Error("command USB failure")),
    read: () => { reads++; return Promise.resolve(new Uint8Array()); },
    close: () => { closed = true; return Promise.resolve(); } });
  await expect(hose.xmlSend("command")).rejects.toThrow("command USB failure");
  expect(closed).toBe(true);
  expect(hose.failed).toBe(true);
  expect(reads).toBe(0);
});

test("a raw read timeout closes the connection without reading the final ACK", async () => {
  let reads = 0;
  let writes = 0;
  let closed = false;
  const hose = new Firehose({ write: () => { writes++; return Promise.resolve(); },
    read: () => ++reads === 1 ? Promise.resolve(ack()) : new Promise(() => undefined),
    close: () => { closed = true; return Promise.resolve(); } });
  await expect(hose.cmdReadBuffer(0, 1n, 1)).rejects.toThrow("power-cycle");
  expect(reads).toBe(2);
  expect(closed).toBe(true);
  expect(hose.failed).toBe(true);
  await expect(hose.cmdReadBuffer(0, 1n, 1)).rejects.toThrow("power-cycle");
  expect(writes).toBe(1);
}, 4000);

test("safe UNMAP coalescing requires the exact capability and resets on configure", async () => {
  const hose = new Firehose({ write: () => Promise.resolve() });
  for (const value of ['UfsUnmapLimits="1"', 'UfsUnmapLimits="0"', 'UfsUnmapLimits="2"',
    'UfsUnmapLimits="true"', 'UfsUnmapLimits="01"', 'UnknownUfsUnmapLimits="1"', '']) {
    hose.waitForData = () => Promise.resolve(new TextEncoder().encode(`<?xml version="1.0"?><data><log value="Calling handler for configure"/><log value="Storage type set to value UFS"/><response value="ACK" MemoryName="UFS" ${value}/></data>`));
    await hose.configure();
    expect(hose.ufsUnmapLimits).toBe(value === 'UfsUnmapLimits="1"');
  }
});

test("safe erase uses its own response deadline without extending other commands", async () => {
  const hose = new Firehose({ write: () => Promise.resolve() });
  const deadlines = [];
  hose.waitForData = (_, timeoutMs) => {
    deadlines.push(timeoutMs);
    return Promise.resolve(ack("ACK", "false"));
  };
  expect(await hose.cmdErase(0, 20n, 1)).toBe(true);
  hose.ufsUnmapLimits = true;
  expect(await hose.cmdErase(0, 20n, 0xffffffff)).toBe(true);
  await hose.xmlSend("<nop/>");
  expect(deadlines).toEqual([1000, 60000, 1000]);
});

test("boot LUN activation requires an explicit ACK, including responses without rawmode", async () => {
  const hose = new Firehose({ write: () => Promise.resolve() });
  for (const attributes of ['value="NAK"', 'value="NAK" rawmode="false"', '', 'value="ACK"']) {
    hose.waitForData = () => Promise.resolve(new TextEncoder().encode(`<?xml version="1.0"?><data><response ${attributes}/></data>`));
    if (attributes === 'value="ACK"') expect(await hose.cmdSetBootLunId(2)).toBe(true);
    else await expect(hose.cmdSetBootLunId(2)).rejects.toBe("Failed to set boot lun 2");
  }
});
