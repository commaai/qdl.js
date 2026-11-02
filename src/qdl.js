import { Firehose } from "./firehose.js"
import { GPT } from "./gpt.js"
import { Sahara } from "./sahara.js";
import * as Sparse from "./sparse.js";
import { prepareSparseProgram, validateSparseProgram } from "./sparse-program.js";
import { selectSparseRanges } from "./sparse-stream.js";
import { createLogger } from "./logger.js";

const logger = createLogger("qdl");
const streamingPlans = new WeakMap();

function streamSparseProgram(blob, plan, sectorSize) {
  if (!plan || typeof blob.stream !== "function" || !plan.sourceRanges) return plan;
  let streamed = streamingPlans.get(plan);
  if (!streamed) {
    const metadata = { ...plan, sectorSize };
    streamed = {
      ...plan,
      parts: [{ size: plan.dataSectors * sectorSize, stream: () => selectSparseRanges(blob.stream(), metadata, blob.size) }],
    };
    streamingPlans.set(plan, streamed);
  }
  return streamed;
}


export class qdlDevice {
  /**
   * @type {Firehose|null}
   */
  #firehose = null

  /** @type {Map<number, GPT>} */
  #gptCache = new Map();

  /**
   * @param {ArrayBuffer} programmer
   */
  constructor(programmer) {
    if (!programmer) {
      throw "programmer is required";
    }
    this.programmer = programmer;
    /**
     * @type {string|null}
     */
    this.mode = null;
    /**
     * @type {Sahara|null}
     */
    this.sahara = null;
  }

