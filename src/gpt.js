import { buf as crc32 } from "crc-32"
import { bytes, int32, string, struct, uint32, uint64 } from "@incognitojam/tiny-struct";

import { createLogger } from "./logger";
import { guid, utf16cstring } from "./gpt-structs";

const SIGNATURE = "EFI PART";
const TYPE_EFI_UNUSED = "00000000-0000-0000-0000-000000000000";

// Qualcomm ABL A/B partition attribute bits 48-55
// https://git.codelinaro.org/clo/qcomlt/abl/-/blob/LE.UM.2.3.7/QcomModulePkg/Include/Library/PartitionTableUpdate.h#L89-102
const PART_ATT_PRIORITY_BIT = 48n;
const PART_ATT_ACTIVE_BIT = 50n;
const PART_ATT_RETRY_CNT_BIT = 51n;
const PART_ATT_SUCCESS_BIT = 54n;
const PART_ATT_UNBOOTABLE_BIT = 55n;

const PART_ATT_PRIORITY_MASK = 0x3n << PART_ATT_PRIORITY_BIT;
const PART_ATT_ACTIVE_VAL = 1n << PART_ATT_ACTIVE_BIT;
const PART_ATT_RETRY_MASK = 0x7n << PART_ATT_RETRY_CNT_BIT;
const PART_ATT_SUCCESS_VAL = 1n << PART_ATT_SUCCESS_BIT;
const PART_ATT_UNBOOTABLE_VAL = 1n << PART_ATT_UNBOOTABLE_BIT;

