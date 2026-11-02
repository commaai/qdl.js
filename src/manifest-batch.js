import { GPT } from "./gpt.js";
import { validateSparseProgramMetadata } from "./sparse-program.js";
import { selectSparseRanges, validateSparseStreamMetadata } from "./sparse-stream.js";

const SECTOR_SIZE = 4096;
const MAX_BATCH_BYTES = 128 * 1024 * 1024;
const batches = new WeakSet();

function freezeIndex(stream) {
  for (const field of ["extents", "sourceRanges"]) if (stream[field]) {
    for (const row of stream[field]) Object.freeze(row);
    Object.freeze(stream[field]);
  }
  return Object.freeze(stream);
}

/** Read destinations from an authenticated primary LUN4 GPT image. */
export function firmwareDestinations(input) {
  const bytes = new Uint8Array(input);
  if (bytes.length !== 6 * SECTOR_SIZE) throw new Error("Invalid firmware GPT image length");
  const gpt = new GPT(SECTOR_SIZE);
  const header = gpt.parseHeader(bytes.subarray(SECTOR_SIZE, 2 * SECTOR_SIZE), 1n);
  if (!header || header.mismatchCrc32 || gpt.currentLba !== 1n || gpt.partEntriesStartLba !== 2n
    || gpt.numPartEntries < 1 || gpt.numPartEntries > 128 || gpt.partEntrySize !== 128
    || gpt.firstUsableLba < 6n || gpt.lastUsableLba < gpt.firstUsableLba
    || gpt.alternateLba <= gpt.currentLba
    || gpt.lastUsableLba >= gpt.alternateLba - BigInt(gpt.partEntriesSectors)) throw new Error("Invalid firmware GPT header");
  if (gpt.parsePartEntries(bytes.subarray(2 * SECTOR_SIZE)).mismatchCrc32) throw new Error("Invalid firmware GPT entries");
  const destinations = new Map();
  let end = gpt.firstUsableLba;
  for (const partition of gpt.getPartitions().sort((a, b) => a.start < b.start ? -1 : 1)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(partition.name) || destinations.has(partition.name)
      || partition.start < end || partition.sectors <= 0n || partition.end > gpt.lastUsableLba) throw new Error(`Invalid firmware partition: ${partition.name}`);
    destinations.set(partition.name, { ...partition, lun: 4 });
    end = partition.end + 1n;
  }
  return destinations;
}

/** Group selected raw LUN4 firmware images after validating the manifest GPTs. */
export function createFirmwareBatch(device, images, destinations, slot = "a") {
  if (slot !== "a" && slot !== "b") throw new Error("Expected slot a or b");
  const selected = images.filter(image => image.transport === "sparse"
    && image.names.length === 1 && destinations.get(image.names[0])?.lun === 4);
  if (selected.length < 2) return null;
  const members = selected.map(image => {
    const name = image.names[0];
    const base = name.replace(/_[ab]$/, "");
    if (base !== name && destinations.has(`${base}_a`) && destinations.has(`${base}_b`)
      && name !== `${base}_${base === "modem" ? "a" : slot}`) throw new Error(`Invalid firmware destination: ${name}`);
    const hasSlots = destinations.has(`${image.name}_a`) || destinations.has(`${image.name}_b`);
    const expected = hasSlots ? `${image.name}_${image.name === "modem" ? "a" : slot}` : image.name;
    if (name !== expected || ["persist", "ddr", "system", "userdata"].includes(image.name)) throw new Error(`Invalid firmware destination: ${name}`);
    const partition = Object.freeze({ ...destinations.get(name) });
    const stream = freezeIndex(validateSparseStreamMetadata(image.stream, image.fileSize));
    if (stream.sectorSize !== SECTOR_SIZE || partition.start < 6n || partition.sectors <= 0n
      || BigInt(stream.numPartitionSectors) > partition.sectors) throw new Error(`Firmware exceeds destination: ${name}`);
    return Object.freeze({ image, name, fileSize: image.fileSize, partition, stream });
  }).sort((a, b) => a.partition.start < b.partition.start ? -1 : 1);
  const startSector = members[0].partition.start;
  let end = startSector;
  let partitionEnd = startSector;
  let dataSectors = 0;
  const extents = [];
  const names = new Set();
  for (const { image, partition, stream } of members) {
    if (names.has(image.names[0]) || partition.start < partitionEnd) throw new Error("Overlapping firmware partitions");
    names.add(image.names[0]);
    partitionEnd = partition.start + partition.sectors;
    for (const [offset, count] of stream.extents) {
      const start = partition.start + offset;
      if (start < end || start + count > partitionEnd) throw new Error("Overlapping or out-of-bounds firmware extent");
      extents.push([start - startSector, count]);
      end = start + count;
    }
    dataSectors += stream.dataSectors;
  }
  if (dataSectors * SECTOR_SIZE > MAX_BATCH_BYTES
    || members.reduce((sum, member) => sum + member.image.fileSize, 0) > MAX_BATCH_BYTES
    || !device.canFlashStream(extents.length)) return null;
  const metadata = { sectorSize: SECTOR_SIZE, numPartitionSectors: Number(end - startSector), dataSectors, extents };
  validateSparseProgramMetadata(metadata, SECTOR_SIZE);
  const batch = Object.freeze({ images: Object.freeze(members.map(member => member.image)), members: Object.freeze(members), startSector, metadata: freezeIndex(metadata) });
  batches.add(batch);
  return batch;
}

