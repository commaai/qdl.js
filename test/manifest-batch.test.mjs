import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test as nativeTest } from "node:test";
import CRC32 from "crc-32";
import { createFirmwareBatch, firmwareDestinations, flashFirmwareBatch } from "../src/manifest-batch.js";
import { VERIFIED_CHUNK_SIZE, verifyImageStream } from "../src/manifest-source.js";

const test = process.versions.bun ? nativeTest.skip : nativeTest;
const SECTOR = 4096;

function image(name, partition, byte) {
  const bytes = Buffer.alloc(40 + SECTOR, byte);
  bytes.writeUInt32LE(0xed26ff3a, 0); bytes.writeUInt16LE(1, 4); bytes.writeUInt16LE(0, 6);
  bytes.writeUInt16LE(28, 8); bytes.writeUInt16LE(12, 10); bytes.writeUInt32LE(SECTOR, 12);
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(1, 20); bytes.writeUInt32LE(0, 24);
  bytes.writeUInt16LE(0xcac1, 28); bytes.writeUInt16LE(0, 30); bytes.writeUInt32LE(1, 32); bytes.writeUInt32LE(SECTOR + 12, 36);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, name, names: [partition], transport: "sparse", fileSize: bytes.length,
    hash, chunkSize: VERIFIED_CHUNK_SIZE, chunkHashes: [hash],
    stream: { sectorSize: SECTOR, numPartitionSectors: 1, dataSectors: 1, extents: [[0n, 1n]], sourceRanges: [[40, SECTOR]] } };
}

function fixture(slot = "a") {
  const images = [image("boot", `boot_${slot}`, 1), image("modem", "modem_a", 2), image("abl", `abl_${slot}`, 3)];
  const destinations = new Map();
  for (const [name, start, lun] of [["abl_a", 10n, 4], ["abl_b", 30n, 4], ["modem_a", 50n, 4], ["modem_b", 70n, 4],
    ["boot_a", 90n, 4], ["boot_b", 110n, 4], ["system_a", 1000n, 0], ["persist", 8n, 0], ["ddr", 64n, 3]]) {
    destinations.set(name, { name, start, sectors: 8n, end: start + 7n, lun });
  }
  const events = [];
  const device = {
    canFlashStream: count => count <= 32,
    getGpt: async lun => { if (lun !== 4) throw new Error("Expected firmware LUN"); return { sectorSize: SECTOR, firstUsableLba: 6n, lastUsableLba: 200n,
      locatePartition: name => destinations.get(name) }; },
    async detectPartition(name) {
      const gpt = await this.getGpt(4);
      const partition = gpt.locatePartition(name);
      return partition ? [true, 4, partition, gpt] : [false];
    },
    firehose: { cfg: { SECTOR_SIZE_IN_BYTES: SECTOR }, async cmdProgramSparse(lun, start, plan) {
      events.push({ lun, start, plan });
      for (const part of plan.parts) {
        let bytes = 0;
        for await (const chunk of part.stream()) bytes += chunk.length;
        if (bytes !== part.size) throw new Error("Incomplete firmware member");
      }
      return true;
    } },
  };
  return { images, destinations, device, events, slot };
}

function source(bytes, state = {}) {
  let sent = false;
  return new ReadableStream({ pull(output) {
    if (!sent) { sent = true; output.enqueue(bytes); }
    else if (state.tailError) output.error(new Error("late archive failure"));
    else output.close();
  }, cancel() { state.cancelled = true; } }, { highWaterMark: 0 });
}

function gptImage(partitions) {
  const bytes = Buffer.alloc(6 * SECTOR);
  const header = bytes.subarray(SECTOR, 2 * SECTOR);
  header.write("EFI PART"); header.writeUInt32LE(0x10000, 8); header.writeUInt32LE(92, 12);
  header.writeBigUInt64LE(1n, 24); header.writeBigUInt64LE(206n, 32);
  header.writeBigUInt64LE(6n, 40); header.writeBigUInt64LE(200n, 48);
  header.writeBigUInt64LE(2n, 72); header.writeUInt32LE(128, 80); header.writeUInt32LE(128, 84);
  partitions.forEach((partition, i) => {
    const entry = bytes.subarray(2 * SECTOR + i * 128, 2 * SECTOR + (i + 1) * 128);
    entry.fill(1, 0, 32); entry.writeBigUInt64LE(partition.start, 32); entry.writeBigUInt64LE(partition.end, 40);
    entry.write(partition.name, 56, "utf16le");
  });
  header.writeUInt32LE(CRC32.buf(bytes.subarray(2 * SECTOR)) >>> 0, 88);
  header.writeUInt32LE(CRC32.buf(header.subarray(0, 92)) >>> 0, 16);
  return bytes;
}

