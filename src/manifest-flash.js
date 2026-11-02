import { CalibrationLayoutError, canPreserveDdr, ddrPartitionFromGpt, readDdrPartition } from "./calibration.js";
import { GPT } from "./gpt.js";
import { openVerifiedImage, resourceUrl, validateFrameSizes, validateImageHashes } from "./manifest-source.js";
import { selectSparseRanges, validateSparseStreamMetadata } from "./sparse-stream.js";

const SECTOR_SIZE = 4096;

export function userdataForStorage(storage) {
  if (storage.block_size !== SECTOR_SIZE || storage.page_size !== SECTOR_SIZE || storage.num_physical !== 6 || storage.mem_type !== "UFS") {
    throw new Error("Expected six-LUN, 4096-byte UFS storage");
  }
  if (/^SDINDDH4-128G(?: +\d+)?$/.test(storage.prod_name) && storage.manufacturer_id === 325) {
    if (storage.total_blocks === 29605888) return "userdata_89";
    if (storage.total_blocks === 29775872) return "userdata_90";
  }
  if (storage.prod_name === "KLUDG4U1EA-B0C1" && storage.manufacturer_id === 462 && storage.total_blocks === 29765632) return "userdata_90";
  throw new Error("Unsupported UFS device or capacity");
}

/** Accept the merged all-partitions manifest, with optional per-image flash companions. */
export function prepareManifest(entries, baseUrl, storage, slot = "a") {
  if (slot !== "a" && slot !== "b") throw new Error("Expected slot a or b");
  const userdata = userdataForStorage(storage);
  if (!Array.isArray(entries) || !entries.length || entries.length > 256) throw new Error("Expected a full manifest array");
  const seen = new Set();
  const images = [];
  for (const original of entries) {
    const item = { ...original, ...original.flash };
    if (typeof item.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.name) || seen.has(item.name)) throw new Error("Invalid or duplicate manifest image name");
    seen.add(item.name);
    if (item.name === "persist" || (item.name.startsWith("userdata_") && item.name !== userdata)) continue;
    if (typeof item.zstd_url !== "string" || !item.zstd_url || !Number.isSafeInteger(item.archive_size) || item.archive_size <= 0) {
      throw new Error(`Native zstd flash metadata is required for ${item.name}; XZ-only manifests are unsupported`);
    }
    if (typeof item.has_ab !== "boolean" || typeof item.sparse !== "boolean" || !Number.isSafeInteger(item.size) || item.size <= 0) {
      throw new Error(`Invalid image properties: ${item.name}`);
    }
    const name = item.name.startsWith("userdata_") ? "userdata" : item.name;
    const image = {
      name: item.name,
      names: [item.has_ab ? `${name}_${slot}` : name],
      archiveUrl: resourceUrl(item.zstd_url, baseUrl),
      archiveSize: item.archive_size,
      fileSize: item.file_size,
      hash: item.hash,
      chunkSize: item.chunk_size,
      chunkHashes: item.chunk_hashes,
      size: item.size,
      gpt: item.gpt,
      stream: null,
      frameSizes: undefined,
    };
    validateImageHashes(image);
    if (item.zstd_chunked_url !== undefined || item.zstd_chunked_size !== undefined || item.zstd_frame_sizes !== undefined) {
      if (typeof item.zstd_chunked_url !== "string" || !item.zstd_chunked_url || !Number.isSafeInteger(item.zstd_chunked_size) || item.zstd_chunked_size <= 0) {
        throw new Error(`Invalid independent zstd archive: ${item.name}`);
      }
      image.archiveUrl = resourceUrl(item.zstd_chunked_url, baseUrl);
      image.archiveSize = item.zstd_chunked_size;
      image.frameSizes = validateFrameSizes(item.zstd_frame_sizes, image);
    }
    if (!["file:", "http:", "https:"].includes(image.archiveUrl.protocol)) throw new Error(`Unsupported archive protocol: ${item.name}`);
    if (item.gpt) {
      if (!Number.isInteger(item.gpt.lun) || item.gpt.lun < 0 || item.gpt.lun > 5 || item.gpt.start_sector !== 0
        || item.gpt.num_sectors !== 6 || item.name !== `gpt_main_${item.gpt.lun}` || item.sparse || item.has_ab
        || image.fileSize !== 6 * SECTOR_SIZE || item.size !== image.fileSize) throw new Error(`Invalid GPT image: ${item.name}`);
    } else {
      if (!item.sparse || !item.stream || item.stream.sector_size !== SECTOR_SIZE) throw new Error(`Sparse stream index required for ${item.name}`);
      const index = item.stream;
      image.stream = validateSparseStreamMetadata({
        sectorSize: index.sector_size,
        numPartitionSectors: index.num_partition_sectors,
        dataSectors: index.data_sectors,
        extents: index.extents,
        sourceRanges: index.source_ranges,
      }, image.fileSize);
      if (image.stream.numPartitionSectors * SECTOR_SIZE !== item.size) throw new Error(`Expanded size mismatch: ${item.name}`);
    }
    images.push(image);
  }
  const gpts = images.filter(image => image.gpt);
  if (gpts.length !== 6 || new Set(gpts.map(image => image.gpt.lun)).size !== 6) throw new Error("Manifest must include all six GPT images");
  for (const required of ["system", "boot", "xbl", "xbl_config", "abl", userdata]) {
    if (!images.some(image => image.name === required)) throw new Error(`Full manifest is missing ${required}`);
  }
  const destinations = images.filter(image => !image.gpt).flatMap(image => image.names);
  if (new Set(destinations).size !== destinations.length) throw new Error("Duplicate flash destinations");
  return { images: images.filter(image => !image.gpt), gpts: gpts.sort((a, b) => a.gpt.lun - b.gpt.lun), userdata };
}