const MAX_PRIORITY = 3n;
const MAX_RETRY_COUNT = 7n;

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
   * @param {Uint8Array} data
   * @param {bigint} actualLba
   * @returns {{ headerCrc32: number; mismatchCrc32: boolean } | null}
   */
  parseHeader(data, actualLba) {
    this.#header = GPTHeader.from(data.slice());
    if (this.#header.signature !== SIGNATURE) {
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
    }

    const expectedHeaderCrc32 = this.#header.headerCrc32;
    this.#header.headerCrc32 = 0;
    const actualHeaderCrc32 = crc32(new Uint8Array(this.#header.$toBuffer()));
    this.#header.headerCrc32 = expectedHeaderCrc32;

    const mismatchCrc32 = this.#header.headerCrc32 !== actualHeaderCrc32;
    if (mismatchCrc32) {
      logger.warn(`Header CRC32 mismatch: expected ${this.#header.headerCrc32}, actual ${actualHeaderCrc32}`);
    }
    return { headerCrc32: this.#header.headerCrc32, mismatchCrc32};
  }

  /**
   * @param {Uint8Array} data
   * @returns {{ partEntriesCrc32: number; mismatchCrc32: boolean }}
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
      logger.warn(`Partition entries CRC32 mismatch: expected ${this.#header.partEntriesCrc32}, actual ${actualPartEntriesCrc32}`);
    }
    return { partEntriesCrc32: this.#header.partEntriesCrc32, mismatchCrc32 };
  }

  /** @returns {GPT} */
  asAlternate() {
    const alternate = this.#header.$clone();
    alternate.currentLba = this.#header.alternateLba;
    alternate.alternateLba = this.#header.currentLba;
    alternate.partEntriesStartLba = this.#header.alternateLba - BigInt(this.partEntriesSectors);

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
    if (this.#header.partEntriesCrc32 === 0) {
      throw new Error("Failed to build GPT header: partEntriesCrc32 is zero");
    }
    logger.debug(`partEntriesCrc32: ${this.#header.partEntriesCrc32}`);

    this.#header.headerCrc32 = 0;
    this.#header.headerCrc32 = crc32(new Uint8Array(this.#header.$toBuffer()));
    logger.debug(`headerCrc32: ${this.#header.headerCrc32}`);
    if (this.#header.headerCrc32 === 0) {
      throw new Error("Failed to build GPT header: headerCrc32 is zero");
    }

    return new Uint8Array(this.#header.$toBuffer());
  }

  /** @returns {Partition[]} */
  getPartitions() {
    return this.#partEntries
      .filter((entry) => entry.type !== TYPE_EFI_UNUSED)
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
    return this.getPartitions().find((entry) => entry.name === name);
  }

  /** @returns {{ partitions: Set<string>, slots: Set<string> }} */
  getPartitionsInfo() {
    const partitions = new Set(), slots = new Set();
    for (const partEntry of this.#partEntries) {
      if (partEntry.type === TYPE_EFI_UNUSED) continue;
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
    let bestSlot = null;
    let bestPriority = -1;
    for (const partEntry of this.#partEntries) {
      if (partEntry.type === TYPE_EFI_UNUSED) continue;
      if (!partEntry.name.startsWith("boot_")) continue;
      const slot = partEntry.name.slice(-2);
      if (slot !== "_a" && slot !== "_b") continue;
      const flags = parseABFlags(partEntry.attributes);
      if (flags.active && flags.priority > bestPriority) {
        bestPriority = flags.priority;
        bestSlot = slot === "_a" ? "a" : "b";
      }
    }
    return bestSlot;
  }

  /**
   * Matches ABL SetActiveSlot() + MarkPtnActive() behavior.
   * https://git.codelinaro.org/clo/qcomlt/abl/-/blob/LE.UM.2.3.7/QcomModulePkg/Library/BootLib/PartitionTableUpdate.c#L1233-1320
   * @param {"a"|"b"} slot
   */
  setActiveSlot(slot) {
    if (slot !== "a" && slot !== "b") throw new Error("Invalid slot");
    for (const partEntry of this.#partEntries) {
      if (partEntry.type === TYPE_EFI_UNUSED) continue;
      const partSlot = partEntry.name.slice(-2);
      if (partSlot !== "_a" && partSlot !== "_b") continue;
      const isActive = partSlot === `_${slot}`;
      const isBoot = partEntry.name.startsWith("boot");

      if (isBoot) {
        if (isActive) {
          // priority=3, active=1, retry=7, successful=0, unbootable=0
          partEntry.attributes = (partEntry.attributes
            & ~(PART_ATT_PRIORITY_MASK | PART_ATT_ACTIVE_VAL | PART_ATT_RETRY_MASK | PART_ATT_SUCCESS_VAL | PART_ATT_UNBOOTABLE_VAL))
            | (MAX_PRIORITY << PART_ATT_PRIORITY_BIT) | PART_ATT_ACTIVE_VAL | (MAX_RETRY_COUNT << PART_ATT_RETRY_CNT_BIT);
        } else {
          // priority=2, active=0 (other flags unchanged)
          partEntry.attributes = (partEntry.attributes
            & ~(PART_ATT_PRIORITY_MASK | PART_ATT_ACTIVE_VAL))
            | ((MAX_PRIORITY - 1n) << PART_ATT_PRIORITY_BIT);
        }
      } else {
        // Non-boot: only set/clear ACTIVE bit (MarkPtnActive behavior)
        if (isActive) {
          partEntry.attributes |= PART_ATT_ACTIVE_VAL;
        } else {
          partEntry.attributes &= ~PART_ATT_ACTIVE_VAL;
        }
      }
    }
  }
}


/**
 * @param {bigint} attributes
 * @returns {{ priority: number, active: boolean, triesRemaining: number, successful: boolean, unbootable: boolean }}
 */
function parseABFlags(attributes) {
  return {
    priority: Number((attributes & PART_ATT_PRIORITY_MASK) >> PART_ATT_PRIORITY_BIT),
    active: (attributes & PART_ATT_ACTIVE_VAL) !== 0n,
    triesRemaining: Number((attributes & PART_ATT_RETRY_MASK) >> PART_ATT_RETRY_CNT_BIT),
    successful: (attributes & PART_ATT_SUCCESS_VAL) !== 0n,
    unbootable: (attributes & PART_ATT_UNBOOTABLE_VAL) !== 0n,
  };
}
