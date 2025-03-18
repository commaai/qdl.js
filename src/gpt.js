import { buf as crc32 } from "crc-32"
import { bytes, int32, string, struct, uint32, uint64 } from "@incognitojam/tiny-struct";

import { createLogger } from "./logger";
import { guid, utf16cstring } from "./gpt-structs";

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
  signature: string(8),
  revision: uint32(),
  headerSize: uint32(),
  headerCrc32: int32(),
  reserved: uint32(),
  currentLba: uint64(),
  alternateLba: uint64(),
  firstUsableLba: uint64(),
  lastUsableLba: uint64(),
  diskGuid: bytes(16),
  partEntriesStartLba: uint64(),
  numPartEntries: uint32(),
  partEntrySize: uint32(),
  partEntriesCrc32: int32(),
}, { littleEndian: true });


/**
 * @see {@link https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html#gpt-partition-entry-array}
 */
const GPTPartitionEntry = struct("GPTPartitionEntry", {
  type: guid(),
  unique: guid(),
  startingLba: uint64(),
  endingLba: uint64(),
  /**
   * @see {@link https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html#defined-gpt-partition-entry-attributes}
   */
  attributes: uint64(),
  name: utf16cstring(36),
}, { littleEndian: true });


/**
 * @typedef {Object} Partition
 * @property {string} type
 * @property {string} uuid
 * @property {bigint} start
 * @property {bigint} end
 * @property {bigint} sectors
 * @property {string} attributes
 * @property {string} name
 */


export class GPT {
  /** @type {ReturnType<typeof GPTHeader.from>} */
  #header;
  /** @type {(ReturnType<typeof GPTPartitionEntry.from>)[]} */
  #partEntries = [];

  /** @param {number} sectorSize */
  constructor(sectorSize) {
    this.sectorSize = sectorSize;
  }

  get headerCrc32() {
    return this.#header.headerCrc32;
  }

  get partEntriesCrc32() {
    return this.#header.partEntriesCrc32;
  }

  get currentLba() {
    return this.#header.currentLba;
  }

  get alternateLba() {
    return this.#header.alternateLba;
  }

  get firstUsableLba() {
    return this.#header.firstUsableLba;
  }

  get lastUsableLba() {
    return this.#header.lastUsableLba;
  }

  get partEntriesStartLba() {
    return this.#header.partEntriesStartLba;
  }

  get numPartEntries() {
    return this.#header.numPartEntries;
  }

  get partEntrySize() {
    return this.#header.partEntrySize;
  }

  get partEntriesSectors() {
    return Math.ceil(Number(this.numPartEntries * this.partEntrySize / this.sectorSize));
  }

  /**
   * @param {ArrayBuffer} data
   * @param {bigint} actualLba
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
    if (this.#header.headerSize < 92 || this.#header.headerSize > this.sectorSize) {
      logger.error(`Invalid header size: ${this.#header.headerSize}`);
      return null;
    }
    if (this.#header.currentLba !== actualLba) {
      logger.warn(`currentLba (${this.#header.currentLba}) does not match actual value (${actualLba})`);
      return null;
    }

    const expectedHeaderCrc32 = this.#header.headerCrc32;
    this.#header.headerCrc32 = 0;
    const actualHeaderCrc32 = crc32(new Uint8Array(this.#header.$toBuffer()));
    this.#header.headerCrc32 = expectedHeaderCrc32;

    const mismatchCrc32 = this.#header.headerCrc32 !== actualHeaderCrc32;
    if (mismatchCrc32) {
      logger.warn(`Header CRC32 mismatch: expected ${this.#header.headerCrc32}, actual ${actualHeaderCrc32}`);
    }

    return {
      headerCrc32: this.#header.headerCrc32,
      mismatchCrc32,
    };
  }

  /**
   * @param {ArrayBuffer} data
   * @returns {{ mismatchCrc32: boolean }}
   */
  parsePartEntries(data) {
    const entrySize = this.#header.partEntrySize;
    for (let i = 0; i < this.#header.numPartEntries; i++) {
      const entryOffset = i * entrySize;
      const partEntry = GPTPartitionEntry.from(data.slice(entryOffset, entryOffset + entrySize));
      this.#partEntries.push(partEntry);
    }

    const actualPartEntriesCrc32 = crc32(this.buildPartEntries());
    const mismatchCrc32 = this.#header.partEntriesCrc32 !== actualPartEntriesCrc32;
    if (mismatchCrc32) {
      logger.warn(`Partition entries CRC32 mismatch: expected ${this.#header.partEntriesCrc32}, actual 0x${actualPartEntriesCrc32}`);
    }

    return { mismatchCrc32 };
  }

