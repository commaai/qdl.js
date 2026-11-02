import { describe, expect, test } from "bun:test";
import { buf as crc32 } from "crc-32";
import { qdlDevice } from "./qdl";

test("transfer options reject invalid or unbounded settings before connecting", () => {
  for (const options of [{ transferSize: 0 }, { transferSize: 4097 }, { transferSize: 2 ** 21 },
    { transferSize: Number.NaN }, { transferSize: "131072" }, { transferQueueDepth: 0 },
    { transferQueueDepth: 65 }, { transferQueueDepth: 1.5 }, { transferQueueDepth: 9 }]) {
    expect(() => new qdlDevice(new ArrayBuffer(1), options)).toThrow();
  }
  expect(() => new qdlDevice(new ArrayBuffer(1), { transferSize: 131072, transferQueueDepth: 32 })).not.toThrow();
});

test("connect passes host transfer options without lowering the negotiated target buffer", async () => {
  const device = new qdlDevice(new ArrayBuffer(1), { transferSize: 4096, transferQueueDepth: 4 });
  const writes = [];
  const responses = [
    '<?xml version="1.0"?><data><response value="ACK"/></data>',
    '<?xml version="1.0"?><data><log value="Calling handler for configure"/><log value="Storage type set to value UFS"/><response value="ACK" MemoryName="UFS"/></data>',
    '<?xml version="1.0"?><data><response value="ACK" rawmode="true"/></data>',
    '<?xml version="1.0"?><data><response value="ACK" rawmode="false"/></data>',
  ];
  await device.connect({ connected: true,
    write: bytes => { writes.push(bytes.slice()); return Promise.resolve(); },
    read: () => Promise.resolve(new TextEncoder().encode(responses.shift())),
  });
  expect(new TextDecoder().decode(writes[0])).toContain('MaxPayloadSizeToTargetInBytes="1048576"');
  expect(await device.firehose.cmdProgram(0, 0n, new Blob([new Uint8Array(8192)]))).toBe(true);
  expect(writes.slice(2).map(bytes => bytes.length)).toEqual([4096, 4096]);
});

describe("VPD-aware erase ranges", () => {
  function eraseDevice(ufsUnmapLimits, lastLba, fail = false, backup = false) {
    const calls = [];
    const device = new qdlDevice(new ArrayBuffer(1));
    Object.defineProperty(device, "firehose", { value: { ufsUnmapLimits, cfg: { FastErase: true },
      cmdErase: (lun, start, count) => { calls.push([lun, start, count]); return Promise.resolve(!fail); } } });
    device.getGpt = async () => ({ currentLba: backup ? lastLba : 1n, alternateLba: backup ? 1n : lastLba, firstUsableLba: 6n,
      lastUsableLba: lastLba - 5n, locatePartition: name => name === "persist" ? { start: 11n, end: 19n } : undefined });
    return { device, calls };
  }

  test("coalesces only supported erases while preserving GPT, MBR and persist", async () => {
    const lastLba = 2n * 512n * 1024n + 100n;
    for (const supported of [false, true]) {
      const { device, calls } = eraseDevice(supported, lastLba);
      expect(await device.eraseLun(0)).toBe(true);
      expect(calls[0]).toEqual([0, 6n, 5]);
      let next = 20n;
      for (const [lun, start, count] of calls.slice(1)) {
        expect(lun).toBe(0);
        expect(start).toBe(next);
        expect(count).toBeLessThanOrEqual(supported ? 0xffffffff : 512 * 1024);
        next += BigInt(count);
      }
      expect(next).toBe(lastLba - 4n);
      expect(calls).toHaveLength(supported ? 2 : 4);
    }
  });

  test("splits at the wire count limit and stops immediately after failed erases", async () => {
    const large = eraseDevice(true, 0xffffffffn + 100n);
    expect(await large.device.eraseLun(0)).toBe(true);
    expect(large.calls).toEqual([[0, 6n, 5], [0, 20n, 0xffffffff], [0, 0xffffffffn + 20n, 76]]);
    const failed = eraseDevice(true, 1000n, true);
    expect(await failed.device.eraseLun(0)).toBe(false);
    expect(failed.calls).toHaveLength(1);
  });

  test("preserves identical ranges when recovering the primary GPT from the backup", async () => {
    for (const supported of [false, true]) {
      const primary = eraseDevice(supported, 1048676n);
      const backup = eraseDevice(supported, 1048676n, false, true);
      expect(await primary.device.eraseLun(0)).toBe(true);
      expect(await backup.device.eraseLun(0)).toBe(true);
      expect(backup.calls).toEqual(primary.calls);
    }
  });
});