test("authenticated firmware GPT parser checks CRCs, names, holes and usable bounds", () => {
  const partitions = [...fixture().destinations.values()].filter(partition => partition.lun === 4);
  const bytes = gptImage(partitions);
  const parsed = firmwareDestinations(bytes);
  assert.equal(parsed.get("boot_b").start, 110n);
  assert.equal(parsed.get("modem_a").lun, 4);
  for (const offset of [SECTOR + 16, 2 * SECTOR + 56]) {
    const corrupt = Buffer.from(bytes); corrupt[offset] ^= 1;
    assert.throws(() => firmwareDestinations(corrupt), /GPT/);
  }
  assert.throws(() => firmwareDestinations(bytes.subarray(0, -1)), /length/);
  for (const [offset, value] of [[32, 1n], [48, 202n]]) {
    const invalid = Buffer.from(bytes);
    const header = invalid.subarray(SECTOR, SECTOR + 92);
    header.writeBigUInt64LE(value, offset); header.writeUInt32LE(0, 16);
    header.writeUInt32LE(CRC32.buf(header) >>> 0, 16);
    assert.throws(() => firmwareDestinations(invalid), /header/);
  }
  for (const invalid of [
    [...partitions, partitions[0]],
    [...partitions.slice(1), { ...partitions[0], name: "" }],
    [...partitions.slice(1), { ...partitions[0], start: 5n }],
    [...partitions.slice(1), { ...partitions[0], end: 201n }],
    [...partitions.slice(1), { ...partitions[0], start: 32n, end: 34n }],
  ]) assert.throws(() => firmwareDestinations(gptImage(invalid)), /partition/);
});

test("firmware batch preserves selected slot, shared modem and exact physical holes", async () => {
  for (const slot of ["a", "b"]) {
    const { images, destinations, device, events } = fixture(slot);
    images.push({ ...image("system", "system_a", 9), transport: "lz4" });
    const batch = createFirmwareBatch(device, images, destinations, slot);
    assert.deepEqual(batch.images.map(x => x.names[0]), [`abl_${slot}`, "modem_a", `boot_${slot}`]);
    assert.equal(batch.images[0], images[2]);
    assert.equal(batch.startSector, slot === "a" ? 10n : 30n);
    assert.deepEqual(batch.metadata.extents, slot === "a" ? [[0n, 1n], [40n, 1n], [80n, 1n]] : [[0n, 1n], [20n, 1n], [80n, 1n]]);
    assert.equal(batch.metadata.dataSectors, 3);
    const opened = [];
    assert.equal(await flashFirmwareBatch(device, batch, item => {
      opened.push(item.names[0]);
      return verifyImageStream(source(item.bytes), item);
    }), true);
    assert.deepEqual(opened, batch.images.map(x => x.names[0]));
    assert.equal(events[0].lun, 4);
    assert.equal(events[0].plan.parts.length, 3);
  }
});

test("firmware batching falls back for one member, unsupported extent count and excessive size", () => {
  const { images, destinations, device } = fixture();
  assert.equal(createFirmwareBatch(device, images.slice(0, 1), destinations), null);
  assert.equal(createFirmwareBatch({ ...device, canFlashStream: () => false }, images, destinations), null);
  const huge = images.map(item => ({ ...item, fileSize: 65 * 1024 * 1024 }));
  assert.equal(createFirmwareBatch(device, huge, destinations), null);
  assert.equal(createFirmwareBatch(device, images.map(item => ({ ...item, transport: "lz4" })), destinations), null);
});

