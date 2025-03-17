import { Firehose } from "./firehose"
import * as gpt from "./gpt"
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
   * @param {bigint} startSector
   * @returns {Promise<[gpt.gpt, Uint8Array]>}
   */
  async getGpt(lun, startSector = 1n) {
    const mbrData = await this.firehose.cmdReadBuffer(lun, 0, 1);
    const gptData = await this.firehose.cmdReadBuffer(lun, startSector, 1);
    const guidGpt = new gpt.gpt(this.firehose.cfg.SECTOR_SIZE_IN_BYTES);
    const header = guidGpt.parseHeader(gptData);
    if (header === null) {
      throw "Error reading gpt header";
    }
    const partTableSize = header.numPartEntries * header.partEntrySize;
    const sectors = Math.floor(partTableSize / this.firehose.cfg.SECTOR_SIZE_IN_BYTES);
    const partTableData = await this.firehose.cmdReadBuffer(lun, header.partEntryStartLba, sectors);
    guidGpt.parsePartTable(partTableData);
    return [guidGpt, concatUint8Array([mbrData, gptData, partTableData])];
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
    const [primaryGpt, primaryGptData] = await this.getGpt(lun);
    const [[backupGptData, backupLba], [partTableData, backupPartTableLba]] = gpt.createBackupGptHeader(primaryGptData, primaryGpt);

    logger.debug(`Writing backup partition table to LBA ${backupPartTableLba}`);
    if (!await this.firehose.cmdProgram(lun, backupPartTableLba, new Blob([partTableData]))) {
      throw new Error("Failed to write backup partition table");
    }

    logger.debug(`Writing backup GPT header to LBA ${backupLba}`);
    if (!await this.firehose.cmdProgram(lun, backupLba, new Blob([backupGptData]))) {
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
    const [mainGpt] = await this.getGpt(lun);
    if (mainGpt === null) {
      throw new Error(`Could not read GPT data for LUN ${lun}`);
    }

    const { currentLba, backupLba, firstUsableLba, lastUsableLba } = mainGpt.header;
    const protectedRanges = [];
    if (preservePartitions.includes("mbr")) {
      protectedRanges.push({ name: "mbr", start: 0, end: 0 });
    }
    if (preservePartitions.includes("gpt")) {
      protectedRanges.push({ name: "gpt-current", start: currentLba, end: firstUsableLba - 1 });
      protectedRanges.push({ name: "gpt-backup", start: lastUsableLba + 1, end: backupLba });
    }
    for (const name of preservePartitions) {
      if (!(name in mainGpt.partentries)) continue;
      const part = mainGpt.partentries[name];
      protectedRanges.push({ name, start: part.sector, end: part.sector + part.sectors - 1 });
    }
    protectedRanges.sort((a, b) => a.start - b.start);

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
      logger.debug(`Preserving ${range.name} (sectors ${range.start}-${range.end})`);
    }

    const erasableRanges = [];
    let lastEndSector = -1;
    for (const range of mergedProtectedRanges) {
      if (range.start > lastEndSector + 1) {
        erasableRanges.push({ start: lastEndSector + 1, end: range.start - 1 });
      }
      lastEndSector = range.end;
    }
    if (lastEndSector < backupLba) {
      erasableRanges.push({ start: lastEndSector + 1, end: backupLba });
    }

    for (const range of erasableRanges) {
      const sectors = range.end - range.start + 1;
      logger.debug(`Erasing sectors ${range.start}-${range.end} (${sectors} sectors)`);

      // Erase command times out for larger numbers of sectors
      const maxSectors = 512 * 1024;
      let sector = range.start;
      while (sector <= range.end) {
        const chunkSectors = Math.min(range.end - sector + 1, maxSectors);
        const result = await this.firehose.cmdErase(lun, sector, chunkSectors);
        if (!result) {
          logger.error(`Failed to erase sectors chunk ${sectors}-${sectors + chunkSectors - 1}`);
          return false;
        }
        sector = sector + chunkSectors;
      }
    }

    logger.info(`Successfully erased LUN ${lun} while preserving specified partitions`);
    return true;
  }

  /**
   * @param {string} partitionName
   * @param {boolean} [sendFull]
   * @returns {Promise<[false] | [true, number, Uint8Array, gpt.gpt] | [true, number, gpt.partf]>}
   */
  async detectPartition(partitionName, sendFull=false) {
    const luns = this.firehose.luns;
    for (const lun of luns) {
      const [guidGpt, data] = await this.getGpt(lun);
      if (guidGpt === null) {
        break;
      } else {
        if (partitionName in guidGpt.partentries) {
          return sendFull ? [true, lun, data, guidGpt] : [true, lun, guidGpt.partentries[partitionName]];
        }
      }
    }
    return [false];
  }

  /**
   * @param {string} partitionName
   * @param {Blob} blob
   * @param {progressCallback} [onProgress] - Returns number of bytes written
   * @returns {Promise<boolean>}
   */
  async flashBlob(partitionName, blob, onProgress) {
    const [found, lun, partition] = await this.detectPartition(partitionName);
    if (!found) {
      throw `Can't find partition ${partitionName}`;
    }
    if (partitionName.toLowerCase() === "gpt") {
      // TODO: error?
      return true;
    }
    const imgSectors = Math.ceil(blob.size / this.firehose.cfg.SECTOR_SIZE_IN_BYTES);
    if (imgSectors > partition.sectors) {
      logger.error("partition has fewer sectors compared to the flashing image");
      return false;
    }
    logger.info(`Flashing ${partitionName}...`);
    logger.debug(`startSector ${partition.sector}, sectors ${partition.sectors}`);
    const sparse = await Sparse.from(blob);
    if (sparse === null) {
      return await this.firehose.cmdProgram(lun, partition.sector, blob, onProgress);
    }
    logger.debug(`Erasing ${partitionName}...`);
    if (!await this.firehose.cmdErase(lun, partition.sector, partition.sectors)) {
      logger.error("Failed to erase partition before sparse flashing");
      return false;
    }
    logger.debug(`Writing chunks to ${partitionName}...`);
    for await (const [offset, chunk] of sparse.read()) {
      if (!chunk) continue;
      if (offset % this.firehose.cfg.SECTOR_SIZE_IN_BYTES !== 0) {
        throw "qdl - Offset not aligned to sector size";
      }
      const sector = (partition.sector + BigInt(offset)) / BigInt(this.firehose.cfg.SECTOR_SIZE_IN_BYTES);
      const onChunkProgress = (progress) => onProgress?.(offset + progress);
      if (!await this.firehose.cmdProgram(lun, sector, chunk, onChunkProgress)) {
        logger.debug("Failed to program chunk")
        return false;
      }
    }

    return true;
  }

  async erase(partitionName) {
    const luns = this.firehose.luns;
    for (const lun of luns) {
      const [guidGpt] = await this.getGpt(lun);
      if (partitionName in guidGpt.partentries) {
        const partition = guidGpt.partentries[partitionName];
        logger.info(`Erasing ${partitionName}...`);
        await this.firehose.cmdErase(lun, partition.sector, partition.sectors);
        logger.debug(`Erased ${partitionName} starting at sector ${partition.sector} with sectors ${partition.sectors}`)
      }
    }
    return true;
  }

  async getDevicePartitionsInfo() {
    const slots = [];
    const partitions = [];
    const luns = this.firehose.luns;
    for (const lun of luns) {
      const [guidGpt] = await this.getGpt(lun);
      if (guidGpt === null) {
        throw "Error while reading device partitions";
      }
      for (let partition in guidGpt.partentries) {
        const slot = partition.slice(-2);
        if (slot === "_a" || slot === "_b") {
          partition = partition.substring(0, partition.length-2);
          if (!slots.includes(slot)) {
            slots.push(slot);
          }
        }
        if (!partitions.includes(partition)) {
          partitions.push(partition);
        }
      }
    }
    return [slots.length, partitions];
  }

  /**
   * @returns {Promise<"a"|"b">}
   */
  async getActiveSlot() {
    for (const lun of this.firehose.luns) {
      const [mainGpt] = await this.getGpt(lun);
      // backup gpt header is more reliable, since it should always have the non-corrupted gpt header
      const [backupGpt] = await this.getGpt(lun, mainGpt.header.backupLba);
      const slot = gpt.getActiveSlot(mainGpt, backupGpt);
      if (slot) return slot;
    }
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
    if (slot !== "a" && slot !== "b") {
      throw new Error("Invalid slot");
    }

    for (const lunA of this.firehose.luns) {
      let checkGptHeader = false;
      let sameLun = false;
      let hasPartitionA = false;
      let [guidGptA, gptDataA] = await this.getGpt(lunA);
      if (guidGptA === null) {
        throw "Error while getting gpt header data";
      }

      const [backupGuidGptA, backupGptDataA] = await this.getGpt(lunA, guidGptA.header.backupLba);
      let lunB, gptDataB, guidGptB, backupGptDataB, backupGuidGptB;

      for (const partitionNameA in guidGptA.partentries) {
        const slotSuffix = partitionNameA.toLowerCase().slice(-2);
        if (slotSuffix !== "_a") {
          continue;
        }
        const partitionNameB = partitionNameA.slice(0, partitionNameA.length-1) + "b";
        let sts;
        if (!checkGptHeader) {
          hasPartitionA = true;
          if (partitionNameB in guidGptA.partentries) {
            lunB = lunA;
            sameLun = true;
            gptDataB = gptDataA;
            guidGptB = guidGptA;
            backupGptDataB = backupGptDataA;
            backupGuidGptB = backupGuidGptA;
          } else {
            const resp = await this.detectPartition(partitionNameB, true);
            sts = resp[0];
            if (!sts) {
              throw `Cannot find partition ${partitionNameB}`;
            }
            [sts, lunB, gptDataB, guidGptB] = resp;
            [backupGuidGptB, backupGptDataB] = await this.getGpt(lunB, guidGptB.header.backupLba);
          }
        }

        if (!checkGptHeader && partitionNameA.slice(0, 3) !== "xbl") { // xbl partitions aren't affected by failure of changing slot, saves time
          gptDataA = gpt.ensureGptHdrConsistency(gptDataA, backupGptDataA, guidGptA, backupGuidGptA);
          if (!sameLun) {
            gptDataB = gpt.ensureGptHdrConsistency(gptDataB, backupGptDataB, guidGptB, backupGuidGptB);
          }
          checkGptHeader = true;
        }

        const partA = guidGptA.partentries[partitionNameA];
        const partB = guidGptB.partentries[partitionNameB];

        let isBoot = false;
        if (partitionNameA === "boot_a") {
          isBoot = true;
        }
        const [pDataA, pDataB] = gpt.patchNewGptData(gptDataA, gptDataB, partA, partB, slot, isBoot);

        gptDataA.set(pDataA, partA.entryOffset);
        guidGptA.fixGptCrc(gptDataA);
        if (lunA === lunB) {
          gptDataB = gptDataA;
        }
        gptDataB.set(pDataB, partB.entryOffset);
        guidGptB.fixGptCrc(gptDataB);
      }

      if (!hasPartitionA) {
        continue;
      }
      const writeOffset = this.firehose.cfg.SECTOR_SIZE_IN_BYTES;
      const gptBlobA = new Blob([gptDataA.slice(writeOffset)]);
      await this.firehose.cmdProgram(lunA, 1, gptBlobA);
      if (!sameLun) {
        const gptBlobB = new Blob([gptDataB.slice(writeOffset)]);
        await this.firehose.cmdProgram(lunB, 1, gptBlobB);
      }
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