function lazyPayload(member, getSource) {
  let reader;
  let opening;
  let cancelled = false;
  const close = reason => {
    const current = reader;
    reader = undefined;
    if (!current) return;
    try { return current.cancel(reason); } finally { current.releaseLock(); }
  };
  return new ReadableStream({
    async pull(output) {
      try {
        opening ??= Promise.resolve().then(() => getSource(member.image)).then(source => {
          if (cancelled) { void source.cancel().catch(() => undefined); return; }
          reader = selectSparseRanges(source, member.stream, member.fileSize).getReader();
        });
        await opening;
        if (cancelled) return;
        const next = await reader.read();
        if (cancelled) return;
        if (next.done) {
          reader.releaseLock();
          reader = undefined;
          output.close();
        } else output.enqueue(next.value);
      } catch (error) {
        if (!cancelled) output.error(error);
        Promise.resolve(close(error)).catch(() => undefined);
      }
    },
    cancel(reason) {
      cancelled = true;
      return close(reason);
    },
  }, { highWaterMark: 0 });
}

/** The factory flow must erase LUN4 first. Sources stay individually verified and bounded. */
export async function flashFirmwareBatch(device, batch, getSource, onProgress = undefined) {
  if (!batches.has(batch)) throw new Error("Expected a prepared firmware batch");
  const [found, lun, , gpt] = await device.detectPartition(batch.members[0].name);
  if (!found || lun !== 4) throw new Error(`Firmware destination changed: ${batch.members[0].name}`);
  if (gpt.sectorSize !== SECTOR_SIZE || device.firehose.cfg.SECTOR_SIZE_IN_BYTES !== SECTOR_SIZE) throw new Error("Firmware batch sector size differs from destination");
  for (const { name, partition, stream } of batch.members) {
    const actual = gpt.locatePartition(name);
    if (!actual || actual.start !== partition.start || actual.sectors !== partition.sectors
      || actual.start < gpt.firstUsableLba || actual.end > gpt.lastUsableLba
      || BigInt(stream.numPartitionSectors) > actual.sectors) throw new Error(`Firmware destination changed: ${name}`);
  }
  const sources = [];
  const plan = { ...batch.metadata, parts: batch.members.map(member => ({
    size: member.stream.dataSectors * SECTOR_SIZE,
    stream: () => {
      const source = lazyPayload(member, getSource);
      sources.push(source);
      return source;
    },
  })) };
  try {
    return await device.firehose.cmdProgramSparse(4, batch.startSector, plan, onProgress);
  } finally {
    // Firehose bounds cleanup of a failed active reader; do not wait again on a stuck producer.
    for (const source of sources) if (!source.locked) void source.cancel().catch(() => undefined);
  }
}
