import { buf as crc32 } from "crc-32"

import { createLogger } from "./logger";
import { guid, utf16cstring } from "./gpt-structs";
import { concatUint8Array } from "./utils";

const ATTRIBUTE_FLAG_OFFSET = 48n;
const AB_FLAG_OFFSET = ATTRIBUTE_FLAG_OFFSET + 6n;

const AB_PARTITION_ATTR_SLOT_ACTIVE = BigInt(0x1 << 2);
const AB_PARTITION_ATTR_BOOT_SUCCESSFUL = BigInt(0x1 << 6);
const AB_PARTITION_ATTR_UNBOOTABLE = BigInt(0x1 << 7);
const AB_PARTITION_ATTR_TRIES_MASK = BigInt(0xF << 8);

const logger = createLogger("gpt");


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
  partEntriesStartLba: uint64(),
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
  #partEntries = [];
  /** @type {bigint} */
  #partEntriesSectors = 0n;

  /** @param {number} sectorSize */
  constructor(sectorSize) {
    this.sectorSize = sectorSize;
  }

  /** @returns {bigint} */
  get currentLba() {
    return this.#header.currentLba;
  }

  /** @returns {bigint} */
  get alternateLba() {
    return this.#header.alternateLba;
  }

  /** @returns {bigint} */
  get partEntriesStartLba() {
    return this.#header.partEntriesStartLba;
  }

  /** @returns {bigint} */
  get partEntriesSectors() {
    return this.#partEntriesSectors;
  }

  /** @returns {bigint} */
  get firstUsableLba() {
    return this.#header.firstUsableLba;
  }

  /** @returns {bigint} */
  get lastUsableLba() {
    return this.#header.lastUsableLba;
  }

  /**
   * @param {Uint8Array} data
   * @returns {{ headerCrc32: number; mismatchCrc32: boolean } | null}
   */
  parseHeader(data, actualLba) {
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
    if (this.#header.currentLba !== actualLba) {
      logger.warn(`currentLba (${this.#header.currentLba}) does not match actual value (${actualLba})`);
      return null;
    }

    const actualHeaderCrc32 = crc32(data.subarray(0, this.#header.headerSize));
    const mismatchCrc32 = this.#header.headerCrc32 !== actualHeaderCrc32;
    if (mismatchCrc32) {
      logger.warn(`Header CRC32 mismatch: expected 0x${this.#header.headerCrc32.toString(16)}, actual 0x${actualHeaderCrc32.toString(16)}`);
    }

    this.#partEntriesSectors = BigInt(Math.ceil((this.#header.partEntrySize * this.#header.numPartEntries) / this.sectorSize));
    return {
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
      this.#partEntries.push(partEntry);
    }

    const actualPartEntriesCrc32 = crc32(data);
    const mismatchCrc32 = this.#header.partEntriesCrc32 !== actualPartEntriesCrc32;
    if (mismatchCrc32) {
      logger.warn(`Partition entries CRC32 mismatch: expected 0x${this.#header.partEntriesCrc32.toString(16)}, actual 0x${actualPartEntriesCrc32.toString(16)}`);
    }

    return { mismatchCrc32 };
  }

  /** @returns {GPT} */
  asAlternate() {
    const alternate = this.#header.$clone();
    alternate.currentLba = this.#header.alternateLba;
    alternate.alternateLba = this.#header.currentLba;
    alternate.partEntryStartLba = this.#header.alternateLba - this.#partEntriesSectors;

    const gpt = new GPT(this.sectorSize);
    gpt.#header = alternate;
    gpt.#partEntries = this.#partEntries.map((partEntry) => partEntry.$clone());
    gpt.#partEntriesSectors = this.#partEntriesSectors;
    return gpt;
  }

  /** @returns {{ header: Uint8Array; partEntries: Uint8Array }} */
  build() {
    this.#header.headerCrc32 = 0;
    this.#header.partEntriesCrc32 = 0;

    const partEntries = concatUint8Array(this.#partEntries.map((entry) => entry.$toBuffer()));
    this.#header.partEntriesCrc32 = crc32(partEntriesData);

    let header = this.#header.$toBuffer();
    this.#header.headerCrc32 = crc32(header);
    header = this.#header.$toBuffer();

    return { header, partEntries };
  }

  /**
   * @param {string} name
   * @returns {{ sector: bigint, sectors: bigint } | null}
   */
  locatePartition(name) {
    for (const partEntry of this.#partEntries) {
      if (partEntry.name !== name) continue;
      return {
        sector: partEntry.firstLba,
        sectors: partEntry.lastLba - partEntry.firstLba + 1n,
      };
    }
  }

  /** @returns {"a" | "b" | null} */
  getActiveSlot() {
    for (const partEntry of this.#partEntries) {
      const slot = partEntry.name.slice(-2);
      const slotA = slot === "_a";
      if (!slotA && slot !== "_b") continue;
      const flags = parseABFlags(partEntry.attributes);
      logger.debug(`${partEntry.name} flags:`, flags);
      if (flags.active) return slotA ? "a" : "b";
    }
    return null;
  }

  /** @param {"a" | "b"} slot */
  setActiveSlot(slot) {
    if (slot !== "a" && slot !== "b") throw new Error("Invalid slot");
    for (const partEntry of this.#partEntries) {
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
