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

describe("explicit flash destinations", () => {
  test("uses one native program for explicit destinations and reports aggregate progress", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    device.transport.programSparseMaxCopies = 2;
    device.transport.cmdProgramSparse = (lun, start, plan, progress, secondary) => {
      device.events.push(["native", lun, start, secondary]);
      progress(4096);
      progress(8192);
      return Promise.resolve(true);
    };
    const progress = [];
    expect(await device.flashBlob(["system_a", "system_b"], sparseImage(), bytes => progress.push(bytes))).toBe(true);
    expect(device.events).toEqual([["erase"], ["erase"], ["native", 0, 100n, { physicalPartitionNumber: 0, startSector: 200n, numPartitionSectors: 100n }]]);
    expect(progress).toEqual([8192, 32768, 57344]);
  });

  test("does not infer a second destination for scalar names", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    device.transport.programSparseMaxCopies = 2;
    device.transport.cmdProgramSparse = (...args) => {
      expect(args).toHaveLength(4);
      return Promise.resolve(true);
    };
    expect(await device.flashBlob("system_a", sparseImage(), undefined, false)).toBe(true);
  });

  test("validates every explicit destination before the first erase or write", async () => {
    for (const kind of ["duplicate", "overlap", "missing", "small", "empty", "invalid"]) {
      const device = new SparseDevice(new ArrayBuffer(1));
      device.transport.programSparseMaxCopies = 2;
      const original = device.detectPartition.bind(device);
      device.detectPartition = async name => {
        const result = await original(name);
        if (name.endsWith("_b")) {
          if (kind === "overlap") result[2].start = 199n;
          if (kind === "missing") return [false];
          if (kind === "small") result[2].sectors = 6n;
        }
        return result;
      };
      const names = kind === "duplicate" ? ["system_a", "system_a"] : kind === "empty" ? [] : kind === "invalid" ? ["system_a", null] : ["system_a", "system_b"];
      await expect(device.flashBlob(names, sparseImage())).rejects.toThrow();
      expect(device.events).toHaveLength(0);
    }
  });

  test("falls back sequentially on old firmware, including aggregate progress", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    const progress = [];
    expect(await device.flashBlob(["system_a", "system_b"], sparseImage(), bytes => progress.push(bytes), false)).toBe(true);
    expect(device.events.map(event => event[0])).toEqual(["native", "native"]);
    expect(progress.every((value, i) => i === 0 || value >= progress[i - 1])).toBe(true);
    expect(progress.at(-1)).toBe(57344);
  });

  test("stops after failed erases or native writes without retrying", async () => {
    const failedErase = new SparseDevice(new ArrayBuffer(1));
    failedErase.transport.programSparseMaxCopies = 2;
    failedErase.transport.cmdErase = () => Promise.resolve(false);
    expect(await failedErase.flashBlob(["system_a", "system_b"], sparseImage())).toBe(false);
    expect(failedErase.events).toHaveLength(0);
    const failedWrite = new SparseDevice(new ArrayBuffer(1));
    failedWrite.transport.programSparseMaxCopies = 2;
    failedWrite.transport.cmdProgramSparse = () => Promise.resolve(false);
    expect(await failedWrite.flashBlob(["system_a", "system_b"], sparseImage(), undefined, false)).toBe(false);
    expect(failedWrite.events).toHaveLength(0);
  });
});

describe("verified sparse streams", () => {
  const metadata = { sectorSize: 4096, numPartitionSectors: 7, dataSectors: 2, extents: [[0n, 1n], [3n, 1n]] };
  test("reports capabilities without consuming source data", () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    device.transport.programSparseMaxCopies = 1;
    expect(device.canFlashStream()).toBe(true);
    expect(device.canFlashStream(2)).toBe(false);
    expect(device.canFlashStream(1, 4097)).toBe(false);
    device.transport.programSparseMaxCopies = 2;
    expect(device.canFlashStream(2, 4096)).toBe(true);
    device.transport.failed = true;
    expect(device.canFlashStream()).toBe(false);
  });

  test("uses validated metadata for one native command across both destinations", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    device.transport.programSparseMaxCopies = 2;
    const stream = new ReadableStream();
    let plan;
    device.transport.cmdProgramSparse = (_, start, value, progress, secondary) => {
      expect(start).toBe(100n);
      expect(secondary.startSector).toBe(200n);
      plan = value;
      progress(8192);
      return Promise.resolve(true);
    };
    const progress = [];
    expect(await device.flashStream(["system_a", "system_b"], metadata, stream, bytes => progress.push(bytes))).toBe(true);
    expect(plan.parts[0].stream()).toBe(stream);
    expect(plan.parts[0].size).toBe(8192);
    expect(plan.table.length).toBe(4096);
    expect(device.events).toEqual([["erase"], ["erase"]]);
    expect(progress).toEqual([32768, 57344]);
  });

  test("rejects unsupported, invalid, oversized, or locked streams before erasing", async () => {
    for (const kind of ["unsupported", "overlap", "small", "sector", "locked"]) {
      const device = new SparseDevice(new ArrayBuffer(1));
      device.transport.programSparseMaxCopies = kind === "unsupported" ? 1 : 2;
      if (kind === "small") device.partitionSectors = 6n;
      const spec = { ...metadata, extents: kind === "overlap" ? [[0n, 1n], [0n, 1n]] : metadata.extents, sectorSize: kind === "sector" ? 512 : 4096 };
      const stream = new ReadableStream();
      const reader = kind === "locked" ? stream.getReader() : null;
      await expect(device.flashStream(["system_a", "system_b"], spec, stream)).rejects.toThrow();
      expect(device.events).toHaveLength(0);
      reader?.releaseLock();
    }
  });
});
