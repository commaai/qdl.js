import { expect, test } from "bun:test";
import { Firehose } from "./firehose";

function programTransport(zlp = false) {
  const writes = [];
  const hose = new Firehose({ write: data => { writes.push(data); return Promise.resolve(); } });
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
  expect(writes.map(data => data.length)).toEqual([8192, 8192]);
  expect(writes[0]).toEqual(source.subarray(0, 8192));
  expect(writes[1].subarray(0, 4097)).toEqual(source.subarray(8192));
  expect(writes[1].subarray(4097).every(byte => byte === 0)).toBe(true);
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
  const hose = new Firehose({ write: data => { writes.push(data); return Promise.resolve(); } });
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