function updateHeader(header, update) {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  update(view);
  view.setInt32(16, 0, true);
  view.setInt32(16, crc32(header.subarray(0, 92)), true);
}

function disk(start, { count = 128, primaryEntriesStart = 2n, backupEntriesStart } = {}) {
  const entryBytes = count * 128;
  const entrySectors = Math.ceil(entryBytes / 4096);
  backupEntriesStart ??= 10000n - BigInt(entrySectors);
  const entries = new Uint8Array(entrySectors * 4096);
  entries.fill(0xa5, entryBytes);
  const ev = new DataView(entries.buffer);
  ev.setUint32(0, 1, true);
  ev.setBigUint64(32, start, true);
  ev.setBigUint64(40, start + 10n, true);
  for (const [i, char] of [..."system_a"].entries()) ev.setUint16(56 + i * 2, char.charCodeAt(0), true);
  const header = new Uint8Array(4096);
  header.set(new TextEncoder().encode("EFI PART"));
  const hv = new DataView(header.buffer);
  for (const [offset, value] of [[8, 65536], [12, 92], [80, count], [84, 128]]) hv.setUint32(offset, value, true);
  for (const [offset, value] of [[24, 1n], [32, 10000n], [40, primaryEntriesStart + BigInt(entrySectors)], [48, backupEntriesStart - 1n], [72, primaryEntriesStart]]) hv.setBigUint64(offset, value, true);
  hv.setInt32(88, crc32(entries.subarray(0, entryBytes)), true);
  hv.setInt32(16, crc32(header.subarray(0, 92)), true);
  const backup = header.slice();
  const bv = new DataView(backup.buffer);
  bv.setBigUint64(24, 10000n, true);
  bv.setBigUint64(32, 1n, true);
  bv.setBigUint64(72, backupEntriesStart, true);
  bv.setInt32(16, 0, true);
  bv.setInt32(16, crc32(backup.subarray(0, 92)), true);
  return { header, backup, entries, backupEntries: entries.slice(), primaryEntriesStart, backupEntriesStart };
}

class TestDevice extends qdlDevice {
  storage = disk(100n);
  reads = 0;
  readRequests = [];
  storageInfo = { block_size: 4096, total_blocks: 10001 };
  storageInfoRequests = [];
  readBuffer(sector, count) {
    this.reads++;
    this.readRequests.push([sector, count]);
    if (sector < 0n || sector + BigInt(count) > 10001n) throw new Error("Read outside LUN");
    const result = new Uint8Array(count * 4096);
    for (const [start, data] of [[1n, this.storage.header], [10000n, this.storage.backup],
      [this.storage.primaryEntriesStart, this.storage.entries], [this.storage.backupEntriesStart, this.storage.backupEntries]]) {
      const offset = Number(start - sector) * 4096;
      const from = Math.max(0, -offset);
      const to = Math.min(data.length, result.length - offset);
      if (to > from) result.set(data.subarray(from, to), offset + from);
    }
    return Promise.resolve(result);
  }
  get firehose() {
    return {
      cfg: { SECTOR_SIZE_IN_BYTES: 4096 },
      luns: [0],
      cmdReadBuffer: (_, sector, count) => this.readBuffer(sector, count),
      cmdGetStorageInfo: lun => {
        this.storageInfoRequests.push(lun);
        return Promise.resolve([`INFO: ${JSON.stringify({ storage_info: this.storageInfo })}`]);
      },
      cmdProgram: async () => false,
      cmdReset: async () => true,
    };
  }
}

