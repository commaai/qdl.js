import { Firehose } from "./firehose"
import { GPT } from "./gpt"
import { Sahara } from "./sahara";
import * as Sparse from "./sparse";
import { concatUint8Array, containsBytes } from "./utils";
import { createLogger } from "./logger";

const logger = createLogger("qdl");


export class qdlDevice {
  /**
   * @type {Firehose|null}
   */
  #firehose = null

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
   * @returns {Promise<GPT>}
   */
  async getGpt(lun) {
    let primaryCorrupted = true;
    let backupCorrupted = true;
    let headerConsistency = false;

    // TODO: get sector size from getStorageInfo
    const primaryGpt = new GPT(this.firehose.cfg.SECTOR_SIZE_IN_BYTES);
    const primaryHeader = primaryGpt.parseHeader(await this.firehose.cmdReadBuffer(lun, 1, 1), 1n);
    if (primaryHeader === null) {
      // TODO: guess alternate lba and continue
      throw new Error("Could not read GPT header");
    }
    const { mismatchCrc32: primaryPartEntriesMismatchCrc32 } = primaryGpt.parsePartEntries(await this.firehose.cmdReadBuffer(lun, primaryGpt.partEntriesStartLba, primaryGpt.partEntriesSectors));
    primaryCorrupted = primaryHeader.mismatchCrc32 || primaryPartEntriesMismatchCrc32;
    if (primaryGpt.currentLba !== sector) {
      logger.warn(`currentLba (${primaryGpt.currentLba}) does not match actual value (1)`);
      primaryCorrupted = true;
    }

    const backupGpt = new GPT(this.firehose.cfg.SECTOR_SIZE_IN_BYTES);
    const backupHeader = backupGpt.parseHeader(await this.firehose.cmdReadBuffer(lun, primaryGpt.alternateLba, 1), primaryGpt.alternateLba);
    if (backupHeader) {
      backupCorrupted = backupHeader.mismatchCrc32;
      headerConsistency = primaryHeader.headerCrc32 === backupHeader.headerCrc32;
    }

    if (primaryCorrupted) {
      if (backupCorrupted) {
        throw new Error("Both primary and backup GPT headers are corrupted, cannot recover");
      }
      // TODO: restore primary from backup
      logger.warn("Primary GPT header is corrupted, using backup");
      return backupGpt;
    }
    if (!headerConsistency) {
      logger.warn("Primary and backup GPT headers are inconsistent, using primary");
      // TODO: create backup from primary
      return primaryGpt;
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

    if (!await this.firehose.cmdProgram(lun, 0, primaryGptBlob)) {
      throw new Error("Failed to write primary GPT data");
    }

    // Fix the partition table, expanding last partition to fill available sectors
    await this.firehose.cmdFixGpt(lun, 1);

    // Read back GPT and create backup copy
    const primaryGpt = await this.getGpt(lun);
    const backupGpt = primaryGpt.asAlternate();
    const { header: backupHeader, partEntries: backupPartEntries } = backupGpt.build();

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
      protectedRanges.push({ name: "mbr", start: 0, end: 0 });
    }
    if (preservePartitions.includes("gpt")) {
      protectedRanges.push({ name: "gpt-current", start: currentLba, end: firstUsableLba - 1 });
      protectedRanges.push({ name: "gpt-alternate", start: lastUsableLba + 1, end: alternateLba });
    }
    for (const name of preservePartitions) {
      const part = primaryGpt.locatePartition(name);
      if (!part) {
        logger.warn(`Partition ${name} not found in GPT`);
        continue;
      }
      protectedRanges.push({ name, start: part.start, end: part.end });
    }
    protectedRanges.sort((a, b) => a.start - b.start);

    /** @type {{ name: string; start: bigint; end: bigint }[]} */
    const mergedProtectedRanges = [];
    if (protectedRanges.length > 0) {
      let currentRange = {...protectedRanges[0]};
      for (let i = 1; i < protectedRanges.length; i++) {
        const nextRange = protectedRanges[i];
        if (nextRange.start <= currentRange.end + 1) {
          currentRange.end = Math.max(currentRange.end, nextRange.end);
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
      if (range.start > lastEndSector + 1) {
        erasableRanges.push({ start: lastEndSector + 1n, end: range.start - 1n });
      }
      lastEndSector = range.end;
    }
    if (lastEndSector < backupLba) {
      erasableRanges.push({ start: lastEndSector + 1n, end: backupLba });
    }

    for (const range of erasableRanges) {
      const sectors = range.end - range.start + 1n;
      logger.debug(`Erasing sectors ${range.start}-${range.end} (${sectors})`);

      // Erase command times out for larger numbers of sectors
      const maxSectors = 512 * 1024;
      let sector = range.start;
      while (sector <= range.end) {
        const chunkSectors = Math.min(Number(range.end - sector + 1), maxSectors);
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
      const gpt = await this.getGpt(lun);
      const partition = gpt.locatePartition(name);
      if (!partition) continue;
      return [true, lun, partition, gpt];
    }
    return [false];
  }

  /**
   * @param {string} name
   * @param {Blob} blob
   * @param {progressCallback} [onProgress] - Returns number of bytes written
   * @returns {Promise<boolean>}
   */
  async flashBlob(name, blob, onProgress) {
    const [found, lun, partition, gpt] = await this.detectPartition(name);
    if (!found) {
      throw `Can't find partition ${name}`;
    }
    if (name.toLowerCase() === "gpt") {
      // TODO: error?
      return true;
    }
    const imgSectors = Math.ceil(blob.size / gpt.sectorSize);
    if (imgSectors > partition.sectors) {
      logger.error("partition has fewer sectors compared to the flashing image");
      return false;
    }
    logger.info(`Flashing ${name}...`);
    logger.debug(`startSector ${partition.start}, sectors ${partition.sectors}`);
    const sparse = await Sparse.from(blob);
    if (sparse === null) {
      return await this.firehose.cmdProgram(lun, partition.start, blob, onProgress);
    }
    logger.debug(`Erasing ${name}...`);
    if (!await this.firehose.cmdErase(lun, partition.start, partition.sectors)) {
      logger.error("Failed to erase partition before sparse flashing");
      return false;
    }
    logger.debug(`Writing chunks to ${name}...`);
    for await (const [offset, chunk] of sparse.read()) {
      if (!chunk) continue;
      if (offset % gpt.sectorSize !== 0) {
        throw "qdl - Offset not aligned to sector size";
      }
      const sector = (partition.start + BigInt(offset)) / BigInt(gpt.sectorSize);
      const onChunkProgress = (progress) => onProgress?.(offset + progress);
      if (!await this.firehose.cmdProgram(lun, sector, chunk, onChunkProgress)) {
        logger.debug("Failed to program chunk")
        return false;
      }
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

  /**
   * @param {"a"|"b"} slot
   * @returns {Promise<boolean>}
   */
  async setActiveSlot(slot) {
    if (slot !== "a" && slot !== "b") throw new Error("Invalid slot");

    for (const lun of this.firehose.luns) {
      // Update all partitions in disk
      const gpt = await this.getGpt(lun);
      gpt.setActiveSlot(slot);

      // Write GPT header and partition entries
      const { header, partEntries } = gpt.build();
      await this.firehose.cmdProgram(lun, gpt.currentLba, new Blob([header]));
      await this.firehose.cmdProgram(lun, gpt.partEntriesStartLba, new Blob([partEntries]));
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
