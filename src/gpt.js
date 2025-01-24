import { buf as crc32 } from "crc-32"

import { containsBytes, bytes2Number } from "./utils"

export const AB_FLAG_OFFSET = 6;
export const AB_PARTITION_ATTR_SLOT_ACTIVE = (0x1 << 2);
export const PART_ATT_PRIORITY_BIT = BigInt(48)
export const PART_ATT_ACTIVE_BIT = BigInt(50)
export const PART_ATT_ACTIVE_VAL = BigInt(0x1) << PART_ATT_ACTIVE_BIT

const efiType = {
  0x00000000 : "EFI_UNUSED",
  0xEBD0A0A2 : "EFI_BASIC_DATA",
}


export class structHelper {
  constructor(data, pos = 0) {
    this.pos = pos;
    this.data = data;
  }

  qword(littleEndian=true) {
    const view = new DataView(this.data.slice(this.pos, this.pos+8).buffer, 0);
    return Number(view.getBigUint64(0, littleEndian));
  }

  dword(littleEndian=true) {
    let view = new DataView(this.data.slice(this.pos, this.pos+4).buffer, 0);
    return view.getUint32(0, littleEndian);
  }

  bytes(rlen=1) {
    return this.data.slice(this.pos, this.pos + rlen);
  }

  toString(rlen=1) {
    return this.data.slice(this.pos, this.pos + rlen);
  }
}


class gptHeader {
  constructor(data) {
    let sh = new structHelper(data);
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
    let sh = new structHelper(data)
    this.type = sh.bytes(16);
    this.unique = sh.bytes(16);
    this.firstLba = sh.qword();
    this.lastLba = sh.qword();
    this.flags = sh.qword();
    this.name = sh.toString(72);
  }

  create() {
    let buffer = new ArrayBuffer(16 + 16 + 8 + 8 + 8 + 72);
    let view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < this.type.length; i++) {
      view.setUint8(offset++, this.type[i], true);
    }
    for (let i = 0; i < this.unique.length; i++) {
      view.setUint8(offset++, this.unique[i], true);
    }
    let tmp = [BigInt(this.firstLba), BigInt(this.lastLba), BigInt(this.flags)];
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


class partf {
  firstLba = 0;
  lastLba = 0;
  flags = 0;
  sector = 0;
  sectors = 0;
  entryOffset = 0;
  type = null;
  name = "";
  unique = new Uint8Array();
}


export class gpt {
  constructor() {
    this.header = null;
    this.sectorSize = null;
    this.partentries = {};
  }

  parseHeader(gptData, sectorSize=512) {
    return new gptHeader(gptData.slice(sectorSize, sectorSize + 0x5C));
  }

  parse(gptData, sectorSize=512) {
    this.header = new gptHeader(gptData.slice(sectorSize, sectorSize + 0x5C));
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

      let partentry = new gptPartition(data);
      let pa = new partf();
      const guid1 = new DataView(partentry.unique.slice(0, 0x4).buffer, 0).getUint32(0, true);
      const guid2 = new DataView(partentry.unique.slice(0x4, 0x6).buffer, 0).getUint16(0, true);
      const guid3 = new DataView(partentry.unique.slice(0x6, 0x8).buffer, 0).getUint16(0, true);
      const guid4 = new DataView(partentry.unique.slice(0x8, 0xA).buffer, 0).getUint16(0, true);
      const guid5 = Array.from(partentry.unique.subarray(0xA, 0x10))
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('');
      pa.unique =`${guid1.toString(16).padStart(8, '0')}-
                  ${guid2.toString(16).padStart(4, '0')}-
                  ${guid3.toString(16).padStart(4, '0')}-
                  ${guid4.toString(16).padStart(4, '0')}-
                  ${guid5}`;
      pa.sector = partentry.firstLba;
      pa.sectors = partentry.lastLba - partentry.firstLba + 1;
      pa.flags = partentry.flags;
      pa.entryOffset = start + (idx * entrySize);
      const typeOfPartentry = new DataView(partentry.type.slice(0, 0x4).buffer, 0).getUint32(0, true);
      if (typeOfPartentry in efiType) {
        pa.type = efiType[typeOfPartentry];
      } else {
        pa.type = typeOfPartentry.toString(16);
      }
      let nullIndex = Array.from(partentry.name).findIndex((element, index) => index % 2 === 0 && element === 0);
      let nameWithoutNull = partentry.name.slice(0, nullIndex);
      let decodedName = new TextDecoder('utf-16').decode(nameWithoutNull);
      pa.name = decodedName;
      if (pa.type === "EFI_UNUSED") {
        continue;
      }
      this.partentries[pa.name] = pa;
    }
    return true;
  }

  fixGptCrc(data) {
    const headerOffset = this.sectorSize;
    const partentryOffset = 2 * this.sectorSize;
    const partentrySize = this.header.numPartEntries * this.header.partEntrySize;
    const partdata = Uint8Array.from(data.slice(partentryOffset, partentryOffset + partentrySize));
    let headerdata = Uint8Array.from(data.slice(headerOffset, headerOffset + this.header.headerSize));

    let view = new DataView(new ArrayBuffer(4));
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


// 0x003a for inactive and 0x006f for active boot partitions. This follows fastboot standard
export function setPartitionFlags(flags, active, isBoot) {
  let newFlags = BigInt(flags);
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
  return Number(newFlags);
}


function checkHeaderCrc(gptData, guidGpt) {
  const headerOffset = guidGpt.sectorSize;
  const headerSize = guidGpt.header.headerSize;
  const testGptData = guidGpt.fixGptCrc(gptData).buffer;
  const testHeader = new Uint8Array(testGptData.slice(headerOffset, headerOffset + headerSize));

  const headerCrc = guidGpt.header.crc32;
  const testHeaderCrc = bytes2Number(testHeader.slice(0x10, 0x10 + 4));
  const partTableCrc = guidGpt.header.crc32PartEntries;
  const testPartTableCrc = bytes2Number(testHeader.slice(0x58, 0x58 + 4));

  return [(headerCrc !== testHeaderCrc) || (partTableCrc !== testPartTableCrc), partTableCrc];
}


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