/** Validate the supplied GPTs and all destinations before changing the device. */
export function validateManifestDestinations(plan, gptBytes, storage) {
  const destinations = new Map();
  for (const image of plan.gpts) {
    const bytes = new Uint8Array(gptBytes.get(image.gpt.lun));
    const gpt = new GPT(SECTOR_SIZE);
    const header = gpt.parseHeader(bytes.subarray(SECTOR_SIZE, SECTOR_SIZE * 2), 1n);
    if (!header || header.mismatchCrc32 || gpt.currentLba !== 1n || gpt.partEntriesStartLba !== 2n || gpt.numPartEntries < 1 || gpt.numPartEntries > 128 || gpt.partEntrySize !== 128) {
      throw new Error(`Invalid GPT header: ${image.name}`);
    }
    if (gpt.parsePartEntries(bytes.subarray(2 * SECTOR_SIZE)).mismatchCrc32) throw new Error(`Invalid GPT entries: ${image.name}`);
    let end = 6n;
    const partitions = gpt.getPartitions().sort((a, b) => a.start < b.start ? -1 : 1);
    for (const partition of partitions) {
      if (partition.start < end || partition.sectors <= 0n || partition.end > gpt.lastUsableLba || destinations.has(partition.name)) {
        throw new Error(`Invalid or overlapping partition: ${partition.name}`);
      }
      destinations.set(partition.name, { ...partition, lun: image.gpt.lun });
      end = partition.end + 1n;
    }
    // fixgpt expands the final LUN0 partition to the detected capacity.
    if (image.gpt.lun === 0) {
      const last = partitions.at(-1);
      if (last?.name !== "userdata") throw new Error("Expected userdata at the end of LUN0");
      destinations.get("userdata").sectors = BigInt(storage.total_blocks) - 6n - last.start;
    }
  }
  const persist = destinations.get("persist");
  if (!persist || persist.lun !== 0 || persist.start !== 8n || persist.sectors !== 8192n) throw new Error("Unexpected persist layout in manifest GPT");
  for (const image of plan.images) {
    for (const name of image.names) {
      const partition = destinations.get(name);
      if (!partition || BigInt(image.stream.numPartitionSectors) > partition.sectors) throw new Error(`Image exceeds or has no destination: ${name}`);
      if (name === "persist") throw new Error("Cannot flash persist");
    }
  }
  return destinations;
}


