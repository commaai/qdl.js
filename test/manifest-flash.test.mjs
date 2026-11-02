import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";
import CRC32 from "crc-32";
const { buf: crc32 } = CRC32;
import { flashManifest, prepareManifest, userdataForStorage, validateManifestDestinations } from "../src/manifest-flash.js";
import { openResource, openVerifiedImage, VERIFIED_CHUNK_SIZE, verifyImageStream } from "../src/manifest-source.js";

const hash = data => createHash("sha256").update(data).digest("hex");
const metadata = bytes => ({ name: "fixture", hash: hash(bytes), fileSize: bytes.length, chunkSize: VERIFIED_CHUNK_SIZE,
  chunkHashes: Array.from({ length: Math.ceil(bytes.length / VERIFIED_CHUNK_SIZE) }, (_, i) => hash(bytes.subarray(i * VERIFIED_CHUNK_SIZE, (i + 1) * VERIFIED_CHUNK_SIZE))) });
const stream = (bytes, size = 17003) => {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    controller.enqueue(bytes.subarray(offset, offset + size));
    offset = Math.min(bytes.length, offset + size);
  } }, { highWaterMark: 0 });
};
const collect = async source => {
  const parts = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
};

test("verified stream handles split chunks, partial tail and exact-multiple EOF", async () => {
  for (const length of [VERIFIED_CHUNK_SIZE, VERIFIED_CHUNK_SIZE * 2 + 71]) {
    const bytes = Buffer.alloc(length, 42);
    assert.deepEqual(await collect(verifyImageStream(stream(bytes), metadata(bytes))), bytes);
  }
});

test("bad chunks never reach the consumer; full-hash mismatch withholds the final chunk", async () => {
  const bytes = Buffer.alloc(VERIFIED_CHUNK_SIZE + 19, 7);
  const info = metadata(bytes);
  info.chunkHashes[0] = "0".repeat(64);
  await assert.rejects(verifyImageStream(stream(bytes), info).getReader().read(), /chunk 0/);
  const reader = verifyImageStream(stream(bytes), { ...metadata(bytes), hash: "0".repeat(64) }).getReader();
  assert.equal((await reader.read()).value.length, VERIFIED_CHUNK_SIZE);
  await assert.rejects(reader.read(), /Full SHA-256/);
});

test("decoded truncation, excess and late source errors cannot complete", async () => {
  const bytes = Buffer.alloc(VERIFIED_CHUNK_SIZE + 19, 4);
  for (const invalid of [bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from([1])])]) {
    await assert.rejects(collect(verifyImageStream(stream(invalid), metadata(bytes))), /length|Truncated/);
  }
  let once = false;
  const broken = new ReadableStream({ pull(controller) {
    if (!once) { once = true; controller.enqueue(bytes); }
    else controller.error(new Error("late read error"));
  } });
  await assert.rejects(collect(verifyImageStream(broken, metadata(bytes))), /late read error/);
});

