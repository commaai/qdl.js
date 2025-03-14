import { buf as crc32 } from "crc-32"

import { containsBytes, StructHelper } from "./utils"

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

  const backupPartTableLba = primaryGpt.header.backupLba - partTableSectors;
  backupView.setBigUint64(0x48, BigInt(backupPartTableLba), true);

  const partEntriesCrc = crc32(partTableData);
  backupView.setInt32(88, partEntriesCrc, true);

  const crcValue = crc32(backupHeader);
  backupView.setInt32(16, crcValue, true);

  return [[backupHeader, primaryGpt.header.backupLba], [partTableData, backupPartTableLba]];
}

export const AB_FLAG_OFFSET = 6;
export const AB_PARTITION_ATTR_SLOT_ACTIVE = (0x1 << 2);
export const PART_ATT_PRIORITY_BIT = BigInt(48)
export const PART_ATT_ACTIVE_BIT = BigInt(50)
export const PART_ATT_ACTIVE_VAL = BigInt(0x1) << PART_ATT_ACTIVE_BIT

const efiType = {
  0x00000000 : "EFI_UNUSED",
  0xEBD0A0A2 : "EFI_BASIC_DATA",
}


class gptHeader {
  constructor(data) {
    const sh = new StructHelper(data);
    this.signature = sh.bytes(8);
    this.revision = sh.dword();
    this.headerSize = sh.dword();
    this.crc32 = sh.dword();
    this.reserved = sh.dword();
    this.currentLba = sh.qword();
    this.backupLba = sh.qword();
    this.firstUsableLba = sh.qword();
    this.lastUsableLba = sh.qword();
    this.diskGuid = sh.bytes(16);
    this.partEntryStartLba = sh.qword();
    this.numPartEntries = sh.dword();
    this.partEntrySize = sh.dword();
    this.crc32PartEntries = sh.dword();
  }
}


export class gptPartition {
  constructor(data) {
    const sh = new StructHelper(data)
    this.type = sh.bytes(16);
    this.unique = sh.bytes(16);
    this.firstLba = sh.qword();
    this.lastLba = sh.qword();
    this.flags = sh.qword();
    this.name = sh.bytes(72);
  }

  create() {
    const buffer = new ArrayBuffer(16 + 16 + 8 + 8 + 8 + 72);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < this.type.length; i++) {
      view.setUint8(offset++, this.type[i], true);
    }
    for (let i = 0; i < this.unique.length; i++) {
      view.setUint8(offset++, this.unique[i], true);
    }
    const tmp = [BigInt(this.firstLba), BigInt(this.lastLba), BigInt(this.flags)];
    for (let i = 0; i < 3; i++) {
      view.setBigUint64(offset, tmp[i], true);
      offset += 8;
    }
    for (let i = 0; i < 72; i++) {
      view.setUint8(offset++, this.name[i]);
    }
    return new Uint8Array(view.buffer);
  }
}


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
  constructor() {
    /** @type {gptHeader|null} */
    this.header = null;
    /** @type {number|null} */
    this.sectorSize = null;
    /** @type {Record<string, partf>} */
    this.partentries = {};
  }

  /**
   * @param {Uint8Array} gptData
   * @param {number} [sectorSize]
   * @returns {gptHeader}
   */
  parseHeader(gptData, sectorSize = 512) {
    return new gptHeader(gptData.slice(sectorSize, sectorSize + 0x5C));
  }

  /**
   * @param {Uint8Array} gptData
   * @param {number} [sectorSize]
   * @returns {boolean}
   */
  parse(gptData, sectorSize = 512) {
    this.header = this.parseHeader(gptData, sectorSize);
    this.sectorSize = sectorSize;

    if (!containsBytes("EFI PART", this.header.signature)) {
      return false;
    }

    if (this.header.revision !== 0x10000) {
      console.error("Unknown GPT revision.");
      return false;
    }

    // mbr (even for backup gpt header to ensure offset consistency) + gpt header + part_table
    const start = 2 * sectorSize;

    const entrySize = this.header.partEntrySize;
    this.partentries = {};
    const numPartEntries = this.header.numPartEntries;
    for (let idx = 0; idx < numPartEntries; idx++) {
      const data = gptData.slice(start + (idx * entrySize), start + (idx * entrySize) + entrySize);
      if (new DataView(data.slice(16,32).buffer, 0).getUint32(0, true) === 0) {
        break;
      }

      const partentry = new gptPartition(data);
      const uniqueView = new DataView(partentry.unique.buffer);
      const pa = new partf();
      const guid1 = uniqueView.getUint32(0x0, true);
      const guid2 = uniqueView.getUint16(0x4, true);
      const guid3 = uniqueView.getUint16(0x6, true);
      const guid4 = uniqueView.getUint16(0x8, true);
      const guid5 = Array.from(partentry.unique.subarray(0xA, 0x10))
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('');
      pa.unique =`${guid1.toString(16).padStart(8, '0')}-
                  ${guid2.toString(16).padStart(4, '0')}-
                  ${guid3.toString(16).padStart(4, '0')}-
                  ${guid4.toString(16).padStart(4, '0')}-
                  ${guid5}`;
      pa.sector = partentry.firstLba;
      pa.sectors = partentry.lastLba - partentry.firstLba + 1n;
      pa.flags = partentry.flags;
      pa.entryOffset = start + (idx * entrySize);
      const typeOfPartentry = new DataView(partentry.type.buffer).getUint32(0, true);
      if (typeOfPartentry in efiType) {
        pa.type = efiType[typeOfPartentry];
      } else {
        pa.type = typeOfPartentry.toString(16);
      }
      const nullIndex = Array.from(partentry.name).findIndex((element, index) => index % 2 === 0 && element === 0);
      const nameWithoutNull = partentry.name.slice(0, nullIndex);
      const decodedName = new TextDecoder('utf-16').decode(nameWithoutNull);
      pa.name = decodedName;
      if (pa.type === "EFI_UNUSED") {
        continue;
      }
      this.partentries[pa.name] = pa;
    }
    return true;
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
 * @param {Uint8Array} gptData
 * @param {gpt} guidGpt
 * @returns {[boolean, number]}
 */
function checkHeaderCrc(gptData, guidGpt) {
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