  get firehose() {
    if (!this.#firehose) throw new Error("Firehose not configured");
    return this.#firehose;
  }

  /**
   * @param {usbClass} cdc
   * @returns {Promise<void>}
   */
  async connect(cdc) {
    this.#gptCache.clear();
    if (!cdc.connected) await cdc.connect();
    if (!cdc.connected) throw new Error("Could not connect to device");
    logger.debug("QDL device detected");
    this.sahara = new Sahara(cdc, this.programmer);
    this.mode = await this.sahara.connect();
    if (this.mode === "sahara") {
      logger.debug("Connected to Sahara");
      this.mode = await this.sahara.uploadLoader();
    }
    if (this.mode !== "firehose") {
      throw new Error(`Unsupported mode: ${this.mode}. Please reboot the device.`);
    }
    this.#firehose = new Firehose(cdc);
    if (!await this.firehose.configure()) throw new Error("Could not configure Firehose");
    logger.debug("Firehose configured");
  }

  /**
   * @param {number} lun
   * @param {bigint|undefined} [sector]
   * @returns {Promise<GPT>}
   */
  async getGpt(lun, sector = undefined) {
    this.#gptCache.delete(lun);
    // TODO: get sector size from getStorageInfo
    const sectorSize = this.firehose.cfg.SECTOR_SIZE_IN_BYTES;
    const readGpt = async (headerLba) => {
      if (typeof headerLba !== "bigint" || headerLba < 1n) throw new Error("Invalid GPT header LBA");
      // The usual 128-entry table occupies four 4 KiB sectors. A backup
      // window ends at its header, so this never reads beyond the disk.
      const windowStart = headerLba === 1n ? 1n : headerLba > 4n ? headerLba - 4n : 1n;
      const windowSectors = headerLba === 1n ? 5 : Number(headerLba - windowStart) + 1;
      const window = await this.firehose.cmdReadBuffer(lun, windowStart, windowSectors);
      if (window.byteLength !== windowSectors * sectorSize) throw new Error("Truncated GPT read");
      const offset = Number(headerLba - windowStart) * sectorSize;
      const gpt = new GPT(sectorSize);
      const header = gpt.parseHeader(window.subarray(offset, offset + sectorSize), headerLba);
      if (!header || header.mismatchCrc32) return { gpt, headerValid: false, entries: null };

      const entryBytes = gpt.numPartEntries * gpt.partEntrySize;
      const entrySectors = Math.ceil(entryBytes / sectorSize);
      const lastLba = headerLba === 1n ? gpt.alternateLba : headerLba;
      // Bound fallback allocations even for a CRC-valid but bogus header;
      // 32 MiB accommodates 262144 standard partition entries.
      if (gpt.currentLba !== headerLba || gpt.alternateLba === headerLba ||
          (headerLba === 1n ? gpt.alternateLba <= 1n : gpt.alternateLba !== 1n) ||
          gpt.firstUsableLba <= 1n || gpt.lastUsableLba < gpt.firstUsableLba || gpt.lastUsableLba >= lastLba ||
          gpt.numPartEntries === 0 || gpt.partEntrySize < 128 || !Number.isInteger(Math.log2(gpt.partEntrySize)) ||
          !Number.isSafeInteger(entryBytes) || entryBytes > 32 * 1024 * 1024 || gpt.partEntriesStartLba < 2n) {
        return { gpt, headerValid: false, entries: null };
      }
      const entriesEnd = gpt.partEntriesStartLba + BigInt(entrySectors);
      if (headerLba === 1n ? entriesEnd > gpt.firstUsableLba :
          gpt.partEntriesStartLba <= gpt.lastUsableLba || entriesEnd > headerLba) {
        return { gpt, headerValid: false, entries: null };
      }
      let entries;
      if (gpt.partEntriesStartLba >= windowStart && entriesEnd <= windowStart + BigInt(windowSectors)) {
        const start = Number(gpt.partEntriesStartLba - windowStart) * sectorSize;
        entries = window.subarray(start, start + entryBytes);
      } else {
        const data = await this.firehose.cmdReadBuffer(lun, gpt.partEntriesStartLba, entrySectors);
        if (data.byteLength !== entrySectors * sectorSize) throw new Error("Truncated GPT entries read");
        entries = data.subarray(0, entryBytes);
      }
      return { gpt, headerValid: true, entries: gpt.parsePartEntries(entries) };
    };

    logger.debug("reading primary GPT");
    const primary = await readGpt(sector ?? 1n);
    const primaryGpt = primary.gpt;
    const primaryCorrupted = !primary.headerValid || primary.entries.mismatchCrc32;

    if (sector !== undefined) {
      // Return early if specific sector is requested
      if (!primary.headerValid) throw new Error(`LUN ${lun}: Invalid GPT header at sector ${sector}`);
      if (primaryCorrupted) throw new Error(`LUN ${lun}: GPT partition entries are corrupted at sector ${sector}`);
      return primaryGpt;
    }

    let backupLba;
    if (primary.headerValid) {
      backupLba = primaryGpt.alternateLba;
    } else {
      // A corrupt header cannot supply a trusted backup LBA or entry count.
      // Ask the device for this LUN's capacity only on the recovery path.
      try {
        const info = await this.getStorageInfo(lun);
        if (info?.block_size !== sectorSize || !Number.isSafeInteger(info.total_blocks) || info.total_blocks < 3) {
          throw new Error("Invalid LUN capacity");
        }
        backupLba = BigInt(info.total_blocks) - 1n;
      } catch (cause) {
        throw new Error(`LUN ${lun}: Invalid GPT header and cannot locate backup safely`, { cause });
      }
    }
    logger.debug("reading backup GPT");
    const backup = await readGpt(backupLba);
    const backupGpt = backup.gpt;
    const backupCorrupted = !backup.headerValid || backup.entries.mismatchCrc32;

    const partEntriesConsistency = !primaryCorrupted && !backupCorrupted && primary.entries.partEntriesCrc32 === backup.entries.partEntriesCrc32;
    logger.debug({
      primaryCorrupted,
      backupCorrupted,
      headerConsistency: partEntriesConsistency,
    });

    if (primaryCorrupted) {
      if (backupCorrupted) {
        throw new Error(`LUN ${lun}: Both primary and backup GPT headers are corrupted, cannot recover`);
      }
      // TODO: restore primary from backup
      logger.warn(`LUN ${lun}: Primary GPT is corrupted, using backup`);
      this.#gptCache.set(lun, backupGpt);
      return backupGpt;
    }
    if (!partEntriesConsistency) {
      logger.warn(`LUN ${lun}: Primary and backup GPT part entries are inconsistent, using primary`);
      // TODO: create backup from primary
    }
    this.#gptCache.set(lun, primaryGpt);
    return primaryGpt;
  }

  /**
   * @param {number} lun
   * @param {Blob} primaryGptBlob
   * @returns {Promise<boolean>}
   */
  async repairGpt(lun, primaryGptBlob) {
    this.#gptCache.delete(lun);
    logger.info(`Repairing GPT on LUN ${lun}`);

    if (!await this.firehose.cmdProgram(lun, 0, primaryGptBlob)) {
      throw new Error("Failed to write primary GPT data");
    }

    // Fix the partition table, expanding last partition to fill available sectors
    await this.firehose.cmdFixGpt(lun, 1);

    // Read back GPT and create backup copy
    const primaryGpt = await this.getGpt(lun, 1n);
    const backupGpt = primaryGpt.asAlternate();
    const backupPartEntries = backupGpt.buildPartEntries();
    const backupHeader = backupGpt.buildHeader(backupPartEntries);

    logger.debug(`Writing backup partition table to LBA ${backupGpt.partEntriesStartLba}`);
    if (!await this.firehose.cmdProgram(lun, backupGpt.partEntriesStartLba, new Blob([backupPartEntries]))) {
      throw new Error("Failed to write backup partition table");
    }

    logger.debug(`Writing backup GPT header to LBA ${backupGpt.currentLba}`);
    if (!await this.firehose.cmdProgram(lun, backupGpt.currentLba, new Blob([backupHeader]))) {
      throw new Error("Failed to write backup GPT header");
    }

    logger.info(`Successfully repaired GPT on LUN ${lun}`);
    return true;
  }

  /**
   * @param {number} lun
   * @param {string[]} [preservePartitions]
   * @returns {Promise<boolean>}
   */
  async eraseLun(lun, preservePartitions = ["mbr", "gpt", "persist"]) {
    const primaryGpt = await this.getGpt(lun);
    const { currentLba, alternateLba, firstUsableLba, lastUsableLba } = primaryGpt;
    // Recovery may return the backup GPT, whose current/alternate LBAs are reversed.
    const primaryHeaderLba = currentLba < alternateLba ? currentLba : alternateLba;
    const backupHeaderLba = currentLba > alternateLba ? currentLba : alternateLba;
    /** @type {{ name: string; start: bigint; end: bigint }[]} */
    const protectedRanges = [];
    if (preservePartitions.includes("mbr")) {
      protectedRanges.push({ name: "mbr", start: 0n, end: 0n });
    }
    if (preservePartitions.includes("gpt")) {
      protectedRanges.push({ name: "gpt-primary", start: primaryHeaderLba, end: firstUsableLba - 1n });
      protectedRanges.push({ name: "gpt-backup", start: lastUsableLba + 1n, end: backupHeaderLba });
    }
    for (const name of preservePartitions) {
      if (name === "mbr" || name === "gpt") continue;
      const part = primaryGpt.locatePartition(name);
      if (!part) {
        logger.error(`Partition ${name} not found in GPT`);
        return false;
      }
      protectedRanges.push({ name, start: part.start, end: part.end });
    }
    protectedRanges.sort((a, b) => Number(a.start - b.start));

    /** @type {{ name: string; start: bigint; end: bigint }[]} */
    const mergedProtectedRanges = [];
    if (protectedRanges.length > 0) {
      let currentRange = {...protectedRanges[0]};
      for (let i = 1; i < protectedRanges.length; i++) {
        const nextRange = protectedRanges[i];
        if (nextRange.start <= currentRange.end + 1n) {
          currentRange.end = currentRange.end > nextRange.end ? currentRange.end : nextRange.end;
          currentRange.name += `,${nextRange.name}`;
        } else {
          mergedProtectedRanges.push(currentRange);
          currentRange = {...nextRange};
        }
      }
      mergedProtectedRanges.push(currentRange);
    }
    for (const range of mergedProtectedRanges) {
      logger.debug(`Preserving ${range.name} (${range.start}-${range.end})`);
    }

    /** @type {{ start: bigint; end: bigint }[]} */
    const erasableRanges = [];
    let lastEndSector = -1n;
    for (const range of mergedProtectedRanges) {
      if (range.start > lastEndSector + 1n) {
        erasableRanges.push({ start: lastEndSector + 1n, end: range.start - 1n });
      }
      lastEndSector = range.end;
    }
    if (lastEndSector < backupHeaderLba) {
      erasableRanges.push({ start: lastEndSector + 1n, end: backupHeaderLba });
    }

    this.#gptCache.delete(lun);
    for (const range of erasableRanges) {
      const sectors = range.end - range.start + 1n;
      logger.debug(`Erasing sectors ${range.start}-${range.end} (${sectors})`);

      // New programmers split requests internally using the device's VPD limits.
      // Older programmers keep the bounded requests their response deadline allows.
      const maxSectors = this.firehose.ufsUnmapLimits && this.firehose.cfg.FastErase ? 0xffffffff : 512 * 1024;
      let sector = range.start;
      while (sector <= range.end) {
        const chunkSectors = Math.min(Number(range.end - sector + 1n), maxSectors);
        const result = await this.firehose.cmdErase(lun, sector, chunkSectors);
        if (!result) {
          logger.error(`Failed to erase sectors chunk ${sector}-${sector + BigInt(chunkSectors - 1)}`);
          return false;
        }
        sector = sector + BigInt(chunkSectors);
      }
    }

    logger.info(`Successfully erased LUN ${lun} while preserving specified partitions`);
    return true;
  }

  /**
   * @param {string} name
   * @returns {Promise<[false] | [true, number, { start: bigint; end: bigint; sectors: bigint }, GPT]>}
   */
  async detectPartition(name) {
    for (const lun of this.firehose.luns) {
      const gpt = this.#gptCache.get(lun) ?? await this.getGpt(lun);
      const partition = gpt.locatePartition(name);
      if (!partition) continue;
      logger.debug("found partition", name, "in lun", lun, partition);
      return [true, lun, partition, gpt];
    }
    logger.debug("did not find partition", name);
    return [false];
  }

  /**
   * @param {string | string[]} name
   * @param {Blob} blob
   * @param {progressCallback} [onProgress] - Logical bytes written, summed across explicit destinations
   * @param {boolean} [eraseBeforeFlashSparse=true]
   * @returns {Promise<boolean>}
   */
  async flashBlob(name, blob, onProgress = undefined, eraseBeforeFlashSparse = true) {
    if (Array.isArray(name)) return this.#flashBlobs(name, blob, onProgress, eraseBeforeFlashSparse);
    const [found, lun, partition, gpt] = await this.detectPartition(name);
    if (!found) throw `Can't find partition ${name}`;
    logger.info(`Flashing ${name}`);
    const sparse = await Sparse.from(blob);
    if (sparse === null) {
      const imgSectors = Math.ceil(blob.size / gpt.sectorSize);
      if (imgSectors > partition.sectors) {
        logger.error("Image too large for partition", { imgSectors, partitionSectors: partition.sectors });
        return false;
      }
      return await this.firehose.cmdProgram(lun, partition.start, blob, onProgress);
    }
    let plan = null;
    if (this.firehose.programSparseMaxExtents && !this.firehose.cfg.ZLPAwareHost) {
      plan = streamSparseProgram(blob, await prepareSparseProgram(blob, gpt.sectorSize, partition.sectors, this.firehose.programSparseMaxExtents), gpt.sectorSize);
    }
    if (eraseBeforeFlashSparse) {
      logger.debug(`Erasing ${name}...`);
      if (!await this.firehose.cmdErase(lun, partition.start, partition.sectors)) {
        logger.error("Failed to erase partition before sparse flashing");
        return false;
      }
    }
    if (plan) {
      let extent = 0;
      let dataOffset = 0;
      const progress = onProgress ? (written) => {
        while (extent + 1 < plan.extents.length && written > dataOffset + Number(plan.extents[extent][1]) * gpt.sectorSize) {
          dataOffset += Number(plan.extents[extent++][1]) * gpt.sectorSize;
        }
        onProgress(Number(plan.extents[extent][0]) * gpt.sectorSize + written - dataOffset);
      } : undefined;
      const success = await this.firehose.cmdProgramSparse(lun, partition.start, plan, progress);
      if (success) onProgress?.(Number(plan.numPartitionSectors) * gpt.sectorSize);
      return success;
    }
    logger.debug(`Writing chunks to ${name}...`);
    for await (const [offset, chunk] of sparse.readCoalesced()) {
      if (!chunk) continue;
      if (offset % gpt.sectorSize !== 0) {
        throw "qdl - Offset not aligned to sector size";
      }
      const sector = partition.start + BigInt(offset / gpt.sectorSize);
      const onChunkProgress = (progress) => onProgress?.(offset + progress);
      if (!await this.firehose.cmdProgram(lun, sector, chunk, onChunkProgress)) {
        logger.debug("Failed to program chunk")
        return false;
      }
    }
    return true;
  }

  /** Whether a verified sparse stream can be written without downloading it first. */
  canFlashStream(copies = 1, extentCount = 1) {
    try {
      const hose = this.firehose;
      return !hose.failed && !hose.cfg.ZLPAwareHost && Number.isInteger(copies) && copies > 0 && copies <= hose.programSparseMaxCopies
        && Number.isInteger(extentCount) && extentCount > 0 && extentCount <= hose.programSparseMaxExtents;
    } catch {
      return false;
    }
  }

  /**
   * Write an already verified packed sparse payload. Callers must verify bytes before enqueueing them.
   * An interrupted stream closes USB; power-cycle the device before retrying.
   * @param {string | string[]} names
   * @param {{sectorSize: number, numPartitionSectors: number, dataSectors: number, extents: [bigint, bigint][]}} metadata
   * @param {ReadableStream<Uint8Array>} stream
   * @param {progressCallback} [onProgress] - Logical bytes written across all destinations
   * @param {boolean} [erase=true]
   * @returns {Promise<boolean>}
   */
  async flashStream(names, metadata, stream, onProgress = undefined, erase = true) {
    const targets = Array.isArray(names) ? names : [names];
    if (!this.canFlashStream(targets.length, metadata?.extents?.length)) throw new Error("Native sparse streaming is not supported for these destinations");
    if (!stream || typeof stream.getReader !== "function" || stream.locked) throw new Error("Expected an unlocked verified image stream");
    const plan = {
      numPartitionSectors: metadata.numPartitionSectors,
      dataSectors: metadata.dataSectors,
      extents: metadata.extents.map(extent => Array.isArray(extent) ? [...extent] : extent),
      parts: [{ size: Number(metadata.dataSectors) * metadata.sectorSize, stream: () => stream }],
    };
    plan.table = validateSparseProgram(plan, metadata.sectorSize, plan.numPartitionSectors, this.firehose.programSparseMaxExtents);
    const destinations = await this.#flashDestinations(targets);
    for (const { partition, gpt } of destinations) {
      if (gpt.sectorSize !== metadata.sectorSize || this.firehose.cfg.SECTOR_SIZE_IN_BYTES !== metadata.sectorSize) throw new Error("Image stream sector size differs from destination");
      if (BigInt(plan.numPartitionSectors) > partition.sectors) throw new Error("Image exceeds destination partition");
    }
    return this.#programSparseDestinations(destinations, plan, onProgress, erase);
  }

  async #flashDestinations(names) {
    if (!names.length || names.some(name => typeof name !== "string" || !name) || new Set(names).size !== names.length) {
      throw new Error("Expected distinct partition names");
    }
    const destinations = [];
    for (const name of names) {
      const [found, lun, partition, gpt] = await this.detectPartition(name);
      if (!found) throw new Error(`Can't find partition ${name}`);
      for (const previous of destinations) {
        if (previous.lun === lun && partition.start < previous.partition.start + previous.partition.sectors && previous.partition.start < partition.start + partition.sectors) {
          throw new Error("Overlapping flash destinations");
        }
      }
      destinations.push({ lun, partition, gpt });
    }
    return destinations;
  }

