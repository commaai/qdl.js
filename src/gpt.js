import { buf as crc32 } from "crc-32"
import { bytes, custom, string, struct, uint32, uint64 } from "@incognitojam/tiny-struct";

import { createLogger } from "./logger";
import { concatUint8Array } from "./utils";

const ATTRIBUTE_FLAG_OFFSET = 48n;
const AB_FLAG_OFFSET = ATTRIBUTE_FLAG_OFFSET + 6n;

const AB_PARTITION_ATTR_SLOT_ACTIVE = BigInt(0x1 << 2);
const AB_PARTITION_ATTR_BOOT_SUCCESSFUL = BigInt(0x1 << 6);
const AB_PARTITION_ATTR_UNBOOTABLE = BigInt(0x1 << 7);
const AB_PARTITION_ATTR_TRIES_MASK = BigInt(0xF << 8);

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
 * @see {@link https://uefi.org/specs/UEFI/2.10/Apx_A_GUID_and_Time_Formats.html#efi-guid-format-apxa-guid-and-time-formats}
 */
const guid = () => custom(16, (buffer, offset, littleEndian) => {
  const timeLow = buffer.getUint32(offset, littleEndian);
  const timeMid = buffer.getUint16(offset + 4, littleEndian);
  const timeHighAndVersion = buffer.getUint16(offset + 6, littleEndian);
  const clockSeqHighAndReserved = buffer.getUint8(offset + 8);
  const clockSeqLow = buffer.getUint8(offset + 9);
  // Node is always stored in big-endian format regardless of littleEndian flag
  const node = Array.from({ length: 6 }, (_, i) => buffer.getUint8(offset + 10 + i).toString(16).padStart(2, "0")).join("");

  return [
    timeLow.toString(16).padStart(8, "0"),
    timeMid.toString(16).padStart(4, "0"),
    timeHighAndVersion.toString(16).padStart(4, "0"),
    clockSeqHighAndReserved.toString(16).padStart(2, "0") + clockSeqLow.toString(16).padStart(2, "0"),
    node,
  ].join("-");
}, (buffer, offset, value, littleEndian) => {
  const parts = value.split("-");
  if (parts.length !== 5) throw new Error("Invalid GUID format");

  const timeLow = Number.parseInt(parts[0], 16);
  const timeMid = Number.parseInt(parts[1], 16);
  const timeHighAndVersion = Number.parseInt(parts[2], 16);
  const clockSeq = Number.parseInt(parts[3], 16);
  const clockSeqHighAndReserved = (clockSeq >> 8) & 0xFF;
  const clockSeqLow = clockSeq & 0xFF;

  buffer.setUint32(offset, timeLow, littleEndian);
  buffer.setUint16(offset + 4, timeMid, littleEndian);
  buffer.setUint16(offset + 6, timeHighAndVersion, littleEndian);
  buffer.setUint8(offset + 8, clockSeqHighAndReserved);
  buffer.setUint8(offset + 9, clockSeqLow);

  const nodeHex = parts[4];
  for (let i = 0; i < 6; i++) {
    buffer.setUint8(offset + 10 + i, Number.parseInt(nodeHex.substring(i * 2, i * 2 + 2), 16));
  }
});


/**
 * @see {@link https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html#gpt-header}
 */
const GPTHeader = struct("GPTHeader", {
  signature: string(8),  // must be "EFI PART"
  revision: uint32(),  // must be 0x00010000
  headerSize: uint32(),  // greater than or equal to 96, less than or equal to block size
  headerCrc32: uint32(),
  reserved: uint32(),  // must be zero
  currentLba: uint64(),
  alternateLba: uint64(),
  firstUsableLba: uint64(),
  lastUsableLba: uint64(),
  diskGuid: bytes(16),
  partEntryStartLba: uint64(),
  numPartEntries: uint32(),
  partEntrySize: uint32(),
  partEntriesCrc32: uint32(),
}, { littleEndian: true });


/**
 * @see {@link https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html#gpt-partition-entry-array}
 */
const GPTPartitionEntry = struct("GPTPartitionEntry", {
  type: guid(),
  unique: guid(),
  firstLba: uint64(),
  lastLba: uint64(),
  /**
   * @see {@link https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html#defined-gpt-partition-entry-attributes}
   */
  attributes: uint64(),
  name: utf16cstring(36),
}, { littleEndian: true });


export class GPT {
  /** @type {ReturnType<typeof GPTHeader.from>|null} */
  #header = null;
  /** @type {(ReturnType<typeof GPTPartitionEntry.from>|null)[]} */
  #partEntryArray = [];

  /**
   * @param {number} sectorSize
   */
  constructor(sectorSize) {
    this.sectorSize = sectorSize;
  }

  /**
   * @param {Uint8Array} data
   * @returns {{ currentLba: number; alternateLba: number; partEntryStartLba: number } | null}
   */
  parseHeader(data) {
    this.#header = GPTHeader.from(data);
    if (this.#header.signature !== "EFI PART") {
      logger.error(`Invalid signature: "${this.#header.signature}"`);
      return null;
    }
    if (this.#header.revision !== 0x10000) {
      logger.error(`Unknown GPT revision: ${this.#header.revision.toString(16)}`);
      return null;
    }
    if (this.#header.headerSize < 96 || this.#header.headerSize > this.sectorSize) {
      logger.error(`Invalid header size: ${this.#header.headerSize}`);
      return null;
    }
    const partTableSize = this.#header.numPartEntries * this.#header.partEntrySize;
    if (partTableSize > this.sectorSize) {
      logger.error(`Invalid partition table size: ${partTableSize}`);
      return null;
    }

    const actualHeaderCrc32 = crc32(data.subarray(0, this.#header.headerSize));
    const mismatchCrc32 = this.#header.headerCrc32 !== actualHeaderCrc32;
    if (mismatchCrc32) {
      logger.warn(`Header CRC32 mismatch: expected 0x${this.#header.headerCrc32.toString(16)}, actual 0x${actualHeaderCrc32.toString(16)}`);
    }

    return {
      currentLba: this.#header.currentLba,
      alternateLba: this.#header.alternateLba,
      partEntryStartLba: this.#header.partEntryStartLba,
      headerCrc32: this.#header.headerCrc32,
      mismatchCrc32,
    };
  }

  /**
   * @param {Uint8Array} data
   * @returns {{ mismatchCrc32: boolean }}
   */
  parsePartEntries(data) {
    const entrySize = this.#header.partEntrySize;
    for (let i = 0; i < this.#header.numPartEntries; i++) {
      const entryOffset = i * entrySize;
      const partEntry = GPTPartitionEntry.from(data.subarray(entryOffset, entryOffset + entrySize));
      this.#partEntryArray.push(partEntry);
    }

    const actualPartEntriesCrc32 = crc32(data);
    const mismatchCrc32 = this.#header.partEntriesCrc32 !== actualPartEntriesCrc32;
    if (mismatchCrc32) {
      logger.warn(`Partition entries CRC32 mismatch: expected 0x${this.#header.partEntriesCrc32.toString(16)}, actual 0x${actualPartEntriesCrc32.toString(16)}`);
    }

    return { mismatchCrc32 };
  }

  /**
   * @returns {GPT}
   */
  asAlternate() {
    const alternate = this.#header.$clone();
    alternate.currentLba = this.#header.alternateLba;
    alternate.alternateLba = this.#header.currentLba;

    const partEntriesSize = this.#header.numPartEntries * this.#header.partEntrySize;
    const partEntriesSectors = Math.ceil(partEntriesSize / this.sectorSize);
    alternate.partEntryStartLba = this.#header.alternateLba - BigInt(partEntriesSectors);

    const gpt = new GPT(this.sectorSize);
    gpt.#header = alternate;
    gpt.#partEntryArray = this.#partEntryArray.map((partEntry) => partEntry.$clone());
    return gpt;
  }

  /**
   * @returns {{ header: Uint8Array; partEntries: Uint8Array }}
   */
  build() {
    this.#header.headerCrc32 = 0;
    this.#header.partEntriesCrc32 = 0;

    const partEntries = concatUint8Array(this.#partEntryArray.map((partEntry) => partEntry.$toBuffer()));
    this.#header.partEntriesCrc32 = crc32(partEntriesData);

    let header = this.#header.$toBuffer();
    this.#header.headerCrc32 = crc32(header);
    // FIXME: update header CRC32 in place
    header = this.#header.$toBuffer();

    return { header, partEntries };
  }

  /**
   * @param {string} name
   * @returns {{ sector: bigint, sectors: number } | null}
   */
  locatePartition(name) {
    for (const partEntry of this.#partEntryArray) {
      if (partEntry.name !== name) continue;
      return {
        sector: partEntry.firstLba,
        sectors: partEntry.lastLba - partEntry.firstLba + 1n,
      };
    }
  }

  /**
   * @returns {"a"|"b"|null}
   */
  getActiveSlot() {
    for (const partEntry of this.#partEntryArray) {
      const slot = partEntry.name.slice(-2);
      const slotA = slot === "_a";
      const slotB = slot === "_b";
      if (!slotA && !slotB) continue;
      const flags = parseABFlags(partEntry.attributes);
      logger.debug(`${partEntry.name} flags:`, flags);
      if (flags.active) {
        if (slotA) return "a";
        if (slotB) return "b";
      }
    }
    return null;
  }

  /**
   * @param {"a"|"b"} slot
   */
  setActiveSlot(slot) {
    if (slot !== "a" && slot !== "b") throw new Error("Invalid slot");
    for (const partEntry of this.#partEntryArray) {
      const partSlot = partEntry.name.slice(-2);
      if (partSlot !== "_a" && partSlot !== "_b") continue;
      const bootable = partEntry.name === `boot${partSlot}`;
      partEntry.attributes = updateABFlags(partEntry.attributes, partSlot === slot, bootable, !bootable);
      logger.debug(`set ${partEntry.name} flags:`, parseABFlags(partEntry.attributes));
    }
  }
}


/**
 * @param {bigint} attributes
 * @returns {{ active: boolean, successful: boolean, unbootable: boolean, triesRemaining: number }}
 */
function parseABFlags(attributes) {
  // TODO: check partition type
  const abFlags = attributes >> AB_FLAG_OFFSET;
  return {
    active: (abFlags & AB_PARTITION_ATTR_SLOT_ACTIVE) !== 0n,
    successful: (abFlags & AB_PARTITION_ATTR_BOOT_SUCCESSFUL) !== 0n,
    unbootable: (abFlags & AB_PARTITION_ATTR_UNBOOTABLE) !== 0n,
    triesRemaining: Number((abFlags & AB_PARTITION_ATTR_TRIES_MASK) >> 8n),
  };
}


/**
 * @param {bigint} attributes
 * @param {boolean} active
 * @param {boolean} successful
 * @param {boolean} unbootable
 * @param {number} triesRemaining
 * @returns {bigint}
 */
function updateABFlags(attributes, active, successful, unbootable, triesRemaining = 0) {
  let ret = attributes;

  ret &= ~(AB_PARTITION_ATTR_SLOT_ACTIVE | AB_PARTITION_ATTR_BOOT_SUCCESSFUL | AB_PARTITION_ATTR_UNBOOTABLE | AB_PARTITION_ATTR_TRIES_MASK) << AB_FLAG_OFFSET;

  if (active) ret |= AB_PARTITION_ATTR_SLOT_ACTIVE << AB_FLAG_OFFSET;
  if (successful) ret |= AB_PARTITION_ATTR_BOOT_SUCCESSFUL << AB_FLAG_OFFSET;
  if (unbootable) ret |= AB_PARTITION_ATTR_UNBOOTABLE << AB_FLAG_OFFSET;

  const triesValue = (BigInt(triesRemaining) & 0xFn) << 8n;
  ret |= triesValue << AB_FLAG_OFFSET;

  return ret;
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
