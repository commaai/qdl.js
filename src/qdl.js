import { Firehose } from "./firehose"
/** @typedef {import("./firehose").ProgramData} ProgramData */
import { GPT } from "./gpt"
import { Sahara } from "./sahara";
import * as Sparse from "./sparse";
import { createLogger } from "./logger";

const logger = createLogger("qdl");

// writing a short hole as zeros is cheaper than starting another program
const SPARSE_MAX_GAP = 1024 * 1024;

/**
 * Pull everything from an async iterator as fast as possible, buffering it.
 * peek() returns the next result if it's already available.
 * @template T
 * @param {AsyncIterator<T>} iterator
 */
function prefetch(iterator) {
  /** @type {IteratorResult<T>[]} */
  const ready = [];
  /** @type {((value?: unknown) => void) | null} */
  let wake = null;
  /** @type {unknown} */
  let error;
  let failed = false;
  (async () => {
    try {
      for (;;) {
        const result = await iterator.next();
        ready.push(result);
        wake?.();
        if (result.done) return;
      }
    } catch (e) {
      error = e;
      failed = true;
      wake?.();
    }
  })();
  return {
    peek: () => ready[0],
    /** @returns {Promise<IteratorResult<T>>} */
    async next() {
      while (!ready.length) {
        if (failed) throw error;
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
      }
      const result = /** @type {IteratorResult<T>} */ (ready[0]);
      if (!result.done) ready.shift();
      return result;
    },
  };
}


export class qdlDevice {
  /**
   * @type {Firehose|null}
   */
  #firehose = null

  /**
   * GPTs read by detectPartition, dropped whenever this class writes a GPT
   * @type {Map<number, GPT>}
   */
  #gpts = new Map()

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
    // TODO: get sector size from getStorageInfo
    logger.debug("reading primary GPT");
    const primaryGpt = new GPT(this.firehose.cfg.SECTOR_SIZE_IN_BYTES);
    const primaryHeader = primaryGpt.parseHeader(await this.firehose.cmdReadBuffer(lun, sector ?? 1n, 1), sector ?? 1n);
    let primaryCorrupted = !primaryHeader;
    if (primaryHeader) {
      primaryCorrupted |= primaryHeader.mismatchCrc32;
    }
    const primaryPartEntries = primaryGpt.parsePartEntries(await this.firehose.cmdReadBuffer(lun, primaryGpt.partEntriesStartLba, primaryGpt.partEntriesSectors));
    primaryCorrupted |= primaryPartEntries.mismatchCrc32;

    if (sector !== undefined) {
      // Return early if specific sector is requested
      return primaryGpt;
    }

    logger.debug("reading backup GPT");
    const backupGpt = new GPT(this.firehose.cfg.SECTOR_SIZE_IN_BYTES);
    // TODO: can we predict the alternate lba instead of relying on a potentially faulty value from the primary header?
    const backupHeader = backupGpt.parseHeader(await this.firehose.cmdReadBuffer(lun, primaryGpt.alternateLba, 1), primaryGpt.alternateLba);
    let backupCorrupted = !backupHeader;
    if (backupHeader) {
      backupCorrupted |= backupHeader.mismatchCrc32;
    }
    const backupPartEntries = backupGpt.parsePartEntries(await this.firehose.cmdReadBuffer(lun, backupGpt.partEntriesStartLba, backupGpt.partEntriesSectors));
    backupCorrupted |= backupPartEntries.mismatchCrc32;

