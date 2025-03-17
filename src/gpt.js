import { buf as crc32 } from "crc-32"
import { bytes, custom, string, struct, uint32, uint64 } from "@incognitojam/tiny-struct";

import { createLogger } from "./logger";

export const AB_FLAG_OFFSET = 6;
export const AB_PARTITION_ATTR_SLOT_ACTIVE = (0x1 << 2);
export const PART_ATT_PRIORITY_BIT = BigInt(48)
export const PART_ATT_ACTIVE_BIT = BigInt(50)
export const PART_ATT_ACTIVE_VAL = BigInt(0x1) << PART_ATT_ACTIVE_BIT

const efiType = {
  0x00000000 : "EFI_UNUSED",
  0xEBD0A0A2 : "EFI_BASIC_DATA",
}

const logger = createLogger("gpt");

const utf16cstring = (maxLength) => custom(maxLength * 2, (buffer, offset, littleEndian) => {
  const charCodes = [];
  for (let i = 0; i < maxLength; i++) {
    const charCode = buffer.getUint16(offset + i * 2, littleEndian);
    if (charCode === 0) break;
    charCodes.push(charCode);
  }
  return String.fromCharCode(...charCodes);
}, (buffer, offset, value, littleEndian) => {
  const length = Math.min(value.length, maxLength - 1);
  for (let i = 0; i < length; i++) {
    buffer.setUint16(offset + i * 2, value.charCodeAt(i), littleEndian);
  }
  buffer.setUint16(offset + length * 2, 0, littleEndian);
});


/**
 * @see {@link https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html#gpt-header}
 */
const GPTHeader = struct("GPTHeader", {
  signature: string(8),  // must be "EFI PART"
  revision: uint32(),  // must be 0x00010000
  headerSize: uint32(),  // greater than or equal to 96, less than or equal to block size
  crc32: uint32(),
  reserved: uint32(),  // must be zero
  currentLba: uint64(),
  backupLba: uint64(),
  firstUsableLba: uint64(),
  lastUsableLba: uint64(),
  diskGuid: bytes(16),
  partEntryStartLba: uint64(),
  numPartEntries: uint32(),
  partEntrySize: uint32(),
  crc32PartEntries: uint32(),
}, { littleEndian: true });


// FIXME: required until we switch to typescript, types from tiny-struct can't be exported
/**
 * @typedef {Object} BasicGPTHeader
 * @property {string} signature
 * @property {number} revision
 * @property {number} headerSize
 * @property {number} crc32
 * @property {bigint} currentLba
 * @property {bigint} backupLba
 * @property {bigint} firstUsableLba
 * @property {bigint} lastUsableLba
 * @property {Uint8Array} diskGuid
 * @property {bigint} partEntryStartLba
 * @property {number} numPartEntries
 * @property {number} partEntrySize
 * @property {number} crc32PartEntries
 */


/**
 * @see {@link https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html#gpt-partition-entry-array}
 */
const GPTPartitionEntry = struct("GPTPartitionEntry", {
  type: bytes(16),
  /**
   * @see {@link https://uefi.org/specs/UEFI/2.10/Apx_A_GUID_and_Time_Formats.html#efi-guid-format-apxa-guid-and-time-formats}
   */
  unique: bytes(16),
  firstLba: uint64(),
  lastLba: uint64(),
  flags: uint64(),
  name: utf16cstring(36),
}, { littleEndian: true });


export class partf {
  firstLba = 0n;
  lastLba = 0n;
  flags = 0n;
  sector = 0n;
  sectors = 0n;
  entryOffset = 0;
  type = null;
  name = "";
  unique = new Uint8Array();
}


export class gpt {
  /**
   * @param {number} sectorSize
   */
  constructor(sectorSize) {
    this.sectorSize = sectorSize;
    /** @type {BasicGPTHeader|null} */
    this.header = null;
    /** @type {Record<string, partf>} */
    this.partentries = {};
  }

  /**
   * @param {Uint8Array} gptData
   * @returns {BasicGPTHeader|null}
   */
  parseHeader(gptData) {
    this.header = GPTHeader.from(gptData);
    if (this.header.signature !== "EFI PART") {
      logger.error(`Invalid signature: "${this.header.signature}"`);
      return null;
    }
    if (this.header.revision !== 0x10000) {
      logger.error(`Unknown GPT revision: ${this.header.revision.toString(16)}`);
      return null;
    }
    return this.header;
  }

