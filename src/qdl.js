import { Firehose } from "./firehose"
import * as gpt from "./gpt"
import { Sahara } from "./sahara";
import * as Sparse from "./sparse";
import { concatUint8Array, containsBytes } from "./utils"


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
    console.debug("[qdl] QDL device detected");
    this.sahara = new Sahara(cdc, this.programmer);
    this.mode = await this.sahara.connect();
    if (this.mode === "sahara") {
      console.debug("[qdl] Connected to Sahara");
      this.mode = "sahara";
      await this.sahara.uploadLoader();
    } else if (this.mode !== "firehose") {
      throw new Error(`Unsupported mode: ${this.mode}. Please reboot the device.`);
    }
    this.#firehose = new Firehose(cdc);
    if (!await this.firehose.configure()) throw new Error("Could not configure Firehose");
    console.debug("[qdl] Firehose configured");
  }

  /**
   * @param {number} lun
   * @param {number} startSector
   * @returns {Promise<[gpt.gpt, Uint8Array] | [null, null]>}
   */
  async getGpt(lun, startSector=1) {
    let data = concatUint8Array([
      await this.firehose.cmdReadBuffer(lun, 0, 1),
      await this.firehose.cmdReadBuffer(lun, startSector, 1),
    ]);
    const guidGpt = new gpt.gpt();
    const header = guidGpt.parseHeader(data, this.firehose.cfg.SECTOR_SIZE_IN_BYTES);
    if (containsBytes("EFI PART", header.signature)) {
      const partTableSize = header.numPartEntries * header.partEntrySize;
      const sectors = Math.floor(partTableSize / this.firehose.cfg.SECTOR_SIZE_IN_BYTES);
      data = concatUint8Array([data, await this.firehose.cmdReadBuffer(lun, header.partEntryStartLba, sectors)]);
      guidGpt.parse(data, this.firehose.cfg.SECTOR_SIZE_IN_BYTES);
      return [guidGpt, data];
    } else {
      throw "Error reading gpt header";
    }
  }

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
      console.error("partition has fewer sectors compared to the flashing image");
      return false;
    }
    console.info(`Flashing ${partitionName}...`);
    console.debug(`startSector ${partition.sector}, sectors ${partition.sectors}`);
    const sparse = await Sparse.from(blob);
    if (sparse === null) {
      return await this.firehose.cmdProgram(lun, partition.sector, blob, onProgress);
    }
    console.debug(`Erasing ${partitionName}...`);
    if (!await this.firehose.cmdErase(lun, partition.sector, partition.sectors)) {
      console.error("qdl - Failed to erase partition before sparse flashing");
      return false;
    }
    console.debug(`Writing chunks to ${partitionName}...`);
    for await (const [offset, chunk] of sparse.read()) {
      if (!chunk) continue;
      if (offset % this.firehose.cfg.SECTOR_SIZE_IN_BYTES !== 0) {
        throw "qdl - Offset not aligned to sector size";
      }
      const sector = partition.sector + offset / this.firehose.cfg.SECTOR_SIZE_IN_BYTES;
      const onChunkProgress = (progress) => onProgress?.(offset + progress);
      if (!await this.firehose.cmdProgram(lun, sector, chunk, onChunkProgress)) {
        console.debug("qdl - Failed to program chunk")
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
        console.info(`Erasing ${partitionName}...`);
        await this.firehose.cmdErase(lun, partition.sector, partition.sectors);
        console.debug(`Erased ${partitionName} starting at sector ${partition.sector} with sectors ${partition.sectors}`);
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

  async getActiveSlot() {
    const luns = this.firehose.luns;
    for (const lun of luns) {
      const [guidGpt] = await this.getGpt(lun);
      if (guidGpt === null) {
        throw "Cannot get active slot."
      }
      for (const partitionName in guidGpt.partentries) {
        const slot = partitionName.slice(-2);
        // backup gpt header is more reliable, since it should always have the non-corrupted gpt header
        const [backupGuidGpt] = await this.getGpt(lun, guidGpt.header.backupLba);
        const partition = backupGuidGpt.partentries[partitionName];
        const active = (((BigInt(partition.flags) >> (BigInt(gpt.AB_FLAG_OFFSET) * BigInt(8))))
                      & BigInt(gpt.AB_PARTITION_ATTR_SLOT_ACTIVE)) === BigInt(gpt.AB_PARTITION_ATTR_SLOT_ACTIVE);
        if (slot === "_a" && active) {
          return "a";
        } else if (slot === "_b" && active) {
          return "b";
        }
      }
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

  patchNewGptData(gptDataA, gptDataB, guidGpt, partA, partB, slot_a_status, slot_b_status, isBoot) {
    const partEntrySize = guidGpt.header.partEntrySize;

    const sdataA = gptDataA.slice(partA.entryOffset, partA.entryOffset+partEntrySize);
    const sdataB = gptDataB.slice(partB.entryOffset, partB.entryOffset+partEntrySize);

    const partEntryA = new gpt.gptPartition(sdataA);
    const partEntryB = new gpt.gptPartition(sdataB);

    partEntryA.flags = gpt.setPartitionFlags(partEntryA.flags, slot_a_status, isBoot);
    partEntryB.flags = gpt.setPartitionFlags(partEntryB.flags, slot_b_status, isBoot);
    const tmp = partEntryB.type;
    partEntryB.type = partEntryA.type;
    partEntryA.type = tmp;
    const pDataA = partEntryA.create(), pDataB = partEntryB.create();

    return [pDataA, partA.entryOffset, pDataB, partB.entryOffset];
  }

  async setActiveSlot(slot) {
    slot = slot.toLowerCase();
    const luns = this.firehose.luns
    let slot_a_status, slot_b_status;

    if (slot === "a") {
      slot_a_status = true;
    } else if (slot === "b") {
      slot_a_status = false;
    }
    slot_b_status = !slot_a_status;

    for (const lunA of luns) {
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
        const [pDataA, pOffsetA, pDataB, pOffsetB] = this.patchNewGptData(
          gptDataA, gptDataB, guidGptA, partA, partB, slot_a_status, slot_b_status, isBoot
        );

        gptDataA.set(pDataA, pOffsetA)
        guidGptA.fixGptCrc(gptDataA);
        if (lunA === lunB) {
          gptDataB = gptDataA;
        }
        gptDataB.set(pDataB, pOffsetB)
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
    console.info(`Successfully set slot ${slot} active`);
    return true;
  }

  async reset() {
    await this.firehose.cmdReset();
    return true;
  }
}
