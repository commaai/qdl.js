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