describe("partition lookup cache", () => {
  function eraseTransport(device, erase = () => true) {
    const erased = [];
    const hose = { ...device.firehose, ufsUnmapLimits: true, failed: false,
      cmdErase: async (lun, start, count) => {
        erased.push([start, count]);
        if (!await erase(lun, start, count)) return false;
        for (const [sector, bytes] of [[1n, device.storage.header], [10000n, device.storage.backup],
          [device.storage.primaryEntriesStart, device.storage.entries], [device.storage.backupEntriesStart, device.storage.backupEntries]]) {
          const from = Math.max(0, Number(start - sector) * 4096);
          const to = Math.min(bytes.length, Number(start + BigInt(count) - sector) * 4096);
          if (to > from) bytes.fill(0, from, to);
        }
        return true;
      } };
    hose.cfg.FastErase = true;
    Object.defineProperty(device, "firehose", { value: hose });
    return { hose, erased };
  }

  test("reuses validated GPTs and explicit reads refresh them", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    expect((await device.detectPartition("system_a"))[2].start).toBe(100n);
    expect(device.reads).toBe(2);
    await device.detectPartition("system_a");
    await device.detectPartition("missing");
    expect(device.reads).toBe(2);
    device.storage = disk(200n);
    await device.getGpt(0);
    expect((await device.detectPartition("system_a"))[2].start).toBe(200n);
    expect(device.reads).toBe(4);
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

  test("GPT-preserving erases retain validated metadata without reading it again", async () => {
    for (const layout of [{}, { primaryEntriesStart: 8n, backupEntriesStart: 9970n }, { count: 160 }]) {
      const device = new TestDevice(new ArrayBuffer(1));
      device.storage = disk(100n, layout);
      const copies = [device.storage.header, device.storage.entries, device.storage.backup, device.storage.backupEntries];
      const before = copies.map(bytes => bytes.slice());
      const { erased } = eraseTransport(device);
      expect(await device.eraseLun(0, ["mbr", "gpt"])).toBe(true);
      expect(erased.length).toBeGreaterThan(0);
      expect(copies).toEqual(before);
      const reads = device.reads;
      expect((await device.detectPartition("system_a"))[2].start).toBe(100n);
      expect(await device.detectPartition("missing")).toEqual([false]);
      expect(device.reads).toBe(reads);
    }
  });

  test("erasing GPT sectors invalidates partition locations", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    await device.detectPartition("system_a");
    eraseTransport(device);
    expect(await device.eraseLun(0, ["mbr"])).toBe(true);
    expect(device.storage.header.every(byte => byte === 0)).toBe(true);
    expect(device.storage.backup.every(byte => byte === 0)).toBe(true);
    await expect(device.detectPartition("system_a")).rejects.toHaveProperty("code", "GPT_CORRUPT");
  });

  test("failed erases do not restore the partition cache", async () => {
    for (const reject of [false, true]) {
      const device = new TestDevice(new ArrayBuffer(1));
      eraseTransport(device, () => { if (reject) throw new Error("erase interrupted"); return false; });
      const result = device.eraseLun(0, ["gpt"]);
      if (reject) await expect(result).rejects.toThrow("erase interrupted");
      else expect(await result).toBe(false);
      const reads = device.reads;
      device.storage = disk(200n);
      expect((await device.detectPartition("system_a"))[2].start).toBe(200n);
      expect(device.reads).toBeGreaterThan(reads);
    }
  });

  test("recovered or mismatched GPT pairs are not retained after erase", async () => {
    for (const change of [
      storage => { storage.header[0] ^= 1; },
      storage => { storage.backup[0] ^= 1; },
      storage => updateHeader(storage.backup, view => view.setBigUint64(48, 9900n, true)),
      storage => {
        storage.backupEntries[0] ^= 1;
        updateHeader(storage.backup, view => view.setInt32(88, crc32(storage.backupEntries), true));
      },
    ]) {
      const device = new TestDevice(new ArrayBuffer(1));
      change(device.storage);
      eraseTransport(device);
      expect(await device.eraseLun(0, ["gpt"])).toBe(true);
      const reads = device.reads;
      expect((await device.detectPartition("system_a"))[2].start).toBe(100n);
      expect(device.reads).toBeGreaterThan(reads);
    }
  });

  test("poisoned transports reject cached lookups and discard their metadata", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    const { hose } = eraseTransport(device);
    expect(await device.eraseLun(0, ["gpt"])).toBe(true);
    const reads = device.reads;
    hose.failed = true;
    await expect(device.detectPartition("system_a")).rejects.toThrow("power-cycle");
    expect(device.reads).toBe(reads);
    hose.failed = false;
    device.storage = disk(200n);
    expect((await device.detectPartition("system_a"))[2].start).toBe(200n);
    expect(device.reads).toBeGreaterThan(reads);
  });
});