test("cancel before and during verification cancels the producer", async () => {
  for (const start of [false, true]) {
    let cancelled = false;
    const source = new ReadableStream({ pull() { /* Wait until cancelled. */ }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const reader = verifyImageStream(source, metadata(Buffer.alloc(8))).getReader();
    const pending = start ? reader.read() : undefined;
    await reader.cancel();
    await pending;
    assert.equal(cancelled, true);
    assert.equal(source.locked, false);
  }
});

test("native zstd checks archive length, content and corrupt compressed tails", async t => {
  const directory = await mkdtemp(join(tmpdir(), "qdl-zstd-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(VERIFIED_CHUNK_SIZE + 319, 6);
  const compressed = zstdCompressSync(bytes);
  const path = join(directory, "image.zst");
  await writeFile(path, compressed);
  const image = { ...metadata(bytes), archiveUrl: pathToFileURL(path), archiveSize: compressed.length };
  assert.deepEqual(await collect(await openVerifiedImage(image)), bytes);
  await assert.rejects(openVerifiedImage({ ...image, archiveSize: compressed.length - 1 }), /archive length/);
  await writeFile(path, compressed.subarray(0, -1));
  await assert.rejects(collect(await openVerifiedImage({ ...image, archiveSize: compressed.length - 1 })), /error|unexpected|truncated/i);
});

test("HTTP errors are rejected without decoding the error body", async t => {
  const server = createServer((request, response) => { response.writeHead(503); response.end("unavailable"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(openResource(new URL(`http://127.0.0.1:${server.address().port}/image`)), /HTTP 503/);
});

const storage = { block_size: 4096, page_size: 4096, num_physical: 6, mem_type: "UFS", prod_name: "SDINDDH4-128G 1", manufacturer_id: 325, total_blocks: 29775872 };
function fixture() {
  const sparse = Buffer.alloc(4136, 5);
  sparse.writeUInt32LE(0xed26ff3a, 0); sparse.writeUInt16LE(1, 4); sparse.writeUInt16LE(0, 6);
  sparse.writeUInt16LE(28, 8); sparse.writeUInt16LE(12, 10); sparse.writeUInt32LE(4096, 12);
  sparse.writeUInt32LE(1, 16); sparse.writeUInt32LE(1, 20); sparse.writeUInt32LE(0, 24);
  sparse.writeUInt16LE(0xcac1, 28); sparse.writeUInt16LE(0, 30); sparse.writeUInt32LE(1, 32); sparse.writeUInt32LE(4108, 36);
  const files = new Map();
  function image(name, bytes, extra = {}) {
    files.set(name, bytes);
    const info = metadata(bytes);
    return { name, hash: info.hash, file_size: info.fileSize, chunk_size: info.chunkSize, chunk_hashes: info.chunkHashes,
      zstd_url: `${name}.zst`, archive_size: 100, size: bytes.length, sparse: false, has_ab: false, ...extra };
  }
  const names = ["system", "boot", "xbl", "xbl_config", "abl", "userdata_90"];
  const entries = names.map(name => image(name, sparse, { size: 4096, sparse: true, has_ab: name !== "userdata_90",
    stream: { sector_size: 4096, num_partition_sectors: 1, data_sectors: 1, extents: [[0, 1]], source_ranges: [[40, 4096]] } }));
  const partitionNames = entries.flatMap(item => item.has_ab ? [`${item.name}_a`, `${item.name}_b`] : ["userdata"]);
  for (let lun = 0; lun < 6; lun++) {
    const bytes = Buffer.alloc(24576);
    const header = bytes.subarray(4096, 8192);
    header.write("EFI PART"); header.writeUInt32LE(0x10000, 8); header.writeUInt32LE(92, 12);
    header.writeBigUInt64LE(1n, 24); header.writeBigUInt64LE(BigInt(storage.total_blocks - 1), 32);
    header.writeBigUInt64LE(6n, 40); header.writeBigUInt64LE(BigInt(storage.total_blocks - 6), 48);
    header.writeBigUInt64LE(2n, 72); header.writeUInt32LE(128, 80); header.writeUInt32LE(128, 84);
    if (lun === 0) {
      ["persist", ...partitionNames].forEach((name, i) => {
        const entry = bytes.subarray(8192 + i * 128, 8192 + (i + 1) * 128);
        entry.fill(1, 0, 32);
        entry.writeBigUInt64LE(i === 0 ? 8n : BigInt(8200 + i * 10), 32);
        entry.writeBigUInt64LE(i === 0 ? 8199n : BigInt(8200 + i * 10 + 9), 40);
        entry.write(name, 56, "utf16le");
      });
    }
    header.writeInt32LE(crc32(bytes.subarray(8192)), 88);
    header.writeInt32LE(crc32(header.subarray(0, 92)), 16);
    entries.unshift(image(`gpt_main_${lun}`, bytes, { gpt: { lun, start_sector: 0, num_sectors: 6 } }));
  }
  return { entries, files };
}

test("capacity mapping includes Samsung; manifest rejects XZ, missing GPT, wrong index and duplicate names", () => {
  assert.equal(userdataForStorage(storage), "userdata_90");
  assert.equal(userdataForStorage({ ...storage, total_blocks: 29605888 }), "userdata_89");
  assert.equal(userdataForStorage({ ...storage, prod_name: "KLUDG4U1EA-B0C1", manufacturer_id: 462, total_blocks: 29765632 }), "userdata_90");
  assert.throws(() => userdataForStorage({ ...storage, total_blocks: 29765631 }), /Unsupported/);
  const { entries } = fixture();
  for (const change of [
    list => { list.at(-1).zstd_url = undefined; },
    list => list.splice(0, 1),
    list => { list.at(-1).stream.source_ranges[0][1] = 8192; },
    list => list.push(list.at(-1)),
  ]) {
    const invalid = structuredClone(entries); change(invalid);
    assert.throws(() => prepareManifest(invalid, new URL("file:///tmp/manifest.json"), storage));
  }
});

test("GPT destination validation rejects corrupt layout and oversized images", () => {
  const { entries, files } = fixture();
  const plan = prepareManifest(entries, new URL("file:///tmp/manifest.json"), storage);
  const gpts = new Map(plan.gpts.map(image => [image.gpt.lun, files.get(image.name)]));
  assert.equal(validateManifestDestinations(plan, gpts, storage).get("persist").start, 8n);
  plan.images[0].stream.numPartitionSectors = 11;
  assert.throws(() => validateManifestDestinations(plan, gpts, storage), /exceeds/);
  gpts.get(0)[16 + 4096] ^= 1;
  assert.throws(() => validateManifestDestinations(plan, gpts, storage), /GPT header/);
});

test("full flow preserves persist, erases six LUNs, streams explicit AB, and finalizes only on success", async () => {
  for (const fail of [false, true]) {
    const { entries, files } = fixture();
    const events = [];
    const device = {
      getStorageInfo() { return storage; }, canFlashStream() { return true; },
      detectPartition() { return [true, 0, { start: 8n, sectors: 8192n }]; },
      repairGpt(lun) { events.push(`gpt${lun}`); return true; },
      eraseLun(lun, preserve) { assert.deepEqual(preserve, lun === 0 ? ["mbr", "gpt", "persist"] : ["mbr", "gpt"]); events.push(`erase${lun}`); return true; },
      async flashStream(names, info, payload, progress, erase) {
        assert.equal(erase, false); assert.equal(info.dataSectors, 1);
        events.push(names.join(","));
        if (fail) throw new Error("USB write failed");
        assert.equal((await collect(payload)).length, 4096); return true;
      },
      setActiveSlot(slot) { assert.equal(slot, "a"); events.push("activate"); return true; },
      reset() { events.push("reset"); },
    };
    let cancelled = false;
    const run = flashManifest(device, entries, new URL("file:///tmp/manifest.json"), { openImage: async image => {
      const bytes = files.get(image.name);
      let offset = 0;
      return new ReadableStream({ pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + 64)); offset = Math.min(bytes.length, offset + 64);
      }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    } });
    if (fail) { await assert.rejects(run, /USB write failed/); assert.equal(cancelled, true); }
    else await run;
    assert.deepEqual(events.slice(0, 12), [...Array.from({ length: 6 }, (_, i) => `gpt${i}`), ...Array.from({ length: 6 }, (_, i) => `erase${i}`)]);
    assert.equal(events[12], "system_a,system_b");
    assert.equal(events.includes("reset"), !fail);
    assert.equal(events.includes("activate"), !fail);
  }
});

test("unsupported programmer or bad GPT fails before any device mutation", async () => {
  const { entries, files } = fixture();
  const device = { getStorageInfo() { return storage; }, canFlashStream() { return false; } };
  await assert.rejects(flashManifest(device, entries, new URL("file:///tmp/a")), /Programmer lacks/);
  device.canFlashStream = () => true;
  files.get("gpt_main_0")[4096] = 0;
  await assert.rejects(flashManifest(device, entries, new URL("file:///tmp/a"), { openImage: async image => stream(files.get(image.name)) }), /GPT header/);
});