test("wrong slot, shared modem, partition overlap and out-of-bounds data fail before programming", () => {
  for (const mutate of [
    f => { f.images[0].names[0] = "boot_b"; },
    f => { f.images[1].names[0] = "modem_b"; },
    f => { f.destinations.get("boot_a").start = 51n; },
    f => { f.destinations.get("boot_a").sectors = 0n; },
    f => { f.images[0].stream.extents = [[1n, 1n]]; },
    f => { f.images.push(f.images[0]); },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => createFirmwareBatch(f.device, f.images, f.destinations));
    assert.equal(f.events.length, 0);
  }
});

test("live GPT changes and sector mismatches fail before opening any source", async () => {
  for (const mutate of [
    f => { f.destinations.get("boot_a").start++; },
    f => { f.destinations.get("boot_a").sectors++; },
    f => { f.destinations.delete("boot_a"); },
    f => { f.device.firehose.cfg.SECTOR_SIZE_IN_BYTES = 512; },
    f => { f.destinations.get("boot_a").end = 201n; },
    f => { f.destinations.delete("abl_a"); },
    f => { f.device.detectPartition = () => [true, 3]; },
  ]) {
    const f = fixture();
    const batch = createFirmwareBatch(f.device, f.images, f.destinations);
    mutate(f);
    await assert.rejects(flashFirmwareBatch(f.device, batch, () => { throw new Error("source should not open"); }), /destination/);
    assert.equal(f.events.length, 0);
  }
});

test("prepared firmware geometry is immutable and forged plans never reach USB", async () => {
  const f = fixture();
  const batch = createFirmwareBatch(f.device, f.images, f.destinations);
  for (const mutate of [
    () => { batch.startSector = 0n; },
    () => { batch.metadata.extents[0][0] = 0x100000n; },
    () => { batch.members[0].partition.start = 0n; },
    () => { batch.members[0].stream.sourceRanges[0][0] = 0; },
    () => { batch.images.reverse(); },
  ]) assert.throws(mutate, TypeError);
  for (const forged of [{ ...batch, startSector: 0n }, { ...batch, metadata: { ...batch.metadata, extents: [[0n, 3n]] } }]) {
    await assert.rejects(flashFirmwareBatch(f.device, forged, () => { throw new Error("source should not open"); }), /prepared firmware batch/);
  }
  assert.equal(f.events.length, 0);
  assert.equal(batch.images[0], f.images[2]);
});

test("a corrupt or late failing member never completes or opens the next image", async () => {
  for (const mode of ["hash", "tail", "sparse"]) {
    const f = fixture();
    const batch = createFirmwareBatch(f.device, f.images, f.destinations);
    const opened = [];
    await assert.rejects(flashFirmwareBatch(f.device, batch, item => {
      opened.push(item.name);
      if (opened.length !== 2) return verifyImageStream(source(item.bytes), item);
      if (mode === "hash") return verifyImageStream(source(item.bytes), { ...item, chunkHashes: ["0".repeat(64)] });
      if (mode === "tail") return source(item.bytes, { tailError: true });
      const invalid = Buffer.from(item.bytes); invalid.writeUInt32LE(2, 16);
      return source(invalid);
    }), /mismatch|late archive failure|index/);
    assert.deepEqual(opened, ["abl", "modem"]);
  }
});

test("cancellation before opening and during a stalled read closes the active source", async () => {
  for (const stage of ["unopened", "opening", "reading"]) {
    const f = fixture();
    let opened = 0;
    let cancelled = false;
    let resolveSource;
    let started;
    const reading = new Promise(resolve => { started = resolve; });
    const input = new ReadableStream({ pull() { started(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    f.device.firehose.cmdProgramSparse = async (lun, start, plan) => {
      const reader = plan.parts[0].stream().getReader();
      const pending = stage === "unopened" ? undefined : reader.read();
      if (stage === "opening") await new Promise(resolve => setTimeout(resolve, 0));
      if (stage === "reading") await reading;
      await reader.cancel("stop");
      reader.releaseLock();
      if (stage === "opening") resolveSource(input);
      await pending;
      await new Promise(resolve => setTimeout(resolve, 0));
      return false;
    };
    const batch = createFirmwareBatch(f.device, f.images, f.destinations);
    assert.equal(await flashFirmwareBatch(f.device, batch, () => {
      opened++;
      return stage === "opening" ? new Promise(resolve => { resolveSource = resolve; }) : input;
    }), false);
    assert.equal(opened, stage === "unopened" ? 0 : 1);
    assert.equal(cancelled, stage !== "unopened");
  }
});