describe("bounded GPT reads", () => {
  test("reads each usual header and entry array in one bounded window", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    expect((await device.getGpt(0)).locatePartition("system_a").start).toBe(100n);
    expect(device.readRequests).toEqual([[1n, 5], [9996n, 5]]);
    expect(device.storageInfoRequests).toEqual([]);
  });

  test("explicit backup reads end at the last sector and do not populate the full GPT cache", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    expect((await device.getGpt(0, 10000n)).currentLba).toBe(10000n);
    expect(device.readRequests).toEqual([[9996n, 5]]);
    await device.detectPartition("system_a");
    expect(device.readRequests).toEqual([[9996n, 5], [1n, 5], [9996n, 5]]);
  });

  test("uses exact separate reads for nonadjacent entry arrays", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    device.storage = disk(100n, { primaryEntriesStart: 8n, backupEntriesStart: 9970n });
    await device.getGpt(0);
    expect(device.readRequests).toEqual([[1n, 5], [8n, 4], [9996n, 5], [9970n, 4]]);
  });

  test("uses exact separate reads when the arrays exceed the window", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    device.storage = disk(100n, { count: 160 });
    await device.getGpt(0);
    expect(device.readRequests).toEqual([[1n, 5], [2n, 5], [9996n, 5], [9995n, 5]]);
  });

  test("hashes only declared entries, excluding nonzero sector padding", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    device.storage = disk(100n, { count: 33 });
    expect((await device.getGpt(0)).locatePartition("system_a").start).toBe(100n);
    expect(device.reads).toBe(2);
  });

  test("uses trusted per-LUN capacity, not corrupt primary metadata, to recover the backup", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    const view = new DataView(device.storage.header.buffer);
    view.setBigUint64(32, 0xffffffffffffffffn, true);
    view.setUint32(80, 0xffffffff, true);
    expect((await device.getGpt(3)).currentLba).toBe(10000n);
    expect(device.readRequests).toEqual([[1n, 5], [9996n, 5]]);
    expect(device.storageInfoRequests).toEqual([3]);
  });

  test("rejects invalid primary metadata before reading its entry array", async () => {
    for (const update of [
      view => view.setBigUint64(24, 2n, true),
      view => view.setBigUint64(32, 1n, true),
      view => view.setBigUint64(40, 1n, true),
      view => view.setBigUint64(48, 10000n, true),
      view => view.setBigUint64(72, 100n, true),
      view => view.setUint32(80, 0, true),
      view => view.setUint32(80, 0xffffffff, true),
      view => view.setUint32(84, 96, true),
    ]) {
      const device = new TestDevice(new ArrayBuffer(1));
      updateHeader(device.storage.header, update);
      expect((await device.getGpt(0)).currentLba).toBe(10000n);
      expect(device.readRequests).toEqual([[1n, 5], [9996n, 5]]);
      expect(device.storageInfoRequests).toEqual([0]);
    }
  });

  test("does not guess the backup LBA when trusted capacity is unavailable", async () => {
    for (const info of [null, {}, { block_size: 512, total_blocks: 10001 },
      ...[0, 2, -1, 1.5, "10001", Number.MAX_SAFE_INTEGER + 1].map(total_blocks => ({ block_size: 4096, total_blocks }))]) {
      const device = new TestDevice(new ArrayBuffer(1));
      device.storage.header[0] ^= 1;
      device.storageInfo = info;
      await expect(device.getGpt(0)).rejects.toThrow("cannot locate backup safely");
      expect(device.readRequests).toEqual([[1n, 5]]);
    }
    const device = new TestDevice(new ArrayBuffer(1));
    device.storage.header[0] ^= 1;
    device.getStorageInfo = () => Promise.reject(new Error("Unsupported command"));
    await expect(device.getGpt(0)).rejects.toThrow("cannot locate backup safely");
    expect(device.readRequests).toEqual([[1n, 5]]);
  });

  test("caps entry allocations even when CRC-valid metadata describes a larger disk", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    updateHeader(device.storage.header, view => {
      view.setBigUint64(32, 300000n, true);
      view.setBigUint64(40, 100000n, true);
      view.setBigUint64(48, 200000n, true);
      view.setUint32(80, 262145, true);
    });
    await expect(device.getGpt(0, 1n)).rejects.toThrow("Invalid GPT header");
    expect(device.readRequests).toEqual([[1n, 5]]);
  });

  test("validates recovered backup backpointers and entry bounds before reading entries", async () => {
    for (const update of [
      view => view.setBigUint64(32, 2n, true),
      view => view.setBigUint64(72, 10000n, true),
      view => view.setUint32(80, 0xffffffff, true),
    ]) {
      const device = new TestDevice(new ArrayBuffer(1));
      device.storage.header[0] ^= 1;
      updateHeader(device.storage.backup, update);
      await expect(device.getGpt(0)).rejects.toThrow("Both primary and backup");
      expect(device.readRequests).toEqual([[1n, 5], [9996n, 5]]);
    }
  });

  test("recovers corrupt primary entries from a validated backup and caches it", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    device.storage.entries[0] ^= 1;
    expect((await device.getGpt(0)).currentLba).toBe(10000n);
    expect((await device.detectPartition("system_a"))[2].start).toBe(100n);
    expect(device.reads).toBe(2);
  });

  test("retains valid primary entries when the backup header is corrupt", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    device.storage.backup[0] ^= 1;
    expect((await device.getGpt(0)).currentLba).toBe(1n);
    expect(device.readRequests).toEqual([[1n, 5], [9996n, 5]]);
  });

  test("rejects corruption of both arrays and does not retain a stale cache", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    await device.detectPartition("system_a");
    device.storage.entries[0] ^= 1;
    device.storage.backupEntries[0] ^= 1;
    const failure = device.getGpt(0);
    await expect(failure).rejects.toThrow("Both primary and backup");
    await expect(failure).rejects.toHaveProperty("code", "GPT_CORRUPT");
    device.storage = disk(200n);
    expect((await device.detectPartition("system_a"))[2].start).toBe(200n);
    expect(device.reads).toBe(6);
  });

  test("rejects corrupt entries on explicit reads", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    device.storage.entries[0] ^= 1;
    await expect(device.getGpt(0, 1n)).rejects.toThrow("GPT partition entries are corrupted");
    expect(device.reads).toBe(1);
  });

  test("rejects truncated combined and separate reads", async () => {
    for (const separate of [false, true]) {
      const device = new TestDevice(new ArrayBuffer(1));
      device.storage = disk(100n, { count: separate ? 160 : 128 });
      const read = device.readBuffer.bind(device);
      device.readBuffer = async (sector, count) => {
        const data = await read(sector, count);
        return sector === (separate ? 2n : 1n) ? data.subarray(0, data.length - 1) : data;
      };
      const failure = device.getGpt(0);
      await expect(failure).rejects.toThrow("Truncated GPT");
      await expect(failure).rejects.not.toHaveProperty("code");
      expect(device.reads).toBe(separate ? 2 : 1);
    }
  });

  test("does not classify transport failures as corrupt GPT metadata", async () => {
    const device = new TestDevice(new ArrayBuffer(1));
    const failure = new Error("USB disconnected");
    device.readBuffer = () => Promise.reject(failure);
    await expect(device.getGpt(0)).rejects.toBe(failure);
    expect(failure).not.toHaveProperty("code");
  });
});