  /**
   * @param {Uint8Array} partTableData
   */
  parsePartTable(partTableData) {
    const entrySize = this.header.partEntrySize;
    this.partentries = {};
    for (let idx = 0; idx < this.header.numPartEntries; idx++) {
      const entryOffset = idx * entrySize;
      const partEntry = GPTPartitionEntry.from(partTableData.subarray(entryOffset, entryOffset + entrySize));
      const pa = new partf();
      pa.entryOffset = entryOffset;

      const typeOfPartEntry = new DataView(partEntry.type.buffer).getUint32(0, true);
      if (typeOfPartEntry in efiType) {
        pa.type = efiType[typeOfPartEntry];
      } else {
        pa.type = typeOfPartEntry.toString(16);
      }
      if (pa.type === "EFI_UNUSED") continue;

      const guidView = new DataView(partEntry.unique.buffer);
      const timeLow = guidView.getUint32(0, true);
      const timeMid = guidView.getUint16(4, true);
      const timeHighAndVersion = guidView.getUint16(6, true);
      const clockSeqHighAndReserved = guidView.getUint8(8);
      const clockSeqLow = guidView.getUint8(9);
      const node = Array.from(partEntry.unique.slice(10, 16))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

      pa.unique = [
        timeLow.toString(16).padStart(8, "0"),
        timeMid.toString(16).padStart(4, "0"),
        timeHighAndVersion.toString(16).padStart(4, "0"),
        clockSeqHighAndReserved.toString(16).padStart(2, "0") + clockSeqLow.toString(16).padStart(2, "0"),
        node,
      ].join("-");
      pa.sector = partEntry.firstLba;
      pa.sectors = partEntry.lastLba - partEntry.firstLba + 1n;
      pa.flags = partEntry.flags;
      pa.name = partEntry.name;

      this.partentries[pa.name] = pa;
    }
  }

  /**
   * @param {Uint8Array} data
   * @returns {Uint8Array}
   */
  fixGptCrc(data) {
    const headerOffset = this.sectorSize;
    const partentryOffset = 2 * this.sectorSize;
    const partentrySize = this.header.numPartEntries * this.header.partEntrySize;
    const partdata = Uint8Array.from(data.slice(partentryOffset, partentryOffset + partentrySize));
    const headerdata = Uint8Array.from(data.slice(headerOffset, headerOffset + this.header.headerSize));

    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, crc32(partdata), true);
    headerdata.set(new Uint8Array(view.buffer), 0x58);
    view.setInt32(0, 0, true);
    headerdata.set(new Uint8Array(view.buffer) , 0x10);
    view.setInt32(0, crc32(headerdata), true);
    headerdata.set(new Uint8Array(view.buffer), 0x10);

    data.set(headerdata, headerOffset);
    return data;
  }
}


/**
 * @param {bigint} flags
 * @param {boolean} active
 * @param {boolean} isBoot
 * @returns {bigint}
 */
export function setPartitionFlags(flags, active, isBoot) {
  // 0x003a for inactive and 0x006f for active boot partitions. This follows fastboot standard
  let newFlags = flags;
  if (active) {
    if (isBoot) {
      newFlags = BigInt(0x006f) << PART_ATT_PRIORITY_BIT;
    } else {
      newFlags |= PART_ATT_ACTIVE_VAL;
    }
  } else {
    if (isBoot) {
      newFlags = BigInt(0x003a) << PART_ATT_PRIORITY_BIT;
    } else {
      newFlags &= ~PART_ATT_ACTIVE_VAL;
    }
  }
  return newFlags;
}


/**
 * @param {partf} partition
 * @returns {boolean}
 */
export function isPartitionActive(partition) {
  return (((BigInt(partition.flags) >> (BigInt(AB_FLAG_OFFSET) * BigInt(8))))
    & BigInt(AB_PARTITION_ATTR_SLOT_ACTIVE)) === BigInt(AB_PARTITION_ATTR_SLOT_ACTIVE);
}


/**
 * @param {Uint8Array} gptData
 * @param {gpt} guidGpt
 * @returns {[boolean, number]}
 */
export function checkHeaderCrc(gptData, guidGpt) {
  const headerOffset = guidGpt.sectorSize;
  const headerSize = guidGpt.header.headerSize;
  const testGptData = guidGpt.fixGptCrc(gptData).buffer;
  const testHeader = new Uint8Array(testGptData.slice(headerOffset, headerOffset + headerSize));
  const testView = new DataView(testHeader.buffer);

  const headerCrc = guidGpt.header.crc32;
  const testHeaderCrc = testView.getUint32(0x10, true);
  const partTableCrc = guidGpt.header.crc32PartEntries;
  const testPartTableCrc = testView.getUint32(0x58, true);

  return [(headerCrc !== testHeaderCrc) || (partTableCrc !== testPartTableCrc), partTableCrc];
}


