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

function sparseImage() {
  const header = new Uint8Array(28);
  const h = new DataView(header.buffer);
  h.setUint32(0, 0xed26ff3a, true);
  h.setUint16(4, 1, true);
  h.setUint16(8, 28, true);
  h.setUint16(10, 12, true);
  h.setUint32(12, 4096, true);
  h.setUint32(16, 7, true);
  h.setUint32(20, 4, true);
  const chunks = [
    [0xcac1, 1, new Uint8Array(4096).fill(7)],
    [0xcac2, 2, new Uint8Array(4)],
    [0xcac1, 1, new Uint8Array(4096).fill(42)],
    [0xcac3, 3, new Uint8Array()],
  ];
  return new Blob([header, ...chunks.flatMap(([type, blocks, data]) => {
    const chunk = new Uint8Array(12);
    const c = new DataView(chunk.buffer);
    c.setUint16(0, type, true);
    c.setUint32(4, blocks, true);
    c.setUint32(8, 12 + data.length, true);
    return [chunk, data];
  })]);
}

class SparseDevice extends qdlDevice {
  events = [];
  partitionSectors = 100n;
  transport = {
    programSparseMaxExtents: 4096,
    cfg: { SECTOR_SIZE_IN_BYTES: 4096, ZLPAwareHost: 0 },
    cmdErase: () => { this.events.push(["erase"]); return Promise.resolve(true); },
    cmdProgram: () => { this.events.push(["legacy"]); return Promise.resolve(true); },
    cmdProgramSparse: (_, start, plan, progress) => {
      this.events.push(["native", start, plan]);
      progress?.(4096);
      progress?.(8192);
      return Promise.resolve(true);
    },
  };
  get firehose() { return this.transport; }
  detectPartition(name) {
    return Promise.resolve([true, 0, { start: name.endsWith("_b") ? 200n : 100n, sectors: this.partitionSectors }, { sectorSize: 4096 }]);
  }
}

describe("native sparse routing", () => {
  test("reuses the image plan across slots and reports progress including gaps", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    const image = sparseImage();
    const progress = [];
    expect(await device.flashBlob("system_a", image, bytes => progress.push(bytes))).toBe(true);
    expect(await device.flashBlob("system_b", image, undefined, false)).toBe(true);
    expect(device.events.map(event => event[0])).toEqual(["erase", "native", "native"]);
    const [first, second] = device.events.filter(event => event[0] === "native");
    expect(first[1]).toBe(100n);
    expect(second[1]).toBe(200n);
    expect(first[2]).toBe(second[2]);
    expect(first[2].extents).toEqual([[0n, 1n], [3n, 1n]]);
    expect(progress).toEqual([4096, 16384, 28672]);
  });

  test("uses legacy programming without support, with ZLP framing, or above the extent limit", async () => {
    for (const [limit, zlp] of [[0, 0], [4096, 1], [1, 0]]) {
      const device = new SparseDevice(new ArrayBuffer(1));
      device.transport.programSparseMaxExtents = limit;
      device.transport.cfg.ZLPAwareHost = zlp;
      expect(await device.flashBlob("system_a", sparseImage(), undefined, false)).toBe(true);
      expect(device.events.every(event => event[0] === "legacy")).toBe(true);
      expect(device.events.length).toBeGreaterThan(0);
    }
  });

  test("checks the destination bounds again before erasing a second slot", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    const image = sparseImage();
    await device.flashBlob("system_a", image, undefined, false);
    device.events = [];
    device.partitionSectors = 6n;
    await expect(device.flashBlob("system_b", image)).rejects.toThrow("image exceeds partition");
    expect(device.events).toHaveLength(0);
  });

  test("does not retry legacy programming after a native command failure", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    device.transport.cmdProgramSparse = () => Promise.resolve(false);
    expect(await device.flashBlob("system_a", sparseImage(), undefined, false)).toBe(false);
    expect(device.events).toHaveLength(0);
  });
});