function sparseImage(rawBlocks = 1) {
  const header = new Uint8Array(28);
  const h = new DataView(header.buffer);
  h.setUint32(0, 0xed26ff3a, true);
  h.setUint16(4, 1, true);
  h.setUint16(8, 28, true);
  h.setUint16(10, 12, true);
  h.setUint32(12, 4096, true);
  h.setUint32(16, rawBlocks + 6, true);
  h.setUint32(20, 4, true);
  const chunks = [
    [0xcac1, rawBlocks, new Uint8Array(4096 * rawBlocks).fill(7)],
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
  test("bounds oversized native Blob stream chunks without changing payload bytes", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    device.partitionSectors = 4096n;
    const image = sparseImage(2048);
    const source = new Uint8Array(await image.arrayBuffer());
    image.stream = () => new ReadableStream({ start(controller) { controller.enqueue(source); controller.close(); } });
    device.transport.cmdProgramSparse = async (_, __, plan) => {
      const reader = plan.parts[0].stream().getReader();
      let bytes = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        expect(next.value.length).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(next.value.every((value, index) => value === (bytes + index < 8 * 1024 * 1024 ? 7 : 42))).toBe(true);
        bytes += next.value.length;
      }
      expect(bytes).toBe(8 * 1024 * 1024 + 4096);
      return true;
    };
    expect(await device.flashBlob("system_a", image, undefined, false)).toBe(true);
  });

  test("cancels the Blob reader when native payload consumption stops", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    device.partitionSectors = 4096n;
    const image = sparseImage(2048);
    const source = new Uint8Array(await image.arrayBuffer());
    let sent = false;
    let cancelled = false;
    image.stream = () => new ReadableStream({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(source); }
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    device.transport.cmdProgramSparse = async (_, __, plan) => {
      const reader = plan.parts[0].stream().getReader();
      await reader.read();
      await reader.cancel();
      return false;
    };
    expect(await device.flashBlob("system_a", image, undefined, false)).toBe(false);
    expect(cancelled).toBe(true);
  });

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