/**
 * @param {Uint8Array} gptData
 * @param {Uint8Array} backupGptData
 * @param {gpt} guidGpt
 * @param {gpt} backupGuidGpt
 * @returns {Uint8Array}
 */
export function ensureGptHdrConsistency(gptData, backupGptData, guidGpt, backupGuidGpt) {
  const partTableOffset = guidGpt.sectorSize * 2;

  const [primCorrupted, primPartTableCrc] = checkHeaderCrc(gptData, guidGpt);
  const [backupCorrupted, backupPartTableCrc] = checkHeaderCrc(backupGptData, backupGuidGpt);

  const headerConsistency = primPartTableCrc === backupPartTableCrc;
  if (primCorrupted || !headerConsistency) {
    if (backupCorrupted) {
      throw "Both primary and backup gpt headers are corrupted, cannot recover";
    }
    gptData.set(backupGptData.slice(partTableOffset), partTableOffset);
    gptData = guidGpt.fixGptCrc(gptData);
  }
  return gptData;
}


/**
 * @param {Uint8Array} primaryGptData - The original GPT data containing the primary header
 * @param {gpt} primaryGpt - The parsed GPT object
 * @returns {[[Uint8Array, bigint], [Uint8Array, bigint]]} The backup GPT data and partition table, and where they should be written
 */
export function createBackupGptHeader(primaryGptData, primaryGpt) {
  const sectorSize = primaryGpt.sectorSize;
  const headerSize = primaryGpt.header.headerSize;

  const backupHeader = new Uint8Array(headerSize);
  backupHeader.set(primaryGptData.slice(sectorSize, sectorSize + headerSize));

  const partTableOffset = primaryGpt.sectorSize * 2;
  const partTableSize = primaryGpt.header.numPartEntries * primaryGpt.header.partEntrySize;
  const partTableSectors = Math.ceil(partTableSize / sectorSize);
  const partTableData = primaryGptData.slice(partTableOffset, partTableOffset + partTableSize);

  const backupView = new DataView(backupHeader.buffer);
  backupView.setUint32(16, 0, true);  // crc32
  backupView.setBigUint64(24, BigInt(primaryGpt.header.backupLba), true);  // currentLba
  backupView.setBigUint64(32, BigInt(primaryGpt.header.currentLba), true);  // backupLba

  const backupPartTableLba = primaryGpt.header.backupLba - BigInt(partTableSectors);
  backupView.setBigUint64(0x48, backupPartTableLba, true);

  const partEntriesCrc = crc32(partTableData);
  backupView.setInt32(88, partEntriesCrc, true);

  const crcValue = crc32(backupHeader);
  backupView.setInt32(16, crcValue, true);

  return [[backupHeader, primaryGpt.header.backupLba], [partTableData, backupPartTableLba]];
}


/**
 * @param {gpt} mainGpt
 * @param {gpt} backupGpt
 * @returns {"a"|"b"|null}
 */
export function getActiveSlot(mainGpt, backupGpt) {
  for (const partitionName in mainGpt.partentries) {
    const slot = partitionName.slice(-2);
    if (slot !== "_a" && slot !== "_b") continue;
    let partition = backupGpt.partentries[partitionName];
    if (!partition) {
      logger.warn(`Partition ${partitionName} not found in backup GPT`);
      partition = mainGpt.partentries[partitionName];
    }
    if (isPartitionActive(partition)) {
      if (slot === "_a") return "a";
      if (slot === "_b") return "b";
    }
  }
}


/**
 * @param {Uint8Array} gptDataA
 * @param {Uint8Array} gptDataB
 * @param {partf} partA
 * @param {partf} partB
 * @param {"a"|"b"} slot
 * @param {boolean} isBoot
 * @returns {[ArrayBuffer, ArrayBuffer]}
 */
export function patchNewGptData(gptDataA, gptDataB, partA, partB, slot, isBoot) {
  const partEntryA = GPTPartitionEntry.from(gptDataA.subarray(partA.entryOffset));
  partEntryA.flags = setPartitionFlags(partEntryA.flags, slot === "a", isBoot);

  const partEntryB = GPTPartitionEntry.from(gptDataB.subarray(partB.entryOffset));
  partEntryB.flags = setPartitionFlags(partEntryB.flags, slot === "b", isBoot);

  const tmp = partEntryB.type;
  partEntryB.type = partEntryA.type;
  partEntryA.type = tmp;

  return [partEntryA.$toBuffer(), partEntryB.$toBuffer()];
}