  /** @returns {GPT} */
  asAlternate() {
    const alternate = this.#header.$clone();
    alternate.currentLba = this.#header.alternateLba;
    alternate.alternateLba = this.#header.currentLba;
    alternate.partEntriesStartLba = this.#header.alternateLba - this.partEntriesSectors;

    const gpt = new GPT(this.sectorSize);
    gpt.#header = alternate;
    gpt.#partEntries = this.#partEntries.map((partEntry) => partEntry.$clone());
    return gpt;
  }

  /** @returns {Uint8Array} */
  buildPartEntries() {
    const array = new Uint8Array(this.numPartEntries * this.partEntrySize);
    for (let i = 0; i < this.numPartEntries; i++) {
      array.set(new Uint8Array(this.#partEntries[i].$toBuffer()), i * this.partEntrySize);
    }
    return array;
  }

  /**
   * @param {Uint8Array} [partEntries]
   * @returns {Uint8Array}
   */
  buildHeader(partEntries) {
    this.#header.partEntriesCrc32 = crc32(partEntries ?? this.buildPartEntries());

    this.#header.headerCrc32 = 0;
    let header = this.#header.$toBuffer();
    this.#header.headerCrc32 = crc32(header);
    header = this.#header.$toBuffer();

    return new Uint8Array(header);
  }

  /** @returns {IterableIterator<Partition>} */
  [Symbol.iterator]() {
    return this.#partEntries
      .filter((entry) => !entry.type.startsWith("00000000"))
      .map((entry) => ({
        type: entry.type,
        uuid: entry.unique,
        start: entry.startingLba,
        end: entry.endingLba,
        sectors: entry.endingLba - entry.startingLba + 1n,
        attributes: `0x${entry.attributes.toString(16).padStart(16, "0")}`,
        name: entry.name,
      }));
  }

  /**
   * @param {string} name
   * @returns {Partition|undefined}
   */
  locatePartition(name) {
    return Array.from(this).find((entry) => entry.name === name);
  }

  /** @returns {{ partitions: Set<string>, slots: Set<string> }} */
  getPartitionsInfo() {
    const partitions = new Set(), slots = new Set();
    for (const partEntry of this.#partEntries) {
      if (partEntry.type.startsWith("00000000")) continue;
      const { name } = partEntry;
      // FIXME: do other slot names exist?
      if (name.endsWith("_a")) slots.add("a");
      if (name.endsWith("_b")) slots.add("b");
      partitions.add(name);
    }
    return { partitions, slots };
  }

  /** @returns {"a"|"b"|null} */
  getActiveSlot() {
    for (const partEntry of this.#partEntries) {
      if (partEntry.type.startsWith("00000000")) continue;
      const slot = partEntry.name.slice(-2);
      const slotA = slot === "_a";
      if (!slotA && slot !== "_b") continue;
      const flags = parseABFlags(partEntry.attributes);
      logger.debug(`${partEntry.name} flags:`, flags);
      if (flags.active) return slotA ? "a" : "b";
    }
    return null;
  }

  /** @param {"a"|"b"} slot */
  setActiveSlot(slot) {
    if (slot !== "a" && slot !== "b") throw new Error("Invalid slot");
    for (const partEntry of this.#partEntries) {
      if (partEntry.type.startsWith("00000000")) continue;
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