describe("verified sparse streams", () => {
  test("rejects non-scalar destinations before partition reads or writes", async () => {
    for (const name of [["system_a"], ["system_a", "system_b"], [], "", null]) {
      const device = new SparseDevice(new ArrayBuffer(1));
      device.detectPartition = () => { throw new Error("Unexpected partition read"); };
      await expect(device.flashBlob(name, sparseImage())).rejects.toThrow("Expected a partition name");
      await expect(device.flashStream(name, {}, new ReadableStream())).rejects.toThrow("Expected a partition name");
      expect(device.events).toHaveLength(0);
    }
  });

  const metadata = { sectorSize: 4096, numPartitionSectors: 7, dataSectors: 2, extents: [[0n, 1n], [3n, 1n]] };
  test("reports capabilities without consuming source data", () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    expect(device.canFlashStream()).toBe(true);
    expect(device.canFlashStream(4097)).toBe(false);
    expect(device.canFlashStream(0)).toBe(false);
    expect(device.canFlashStream(4096)).toBe(true);
    device.transport.failed = true;
    expect(device.canFlashStream()).toBe(false);
  });

  test("uses validated metadata for one native command and logical progress", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    const stream = new ReadableStream();
    let plan;
    device.transport.cmdProgramSparse = (_, start, value, progress) => {
      expect(start).toBe(100n);
      plan = value;
      progress(8192);
      return Promise.resolve(true);
    };
    const progress = [];
    expect(await device.flashStream("system_a", metadata, stream, bytes => progress.push(bytes))).toBe(true);
    expect(plan.parts[0].stream()).toBe(stream);
    expect(plan.parts[0].size).toBe(8192);
    expect(plan.table.length).toBe(4096);
    expect(device.events).toEqual([["erase"]]);
    expect(progress).toEqual([16384, 28672]);
  });

  test("rejects unsupported, invalid, oversized, or locked streams before erasing", async () => {
    for (const kind of ["unsupported", "overlap", "small", "sector", "locked"]) {
      const device = new SparseDevice(new ArrayBuffer(1));
      if (kind === "unsupported") device.transport.programSparseMaxExtents = 0;
      if (kind === "small") device.partitionSectors = 6n;
      const spec = { ...metadata, extents: kind === "overlap" ? [[0n, 1n], [0n, 1n]] : metadata.extents, sectorSize: kind === "sector" ? 512 : 4096 };
      const stream = new ReadableStream();
      const reader = kind === "locked" ? stream.getReader() : null;
      await expect(device.flashStream("system_a", spec, stream)).rejects.toThrow();
      expect(device.events).toHaveLength(0);
      reader?.releaseLock();
    }
  });
});

