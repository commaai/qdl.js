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