  async #flashBlobs(names, blob, onProgress, eraseBeforeFlashSparse) {
    const destinations = await this.#flashDestinations(names);
    const sparse = await Sparse.from(blob);
    const logicalBytes = sparse ? sparse.header.totalBlocks * sparse.header.blockSize : blob.size;
    if (!Number.isSafeInteger(logicalBytes) || logicalBytes < 0) throw new Error("Invalid image size");
    for (const { partition, gpt } of destinations) {
      if (BigInt(Math.ceil(logicalBytes / gpt.sectorSize)) > partition.sectors) throw new Error("Image exceeds destination partition");
    }
    const first = destinations[0];
    let plan = null;
    if (sparse && destinations.length === 2 && this.firehose.programSparseMaxCopies >= 2 && this.firehose.programSparseMaxExtents && !this.firehose.cfg.ZLPAwareHost
      && destinations.every(({ gpt }) => gpt.sectorSize === first.gpt.sectorSize)) {
      plan = streamSparseProgram(blob, await prepareSparseProgram(blob, first.gpt.sectorSize, first.partition.sectors, this.firehose.programSparseMaxExtents), first.gpt.sectorSize);
    }
    if (!plan) {
      for (const [index, name] of names.entries()) {
        const progress = onProgress ? written => onProgress(index * logicalBytes + written) : undefined;
        if (!await this.flashBlob(name, blob, progress, eraseBeforeFlashSparse)) return false;
        onProgress?.((index + 1) * logicalBytes);
      }
      return true;
    }
    return this.#programSparseDestinations(destinations, plan, onProgress, eraseBeforeFlashSparse);
  }

  async #programSparseDestinations(destinations, plan, onProgress, erase) {
    const first = destinations[0];
    if (erase) {
      for (const { lun, partition } of destinations) {
        if (!await this.firehose.cmdErase(lun, partition.start, partition.sectors)) return false;
      }
    }
    let extent = 0;
    let dataOffset = 0;
    const progress = onProgress ? written => {
      while (extent + 1 < plan.extents.length && written > dataOffset + Number(plan.extents[extent][1]) * first.gpt.sectorSize) {
        dataOffset += Number(plan.extents[extent++][1]) * first.gpt.sectorSize;
      }
      onProgress((Number(plan.extents[extent][0]) * first.gpt.sectorSize + written - dataOffset) * destinations.length);
    } : undefined;
    const second = destinations[1];
    const success = await this.firehose.cmdProgramSparse(first.lun, first.partition.start, plan, progress, second ? {
      physicalPartitionNumber: second.lun,
      startSector: second.partition.start,
      numPartitionSectors: second.partition.sectors,
    } : undefined);
    if (success) onProgress?.(Number(plan.numPartitionSectors) * first.gpt.sectorSize * destinations.length);
    return success;
  }

  /**
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async erase(name) {
    const [found, lun, partition] = await this.detectPartition(name);
    if (!found) throw new Error(`Partition ${name} not found`);
    logger.info(`Erasing ${name}...`);
    await this.firehose.cmdErase(lun, partition.start, partition.sectors);
    logger.debug(`Erased ${name} ${partition.start}-${partition.end} (${partition.sectors} sectors)`);
    return true;
  }

  /**
   * @returns {Promise<[number, string[]]>}
   */
  async getDevicePartitionsInfo() {
    let partitions = new Set(), slots = new Set();
    for (const lun of this.firehose.luns) {
      const diskPartitions = (await this.getGpt(lun)).getPartitionsInfo();
      partitions = partitions.union(diskPartitions.partitions);
      slots = slots.union(diskPartitions.slots);
    }
    return [slots.size, Array.from(partitions)];
  }

  /**
   * @returns {Promise<"a"|"b">}
   */
  async getActiveSlot() {
    for (const lun of this.firehose.luns) {
      const slot = (await this.getGpt(lun)).getActiveSlot();
      if (slot) return slot;
    }
    // TODO: fallback to A?
    throw "Can't detect slot A or B";
  }

  /**
   * @param {number} [lun=0]
   * @returns {Promise<any>}
   */
  async getStorageInfo(lun = 0) {
    const log = (await this.firehose.cmdGetStorageInfo(lun)).find((log) => log.includes("storage_info"));
    if (!log) throw new Error("Storage info JSON not returned - not implemented?");
    try {
      return JSON.parse(log.substring("INFO: ".length))?.storage_info;
    } catch (e) {
      throw new Error("Failed to parse storage info JSON", { cause: e });
    }
  }

  async getDeviceType() {
    const deviceType = (await this.firehose.cmdDeviceType())
    if (!deviceType) throw new Error("Device type not returned - not implemented?");
    return deviceType;
  }

  /**
   * @param {"a"|"b"} slot
   * @returns {Promise<boolean>}
   */
  async setActiveSlot(slot) {
    this.#gptCache.clear();
    if (slot !== "a" && slot !== "b") throw new Error("Invalid slot");

    const updateGpt = async (lun, gpt) => {
      const previous = gpt.buildPartEntries();
      gpt.setActiveSlot(slot);
      const entries = gpt.buildPartEntries();
      if (previous.length === entries.length && previous.every((byte, index) => byte === entries[index])) return;
      if (!await this.firehose.cmdProgram(lun, gpt.partEntriesStartLba, new Blob([entries]))) throw new Error("Failed to update slot partition entries");
      const header = gpt.buildHeader(entries);
      if (!await this.firehose.cmdProgram(lun, gpt.currentLba, new Blob([header]))) throw new Error("Failed to update slot GPT header");
    };
    for (const lun of this.firehose.luns) {
      const primaryGpt = await this.getGpt(lun, 1n);
      await updateGpt(lun, primaryGpt);
      const backupGpt = await this.getGpt(lun, primaryGpt.alternateLba);
      await updateGpt(lun, backupGpt);
    }

    const activeBootLunId = (slot === "a") ? 1 : 2;
    await this.firehose.cmdSetBootLunId(activeBootLunId);
    logger.info(`Successfully set slot ${slot} active`);
    return true;
  }

  async reset() {
    this.#gptCache.clear();
    await this.firehose.cmdReset();
    return true;
  }
}