    const partEntriesConsistency = primaryPartEntries && backupPartEntries && primaryPartEntries.partEntriesCrc32 === backupPartEntries.partEntriesCrc32;
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
      logger.warn(`LUN ${lun}: Primary GPT header is corrupted, using backup`);
      return backupGpt;
    }
    if (!partEntriesConsistency) {
      logger.warn(`LUN ${lun}: Primary and backup GPT part entries are inconsistent, using primary`);
      // TODO: create backup from primary
    }
    return primaryGpt;
  }

  /**
   * @param {number} lun
   * @param {Blob} primaryGptBlob
   * @returns {Promise<boolean>}
   */
  async repairGpt(lun, primaryGptBlob) {
    logger.info(`Repairing GPT on LUN ${lun}`);
    this.#gpts.delete(lun);

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
    /** @type {{ name: string; start: bigint; end: bigint }[]} */
    const protectedRanges = [];
    if (preservePartitions.includes("mbr")) {
      protectedRanges.push({ name: "mbr", start: 0n, end: 0n });
    }
    if (preservePartitions.includes("gpt")) {
      protectedRanges.push({ name: "gpt-primary", start: currentLba, end: firstUsableLba - 1n });
      protectedRanges.push({ name: "gpt-backup", start: lastUsableLba + 1n, end: alternateLba });
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
    if (lastEndSector < alternateLba) {
      erasableRanges.push({ start: lastEndSector + 1n, end: alternateLba });
    }

    for (const range of erasableRanges) {
      const sectors = range.end - range.start + 1n;
      logger.debug(`Erasing sectors ${range.start}-${range.end} (${sectors})`);

      // Erase command times out for larger numbers of sectors
      const maxSectors = 512 * 1024;
      let sector = range.start;
      while (sector <= range.end) {
        const chunkSectors = Math.min(Number(range.end - sector + 1n), maxSectors);
        const result = await this.firehose.cmdErase(lun, sector, chunkSectors);
        if (!result) {
          logger.error(`Failed to erase sectors chunk ${sectors}-${sectors + BigInt(chunkSectors - 1)}`);
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
      // flashing looks up every partition, so don't read the GPTs every time
      let gpt = this.#gpts.get(lun);
      if (!gpt) {
        gpt = await this.getGpt(lun);
        this.#gpts.set(lun, gpt);
      }
      const partition = gpt.locatePartition(name);
      if (!partition) continue;
      logger.debug("found partition", name, "in lun", lun, partition);
      return [true, lun, partition, gpt];
    }
    logger.debug("did not find partition", name);
    return [false];
  }

  /**
   * @param {string} name
   * @param {Blob} blob
   * @param {progressCallback} [onProgress] - Returns number of bytes written
   * @param {boolean} [eraseBeforeFlashSparse=true]
   * @returns {Promise<boolean>}
   */
  async flashBlob(name, blob, onProgress = undefined, eraseBeforeFlashSparse = true) {
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
    if (eraseBeforeFlashSparse) {
      logger.debug(`Erasing ${name}...`);
      if (!await this.firehose.cmdErase(lun, partition.start, partition.sectors)) {
        logger.error("Failed to erase partition before sparse flashing");
        return false;
      }
    }
    logger.debug(`Writing chunks to ${name}...`);
    // parse all chunk headers up front, in the background
    const runs = prefetch(Sparse.runs(sparse, SPARSE_MAX_GAP));
    let result = await runs.next();
    // read the start of each program while the previous one writes
    let data = result.done ? null : this.firehose.prepareProgram(result.value[1]);
    while (!result.done) {
      const [offset, chunk] = result.value;
      if (offset % gpt.sectorSize !== 0) {
        throw "qdl - Offset not aligned to sector size";
      }
      const current = /** @type {ProgramData} */ (data);
      const next = runs.peek();
      data = next && !next.done ? this.firehose.prepareProgram(next.value[1]) : null;
      const sector = partition.start + BigInt(offset / gpt.sectorSize);
      const onChunkProgress = (/** @type {number} */ progress) => onProgress?.(offset + progress);
      if (!await this.firehose.cmdProgram(lun, sector, current, onChunkProgress)) {
        logger.debug("Failed to program chunk")
        return false;
      }
      result = await runs.next();
      if (!result.done && !data) data = this.firehose.prepareProgram(result.value[1]);
    }
    return true;
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
   * @returns {Promise<any>}
   */
  async getStorageInfo() {
    const log = (await this.firehose.cmdGetStorageInfo()).find((log) => log.includes("storage_info"));
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
    if (slot !== "a" && slot !== "b") throw new Error("Invalid slot");
    this.#gpts.clear();

    for (const lun of this.firehose.luns) {
      // Update primary GPT
      const primaryGpt = await this.getGpt(lun, 1n);
      primaryGpt.setActiveSlot(slot);

      const primaryPartEntries = primaryGpt.buildPartEntries();
      await this.firehose.cmdProgram(lun, primaryGpt.partEntriesStartLba, new Blob([primaryPartEntries]));
      const primaryHeader = primaryGpt.buildHeader(primaryPartEntries);
      await this.firehose.cmdProgram(lun, primaryGpt.currentLba, new Blob([primaryHeader]));

      // Update backup GPT
      const backupGpt = await this.getGpt(lun, primaryGpt.alternateLba);
      backupGpt.setActiveSlot(slot);

      const backupPartEntries = backupGpt.buildPartEntries();
      await this.firehose.cmdProgram(lun, backupGpt.partEntriesStartLba, new Blob([backupPartEntries]));
      const backupHeader = backupGpt.buildHeader(backupPartEntries);
      await this.firehose.cmdProgram(lun, backupGpt.currentLba, new Blob([backupHeader]));
    }

    const activeBootLunId = (slot === "a") ? 1 : 2;
    await this.firehose.cmdSetBootLunId(activeBootLunId);
    logger.info(`Successfully set slot ${slot} active`);
    return true;
  }

  async reset() {
    await this.firehose.cmdReset();
    return true;
  }
}
