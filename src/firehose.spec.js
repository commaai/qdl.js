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