function prefetchImages(images, openImage, signal) {
  const pending = [];
  let index = 0;
  const fill = () => {
    while (pending.length < 4 && index < images.length) {
      const image = images[index++];
      // Store errors as values so an early rejection is observed while USB is busy.
      pending.push(Promise.resolve().then(() => openImage(image, signal)).then(source => ({ source }), error => ({ error })));
    }
  };
  fill();
  return {
    async next() {
      fill();
      const result = await pending.shift();
      if (result.error) throw result.error;
      return result.source;
    },
    async close() {
      await Promise.all(pending.map(async promise => {
        const { source } = await promise;
        if (source && !source.locked) await source.cancel().catch(() => undefined);
      }));
    },
  };
}

/** Full factory flash. Only activate the selected slot and reset after every image succeeds. */
export async function flashManifest(device, entries, baseUrl, { slot = "a", signal, report = () => undefined, openImage = openVerifiedImage } = {}) {
  const started = performance.now();
  async function phase(name, operation) {
    signal?.throwIfAborted();
    const begin = performance.now();
    const result = await operation();
    if (result === false) throw new Error(`${name} failed`);
    report({ phase: name, seconds: (performance.now() - begin) / 1000 });
    return result;
  }
  const controller = new AbortController();
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let sources;
  try {
    const storage = await phase("storage", () => device.getStorageInfo());
    const plan = prepareManifest(entries, baseUrl, storage, slot);
    for (const image of plan.images) {
      if (!device.canFlashStream(image.stream.extents.length)) throw new Error(`Programmer lacks native sparse support for ${image.name}`);
    }
    const gptBytes = new Map();
    await phase("verify_gpts", async () => {
      await Promise.all(plan.gpts.map(async image => {
        const source = await openImage(image, signal);
        const bytes = new Uint8Array(image.fileSize);
        let offset = 0;
        for await (const chunk of source) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        if (offset !== bytes.length) throw new Error(`Truncated GPT: ${image.name}`);
        gptBytes.set(image.gpt.lun, bytes);
      }));
      validateManifestDestinations(plan, gptBytes, storage);
    });
    const desiredDdr = readDdrPartition(gptBytes.get(3));
    let existingDdr = null;
    try {
      existingDdr = ddrPartitionFromGpt(await device.getGpt(3));
    } catch (error) {
      // A blank or corrupt GPT can be recovered from the supplied images. Transport failures cannot.
      if (error.code !== "GPT_CORRUPT" && !(error instanceof CalibrationLayoutError)) throw error;
    }
    const preserveDdr = canPreserveDdr(existingDdr, desiredDdr);
    sources = prefetchImages(plan.images, openImage, signal);
    await phase("repair_gpts", async () => {
      for (const image of plan.gpts) {
        if (!await device.repairGpt(image.gpt.lun, new Blob([gptBytes.get(image.gpt.lun)]))) throw new Error(`GPT repair failed on LUN ${image.gpt.lun}`);
      }
    });
    const [found, lun, persist] = await device.detectPartition("persist");
    if (!found || lun !== 0 || persist.start !== 8n || persist.sectors !== 8192n) throw new Error("Unexpected persist location after GPT repair");
    if (preserveDdr && !canPreserveDdr(ddrPartitionFromGpt(await device.getGpt(3)), desiredDdr)) {
      throw new Error("Unexpected DDR location after GPT repair");
    }
    for (let lun = 0; lun < 6; lun++) {
      const preserve = ["mbr", "gpt"];
      if (lun === 0) preserve.push("persist");
      if (lun === 3 && preserveDdr) preserve.push("ddr");
      await phase(`erase_${lun}`, () => device.eraseLun(lun, preserve));
    }
    for (const image of plan.images) {
      await phase(`flash_${image.name}`, async () => {
        const source = await sources.next();
        const payload = selectSparseRanges(source, image.stream, image.fileSize);
        try {
          if (!await device.flashStream(image.names[0], image.stream, payload, undefined, false)) throw new Error(`Flashing ${image.name} failed`);
        } finally {
          if (!payload.locked) await payload.cancel().catch(() => undefined);
        }
      });
    }
    await phase(`activate_${slot}`, () => device.setActiveSlot(slot));
    await phase("reset", () => device.reset());
    report({ phase: "complete", seconds: (performance.now() - started) / 1000, userdata: plan.userdata, slot });
  } finally {
    controller.abort();
    await sources?.close();
  }
}