describe("verified LZ4 streams", () => {
  const metadata = { sectorSize: 4096, numPartitionSectors: 7, dataSectors: 2,
    extents: [[0n, 1n], [3n, 1n]], compressedBytes: 16384, firstFrameBytes: 8192 };

  test("checks capability without consuming data and reports logical decoded progress", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    expect(device.canFlashLz4Stream()).toBe(false);
    device.transport.programSparseLz4 = true;
    expect(device.canFlashLz4Stream(2)).toBe(true);
    expect(device.canFlashLz4Stream(4097)).toBe(false);
    const source = new ReadableStream();
    const progress = [];
    device.transport.cmdProgramSparseLz4 = (lun, start, plan, stream, callback) => {
      expect(lun).toBe(0);
      expect(start).toBe(100n);
      expect(plan.table.length).toBe(4096);
      expect(plan.compressedBytes).toBe(metadata.compressedBytes);
      expect(stream).toBe(source);
      callback(4096);
      callback(8192);
      return Promise.resolve(true);
    };
    expect(await device.flashLz4Stream("system_a", metadata, source, value => progress.push(value))).toBe(true);
    expect(device.events).toEqual([["erase"]]);
    expect(progress).toEqual([4096, 16384, 28672]);
    device.transport.failed = true;
    expect(device.canFlashLz4Stream()).toBe(false);
  });

  test("rejects unsupported, malformed, locked or oversized streams before erasing", async () => {
    for (const kind of ["unsupported", "name", "frame", "sector", "small", "locked", "missing"]) {
      const device = new SparseDevice(new ArrayBuffer(1));
      device.transport.programSparseLz4 = kind !== "unsupported";
      if (kind === "small") device.partitionSectors = 6n;
      if (kind === "missing") device.detectPartition = () => Promise.resolve([false]);
      const plan = { ...metadata, firstFrameBytes: kind === "frame" ? 0 : metadata.firstFrameBytes,
        sectorSize: kind === "sector" ? 512 : metadata.sectorSize };
      const source = new ReadableStream();
      const reader = kind === "locked" ? source.getReader() : null;
      await expect(device.flashLz4Stream(kind === "name" ? ["system_a"] : "system_a", plan, source)).rejects.toThrow();
      expect(device.events).toHaveLength(0);
      reader?.releaseLock();
    }
  });

  test("stops after erase or native LZ4 failure without raw fallback", async () => {
    const device = new SparseDevice(new ArrayBuffer(1));
    device.transport.programSparseLz4 = true;
    device.transport.cmdErase = () => Promise.resolve(false);
    device.transport.cmdProgramSparseLz4 = () => { throw new Error("Unexpected LZ4 write"); };
    expect(await device.flashLz4Stream("system_a", metadata, new ReadableStream())).toBe(false);
    device.transport.cmdProgramSparseLz4 = () => Promise.resolve(false);
    expect(await device.flashLz4Stream("system_a", metadata, new ReadableStream(), undefined, false)).toBe(false);
    expect(device.events).toHaveLength(0);
  });
});

describe("slot activation writes", () => {
  function activationDevice(initial) {
    const events = [];
    class Device extends qdlDevice {
      get firehose() {
        return { luns: [0, 1], cmdProgram: (_, sector) => { events.push(["write", sector]); return Promise.resolve(true); },
          cmdSetBootLunId: lun => { events.push(["boot", lun]); return Promise.resolve(true); } };
      }
      getGpt(lun, sector) {
        events.push(["read", lun, sector]);
        let current = initial(lun, sector);
        return Promise.resolve({
          sectorSize: 4096, alternateLba: 100n, currentLba: sector, partEntriesStartLba: sector === 1n ? 2n : 99n,
          setActiveSlot: slot => { current = slot; },
          buildPartEntries: () => Uint8Array.of(current === "a" ? 1 : 2),
          buildHeader: () => new Uint8Array(4),
        });
      }
    }
    return { device: new Device(new ArrayBuffer(1)), events };
  }

  test("validates every primary and backup while skipping unchanged entry bytes", async () => {
    const { device, events } = activationDevice(() => "a");
    expect(await device.setActiveSlot("a")).toBe(true);
    expect(events).toEqual([["read", 0, 1n], ["read", 0, 100n], ["read", 1, 1n], ["read", 1, 100n], ["boot", 1]]);
  });

  test("writes only changed tables and activates the boot LUN after all updates", async () => {
    const { device, events } = activationDevice((lun, sector) => lun === 0 && sector === 100n ? "b" : "a");
    expect(await device.setActiveSlot("a")).toBe(true);
    expect(events.filter(event => event[0] === "write")).toEqual([["write", 99n]]);
    expect(events.at(-1)).toEqual(["boot", 1]);
  });

  test("does not activate the boot LUN after a GPT write failure", async () => {
    const { device, events } = activationDevice(() => "b");
    Object.defineProperty(device, "firehose", { value: { luns: [0], cmdProgram: () => Promise.resolve(false),
      cmdSetBootLunId: () => { events.push(["boot"]); return Promise.resolve(true); } } });
    await expect(device.setActiveSlot("a")).rejects.toThrow("Failed to update slot GPT data");
    expect(events.some(event => event[0] === "boot")).toBe(false);
  });

  test("selects boot LUN 2 for B and reports a failed boot LUN switch", async () => {
    const { device, events } = activationDevice(() => "b");
    expect(await device.setActiveSlot("b")).toBe(true);
    expect(events.at(-1)).toEqual(["boot", 2]);
    Object.defineProperty(device, "firehose", { value: { luns: [], cmdSetBootLunId: () => Promise.resolve(false) } });
    await expect(device.setActiveSlot("b")).rejects.toThrow("Failed to set active boot LUN");
  });
});

