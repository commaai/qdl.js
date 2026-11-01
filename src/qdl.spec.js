import { describe, expect, test } from "bun:test";
import { buf as crc32 } from "crc-32";
import { qdlDevice } from "./qdl";

function disk(start) {
  const entries = new Uint8Array(4096);
  const ev = new DataView(entries.buffer);
  ev.setUint32(0, 1, true);
  ev.setBigUint64(32, start, true);
  ev.setBigUint64(40, start + 10n, true);
  for (const [i, char] of [..."system_a"].entries()) ev.setUint16(56 + i * 2, char.charCodeAt(0), true);
  const header = new Uint8Array(4096);
  header.set(new TextEncoder().encode("EFI PART"));
  const hv = new DataView(header.buffer);
  for (const [offset, value] of [[8, 65536], [12, 92], [80, 32], [84, 128]]) hv.setUint32(offset, value, true);
  for (const [offset, value] of [[24, 1n], [32, 10000n], [40, 6n], [48, 9998n], [72, 2n]]) hv.setBigUint64(offset, value, true);
  hv.setInt32(88, crc32(entries), true);
  hv.setInt32(16, crc32(header.subarray(0, 92)), true);
  const backup = header.slice();
  const bv = new DataView(backup.buffer);
  bv.setBigUint64(24, 10000n, true);
  bv.setBigUint64(32, 1n, true);
  bv.setBigUint64(72, 9999n, true);
  bv.setInt32(16, 0, true);
  bv.setInt32(16, crc32(backup.subarray(0, 92)), true);
  return { header, backup, entries };
}

class TestDevice extends qdlDevice {
  storage = disk(100n);
  reads = 0;
  get firehose() {
    return {
      cfg: { SECTOR_SIZE_IN_BYTES: 4096 },
      luns: [0],
      cmdReadBuffer: (_, sector) => {
        this.reads++;
        return Promise.resolve(sector === 1n ? this.storage.header : sector === 10000n ? this.storage.backup : this.storage.entries);
      },
      cmdProgram: async () => false,
      cmdReset: async () => true,
    };
  }
}

describe("partition lookup cache", () => {
  test("reuses validated GPTs and explicit reads refresh them", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    expect((await device.detectPartition("system_a"))[2].start).toBe(100n);
    expect(device.reads).toBe(4);
    await device.detectPartition("system_a");
    await device.detectPartition("missing");
    expect(device.reads).toBe(4);
    device.storage = disk(200n);
    await device.getGpt(0);
    expect((await device.detectPartition("system_a"))[2].start).toBe(200n);
    expect(device.reads).toBe(8);
  });

  test("invalidates before a failed GPT repair", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    await device.detectPartition("system_a");
    device.storage = disk(300n);
    await expect(device.repairGpt(0, new Blob())).rejects.toThrow("Failed to write primary GPT data");
    expect((await device.detectPartition("system_a"))[2].start).toBe(300n);
  });

  test("reset invalidates the previous device's partition locations", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    await device.detectPartition("system_a");
    await device.reset();
    device.storage = disk(400n);
    expect((await device.detectPartition("system_a"))[2].start).toBe(400n);
  });
});