describe("adjacent GPT writes", () => {
  function writingDevice(layout) {
    const device = new TestDevice(new ArrayBuffer(1));
    device.storage = disk(100n, layout);
    const transport = device.firehose;
    const writes = [];
    let activated = false;
    Object.defineProperty(device, "firehose", { value: { ...transport,
      cmdProgram: async (lun, sector, blob) => { writes.push({ lun, sector, data: new Uint8Array(await blob.arrayBuffer()) }); return true; },
      cmdFixGpt: () => Promise.resolve(),
      cmdSetBootLunId: () => { activated = true; return Promise.resolve(true); },
    } });
    return { device, writes, activated: () => activated };
  }

  test("writes complete adjacent copies with correct header, entries and sector padding", async () => {
    const { device, writes, activated } = writingDevice({ count: 33 });
    const expected = [];
    for (const lba of [1n, 10000n]) {
      const gpt = await device.getGpt(0, lba);
      gpt.setActiveSlot("a");
      const entries = gpt.buildPartEntries();
      expected.push({ entries, header: gpt.buildHeader(entries) });
    }
    expect(await device.setActiveSlot("a")).toBe(true);
    expect(writes.map(({ sector, data }) => [sector, data.length])).toEqual([[1n, 12288], [9998n, 12288]]);
    for (const [index, { data }] of writes.entries()) {
      const headerOffset = index === 0 ? 0 : 8192;
      const entriesOffset = index === 0 ? 4096 : 0;
      expect(data.subarray(headerOffset, headerOffset + 92)).toEqual(expected[index].header);
      expect(data.subarray(headerOffset + 92, headerOffset + 4096).every(byte => byte === 0)).toBe(true);
      expect(data.subarray(entriesOffset, entriesOffset + 4224)).toEqual(expected[index].entries);
      expect(data.subarray(entriesOffset + 4224, entriesOffset + 8192).every(byte => byte === 0)).toBe(true);
    }
    expect(activated()).toBe(true);
  });

  test("nonadjacent arrays retain separate entries-before-header writes", async () => {
    const { device, writes } = writingDevice({ count: 33, primaryEntriesStart: 10n, backupEntriesStart: 9980n });
    expect(await device.setActiveSlot("a")).toBe(true);
    expect(writes.map(({ sector, data }) => [sector, data.length])).toEqual([[10n, 4224], [1n, 92], [9980n, 4224], [10000n, 92]]);
  });

  test("repair writes a single backup only after the repaired primary validates", async () => {
    const { device, writes } = writingDevice({ count: 33 });
    const primary = await device.getGpt(0, 1n);
    const backup = primary.asAlternate();
    const entries = backup.buildPartEntries();
    const header = backup.buildHeader(entries);
    expect(await device.repairGpt(0, new Blob([Uint8Array.of(7)]))).toBe(true);
    expect(writes.map(({ sector, data }) => [sector, data.length])).toEqual([[0, 1], [9998n, 12288]]);
    expect(writes[1].data.subarray(0, entries.length)).toEqual(entries);
    expect(writes[1].data.subarray(8192, 8192 + header.length)).toEqual(header);
  });

  test("failed first-copy writes leave the peer untouched and do not activate", async () => {
    const { device, activated } = writingDevice({});
    let attempted = 0;
    device.firehose.cmdProgram = () => { attempted++; return Promise.resolve(false); };
    await expect(device.setActiveSlot("a")).rejects.toThrow("Failed to update slot GPT data");
    expect(attempted).toBe(1);
    expect(device.readRequests.some(([sector]) => sector === 9996n)).toBe(true);
    expect(activated()).toBe(false);
  });

  test("validates the untouched backup before changing the primary", async () => {
    const { device, writes, activated } = writingDevice({});
    device.storage.backup[16] ^= 1;
    await expect(device.setActiveSlot("a")).rejects.toThrow();
    expect(writes).toHaveLength(0);
    expect(activated()).toBe(false);
  });
});
