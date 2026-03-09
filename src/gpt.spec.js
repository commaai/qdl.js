import { readableStreamToArrayBuffer } from "bun";
import { beforeAll, describe, expect, test } from "bun:test";
import { buf as crc32 } from "crc-32";
import { XzReadableStream } from "xz-decompress";

import { GPT } from "./gpt";


const SECTOR_SIZE = 4096;


/**
 * Write a GUID string to a DataView at the given offset (mixed-endian format).
 * @param {DataView} view
 * @param {number} offset
 * @param {string} guid
 */
function writeGuid(view, offset, guid) {
  const parts = guid.split("-");
  view.setUint32(offset, Number.parseInt(parts[0], 16), true);
  view.setUint16(offset + 4, Number.parseInt(parts[1], 16), true);
  view.setUint16(offset + 6, Number.parseInt(parts[2], 16), true);
  const clockSeq = Number.parseInt(parts[3], 16);
  view.setUint8(offset + 8, (clockSeq >> 8) & 0xFF);
  view.setUint8(offset + 9, clockSeq & 0xFF);
  const nodeHex = parts[4];
  for (let i = 0; i < 6; i++) {
    view.setUint8(offset + 10 + i, Number.parseInt(nodeHex.substring(i * 2, i * 2 + 2), 16));
  }
}


/**
 * Build minimal GPT binary data with specified partitions.
 * @param {{ name: string, type?: string, attributes?: bigint }[]} partitions
 * @returns {{ header: Uint8Array, entries: Uint8Array }}
 */
function buildGPTData(partitions) {
  const entrySize = 128;
  const numEntries = partitions.length;

  // Build partition entries
  const entries = new Uint8Array(numEntries * entrySize);
  const entriesView = new DataView(entries.buffer);

  for (let i = 0; i < numEntries; i++) {
    const off = i * entrySize;
    const p = partitions[i];

    // Type GUID: full string or default non-zero marker
    if (p.type) {
      writeGuid(entriesView, off, p.type);
    } else {
      entriesView.setUint32(off, 0xDEADBEEF, true);
    }

    // Unique GUID
    entriesView.setUint32(off + 16, i + 1, true);

    // startingLba / endingLba
    entriesView.setBigUint64(off + 32, BigInt(100 + i * 100), true);
    entriesView.setBigUint64(off + 40, BigInt(199 + i * 100), true);

    // attributes
    entriesView.setBigUint64(off + 48, p.attributes ?? 0n, true);

    // name (UTF-16LE at offset 56)
    for (let j = 0; j < p.name.length; j++) {
      entriesView.setUint16(off + 56 + j * 2, p.name.charCodeAt(j), true);
    }
  }

  // Build GPT header (92 bytes)
  const header = new Uint8Array(SECTOR_SIZE);
  const hv = new DataView(header.buffer);

  new TextEncoder().encodeInto("EFI PART", header);   // signature
  hv.setUint32(8, 0x00010000, true);                   // revision 1.0
  hv.setUint32(12, 92, true);                           // headerSize
  hv.setUint32(20, 0, true);                            // reserved
  hv.setBigUint64(24, 1n, true);                        // currentLba
  hv.setBigUint64(32, 0xFFFFn, true);                   // alternateLba
  hv.setBigUint64(40, 6n, true);                        // firstUsableLba
  hv.setBigUint64(48, 0xFFFEn, true);                   // lastUsableLba
  // diskGuid: 16 zero bytes at offset 56
  hv.setBigUint64(72, 2n, true);                        // partEntriesStartLba
  hv.setUint32(80, numEntries, true);                    // numPartEntries
  hv.setUint32(84, entrySize, true);                     // partEntrySize
  hv.setInt32(88, crc32(entries), true);                 // partEntriesCrc32

  // headerCrc32: compute with field zeroed, then fill in
  hv.setInt32(16, 0, true);
  hv.setInt32(16, crc32(header.subarray(0, 92)), true);

  return { header, entries };
}


/**
 * Create a GPT instance from a partition list.
 * @param {{ name: string, attributes?: bigint }[]} partitions
 */
function createTestGPT(partitions) {
  const { header, entries } = buildGPTData(partitions);
  const gpt = new GPT(SECTOR_SIZE);
  gpt.parseHeader(header, 1n);
  gpt.parsePartEntries(entries);
  return gpt;
}


/**
 * Get the attributes hex string for a partition by name.
 * @param {GPT} gpt
 * @param {string} name
 */
function attrOf(gpt, name) {
  return gpt.getPartitions().find((p) => p.name === name)?.attributes;
}

/**
 * Get the type GUID for a partition by name.
 * @param {GPT} gpt
 * @param {string} name
 */
function typeOf(gpt, name) {
  return gpt.getPartitions().find((p) => p.name === name)?.type;
}


// Typical comma device LUN 4 partitions (all starting at zero attributes)
const LUN4_PARTITIONS = [
  { name: "boot_a" },
  { name: "boot_b" },
  { name: "aop_a" },
  { name: "aop_b" },
  { name: "tz_a" },
  { name: "tz_b" },
];


describe("GPT", () => {
  describe.each([0, 1, 2, 3, 4, 5])("LUN %d", async (lun) => {
    /** @type {GPT} */
    let gpt;
    /** @type {ArrayBuffer} */
    let gptBuffer;

    beforeAll(async () => {
      gpt = new GPT(SECTOR_SIZE);

      const manifest = await fetch("https://raw.githubusercontent.com/commaai/openpilot/master/system/hardware/tici/all-partitions.json").then((res) => res.json());
      const gptImage= manifest.find((image) => image.name === `gpt_main_${lun}`);
      const compressedResponse = await fetch(gptImage.url);
      gptBuffer = await readableStreamToArrayBuffer(new XzReadableStream(compressedResponse.body));
    });

    test("parseHeader", () => {
      const headerData = new Uint8Array(gptBuffer, SECTOR_SIZE, SECTOR_SIZE);
      const result = gpt.parseHeader(headerData, 1n);
      expect(gpt.currentLba).toBe(1n);
      expect(gpt.partEntriesStartLba).toBe(2n);
      expect(gpt.firstUsableLba).toBe(6n);
      expect(result).toMatchObject({
        mismatchCrc32: false,
      });
    });

    test("parsePartEntries", () => {
      const partEntriesData = new Uint8Array(gptBuffer, Number(gpt.partEntriesStartLba) * SECTOR_SIZE, gpt.partEntriesSectors * SECTOR_SIZE);
      const result = gpt.parsePartEntries(partEntriesData);
      expect(result).toMatchObject({
        mismatchCrc32: false,
      });
    });

    if (lun === 4) {
      test("setActiveSlot", () => {
        expect(gpt.getActiveSlot()).toBe("a");
        gpt.setActiveSlot("a");
        expect(gpt.getActiveSlot()).toBe("a");
        gpt.setActiveSlot("b");
        expect(gpt.getActiveSlot()).toBe("b");
      });
    }
  });
});


describe("A/B partition flags", () => {
  describe("setActiveSlot", () => {
    test("active boot: priority=3, active=1, retry=7, successful=0, unbootable=0", () => {
      const gpt = createTestGPT(LUN4_PARTITIONS);
      gpt.setActiveSlot("a");
      // 0x3F = 0b00111111 = pri(3) active(1) retry(7) succ(0) unboot(0)
      expect(attrOf(gpt, "boot_a")).toBe("0x003f000000000000");
    });

    test("inactive boot: priority=2, active=0", () => {
      const gpt = createTestGPT(LUN4_PARTITIONS);
      gpt.setActiveSlot("a");
      // 0x02 = 0b00000010 = pri(2) active(0) retry(0) succ(0) unboot(0)
      expect(attrOf(gpt, "boot_b")).toBe("0x0002000000000000");
    });

    test("active non-boot: only ACTIVE bit set", () => {
      const gpt = createTestGPT(LUN4_PARTITIONS);
      gpt.setActiveSlot("a");
      // 0x04 = bit 50 only
      expect(attrOf(gpt, "aop_a")).toBe("0x0004000000000000");
      expect(attrOf(gpt, "tz_a")).toBe("0x0004000000000000");
    });

    test("inactive non-boot: ACTIVE bit cleared", () => {
      const gpt = createTestGPT(LUN4_PARTITIONS);
      gpt.setActiveSlot("a");
      expect(attrOf(gpt, "aop_b")).toBe("0x0000000000000000");
      expect(attrOf(gpt, "tz_b")).toBe("0x0000000000000000");
    });

    test("slot B mirrors slot A behavior", () => {
      const gpt = createTestGPT(LUN4_PARTITIONS);
      gpt.setActiveSlot("b");
      expect(attrOf(gpt, "boot_b")).toBe("0x003f000000000000");
      expect(attrOf(gpt, "boot_a")).toBe("0x0002000000000000");
      expect(attrOf(gpt, "aop_b")).toBe("0x0004000000000000");
      expect(attrOf(gpt, "aop_a")).toBe("0x0000000000000000");
    });

    test("inactive boot preserves retry, successful, unbootable", () => {
      // boot_b starts with retry=3, successful=1
      const gpt = createTestGPT([
        { name: "boot_a" },
        { name: "boot_b", attributes: (3n << 51n) | (1n << 54n) },
        { name: "aop_a" },
        { name: "aop_b" },
      ]);
      gpt.setActiveSlot("a");
      // boot_b: priority=2, active=0, retry=3 (preserved), successful=1 (preserved)
      // 0x5A = 0b01011010 = pri(2) active(0) retry(3) succ(1) unboot(0)
      expect(attrOf(gpt, "boot_b")).toBe("0x005a000000000000");
    });

    test("non-boot preserves all flags except ACTIVE", () => {
      // aop_a starts with priority=1, retry=5, successful=1, unbootable=1
      const gpt = createTestGPT([
        { name: "boot_a" },
        { name: "boot_b" },
        { name: "aop_a", attributes: (1n << 48n) | (5n << 51n) | (1n << 54n) | (1n << 55n) },
        { name: "aop_b" },
      ]);

      // Activate slot A: aop_a gets ACTIVE set, everything else preserved
      gpt.setActiveSlot("a");
      expect(attrOf(gpt, "aop_a")).toBe("0x00ed000000000000");

      // Activate slot B: aop_a gets ACTIVE cleared, everything else preserved
      gpt.setActiveSlot("b");
      expect(attrOf(gpt, "aop_a")).toBe("0x00e9000000000000");
    });

    test("preserves bits outside 48-55 on boot partitions", () => {
      // boot_a has low bits set (platform-defined GPT attributes)
      const gpt = createTestGPT([
        { name: "boot_a", attributes: 0x0000000000000007n },
        { name: "boot_b" },
        { name: "aop_a" },
        { name: "aop_b" },
      ]);
      gpt.setActiveSlot("a");
      // Flags in byte 6 = 0x3F, low bits preserved
      expect(attrOf(gpt, "boot_a")).toBe("0x003f000000000007");
    });

    test("preserves bits above 55 (garbage bits from old tools)", () => {
      // boot_a has garbage in byte 7 (bits 56-63) from old buggy tools
      const gpt = createTestGPT([
        { name: "boot_a", attributes: 0x1100000000000000n },
        { name: "boot_b", attributes: 0x1000000000000000n },
        { name: "aop_a" },
        { name: "aop_b" },
      ]);
      gpt.setActiveSlot("a");
      // Garbage byte 7 preserved on both
      expect(attrOf(gpt, "boot_a")).toBe("0x113f000000000000");
      expect(attrOf(gpt, "boot_b")).toBe("0x1002000000000000");
    });

    test("rejects invalid slot", () => {
      const gpt = createTestGPT(LUN4_PARTITIONS);
      expect(() => gpt.setActiveSlot("c")).toThrow("Invalid slot");
    });

    test("skips non-slotted partitions", () => {
      const gpt = createTestGPT([
        { name: "boot_a" },
        { name: "boot_b" },
        { name: "misc", attributes: 0x1234n },
      ]);
      gpt.setActiveSlot("a");
      expect(attrOf(gpt, "misc")).toBe("0x0000000000001234");
    });
  });


  describe("getActiveSlot", () => {
    test("returns slot with highest priority among active boots", () => {
      const gpt = createTestGPT([
        { name: "boot_a", attributes: (3n << 48n) | (1n << 50n) },
        { name: "boot_b", attributes: (2n << 48n) | (1n << 50n) },
        { name: "aop_a" },
        { name: "aop_b" },
      ]);
      expect(gpt.getActiveSlot()).toBe("a");
    });

    test("returns B when B has higher priority", () => {
      const gpt = createTestGPT([
        { name: "boot_a", attributes: (2n << 48n) | (1n << 50n) },
        { name: "boot_b", attributes: (3n << 48n) | (1n << 50n) },
        { name: "aop_a" },
        { name: "aop_b" },
      ]);
      expect(gpt.getActiveSlot()).toBe("b");
    });

    test("returns null when no boot partition is active", () => {
      const gpt = createTestGPT([
        { name: "boot_a", attributes: 3n << 48n },
        { name: "boot_b", attributes: 2n << 48n },
        { name: "aop_a", attributes: 1n << 50n },
      ]);
      expect(gpt.getActiveSlot()).toBeNull();
    });

    test("ignores non-boot partitions", () => {
      const gpt = createTestGPT([
        { name: "boot_a" },
        { name: "boot_b" },
        { name: "aop_a", attributes: (3n << 48n) | (1n << 50n) },
      ]);
      expect(gpt.getActiveSlot()).toBeNull();
    });

    test("round-trips with setActiveSlot", () => {
      const gpt = createTestGPT(LUN4_PARTITIONS);
      gpt.setActiveSlot("a");
      expect(gpt.getActiveSlot()).toBe("a");
      gpt.setActiveSlot("b");
      expect(gpt.getActiveSlot()).toBe("b");
      gpt.setActiveSlot("a");
      expect(gpt.getActiveSlot()).toBe("a");
    });
  });


  describe("swapSlotGuids", () => {
    // Real partition type GUIDs from comma device firmware (gpt_main_*.img)
    const GUID_INACTIVE = "77036cd4-03d5-42bb-8ed1-37e5a88baa34";
    const GUID_BOOT     = "20117f86-e985-4357-b9ee-374bc1d8487d";
    const GUID_AOP      = "d69e90a5-4cab-0071-f6df-ab977f141a7f";
    const GUID_TZ       = "a053aa7f-40b8-4b1c-ba08-2f68ac71a4f4";
    const GUID_ABL      = "bd6928a1-4ce0-a038-4f3a-1495e3eddffb";
    const GUID_SYSTEM   = "97d7b011-54da-4835-b3c4-917ad6e73d74";
    const GUID_MISC     = "82acc91f-357c-4a68-9c8f-689e1b1a23a1";

    test("swaps type GUIDs between _a and _b counterparts", () => {
      const gpt = createTestGPT([
        { name: "boot_a", type: GUID_BOOT },
        { name: "boot_b", type: GUID_INACTIVE },
        { name: "aop_a", type: GUID_AOP },
        { name: "aop_b", type: GUID_INACTIVE },
        { name: "tz_a", type: GUID_TZ },
        { name: "tz_b", type: GUID_INACTIVE },
      ]);

      gpt.swapSlotGuids();

      expect(typeOf(gpt, "boot_a")).toBe(GUID_INACTIVE);
      expect(typeOf(gpt, "boot_b")).toBe(GUID_BOOT);
      expect(typeOf(gpt, "aop_a")).toBe(GUID_INACTIVE);
      expect(typeOf(gpt, "aop_b")).toBe(GUID_AOP);
      expect(typeOf(gpt, "tz_a")).toBe(GUID_INACTIVE);
      expect(typeOf(gpt, "tz_b")).toBe(GUID_TZ);
    });

    test("double swap restores original GUIDs", () => {
      const gpt = createTestGPT([
        { name: "boot_a", type: GUID_BOOT },
        { name: "boot_b", type: GUID_INACTIVE },
        { name: "abl_a", type: GUID_ABL },
        { name: "abl_b", type: GUID_INACTIVE },
      ]);
      gpt.swapSlotGuids();
      gpt.swapSlotGuids();
      expect(typeOf(gpt, "boot_a")).toBe(GUID_BOOT);
      expect(typeOf(gpt, "boot_b")).toBe(GUID_INACTIVE);
      expect(typeOf(gpt, "abl_a")).toBe(GUID_ABL);
      expect(typeOf(gpt, "abl_b")).toBe(GUID_INACTIVE);
    });

    test("skips non-slotted partitions", () => {
      const gpt = createTestGPT([
        { name: "boot_a", type: GUID_BOOT },
        { name: "boot_b", type: GUID_INACTIVE },
        { name: "misc", type: GUID_MISC },
      ]);
      gpt.swapSlotGuids();
      expect(typeOf(gpt, "misc")).toBe(GUID_MISC);
    });

    test("skips unmatched partitions (only _a, no _b on this LUN)", () => {
      // e.g. LUN 0 has system_a/system_b but boot_a is on LUN 4
      const gpt = createTestGPT([
        { name: "system_a", type: GUID_SYSTEM },
        { name: "system_b", type: GUID_INACTIVE },
        { name: "boot_a", type: GUID_BOOT },
      ]);
      gpt.swapSlotGuids();
      // system swapped, boot_a unchanged (no boot_b on this LUN)
      expect(typeOf(gpt, "system_a")).toBe(GUID_INACTIVE);
      expect(typeOf(gpt, "system_b")).toBe(GUID_SYSTEM);
      expect(typeOf(gpt, "boot_a")).toBe(GUID_BOOT);
    });

    test("does not affect partition attributes", () => {
      const gpt = createTestGPT([
        { name: "boot_a", type: GUID_BOOT, attributes: 0x003f000000000000n },
        { name: "boot_b", type: GUID_INACTIVE, attributes: 0x0002000000000000n },
        { name: "aop_a", type: GUID_AOP, attributes: 0x1004000000000000n },
        { name: "aop_b", type: GUID_INACTIVE, attributes: 0x1000000000000000n },
      ]);
      gpt.swapSlotGuids();
      expect(attrOf(gpt, "boot_a")).toBe("0x003f000000000000");
      expect(attrOf(gpt, "boot_b")).toBe("0x0002000000000000");
      expect(attrOf(gpt, "aop_a")).toBe("0x1004000000000000");
      expect(attrOf(gpt, "aop_b")).toBe("0x1000000000000000");
    });

    test("factory LUN 4: swap activates slot B GUIDs", () => {
      // Factory state: slot A has real GUIDs, slot B has inactive placeholder
      const gpt = createTestGPT([
        { name: "boot_a", type: GUID_BOOT, attributes: 0x003f000000000000n },
        { name: "boot_b", type: GUID_INACTIVE, attributes: 0x0002000000000000n },
        { name: "aop_a", type: GUID_AOP, attributes: 0x1004000000000000n },
        { name: "aop_b", type: GUID_INACTIVE, attributes: 0x0000000000000000n },
        { name: "abl_a", type: GUID_ABL, attributes: 0x1004000000000000n },
        { name: "abl_b", type: GUID_INACTIVE, attributes: 0x1000000000000000n },
      ]);

      gpt.swapSlotGuids();

      // Slot B now has real GUIDs, slot A has placeholder
      expect(typeOf(gpt, "boot_a")).toBe(GUID_INACTIVE);
      expect(typeOf(gpt, "boot_b")).toBe(GUID_BOOT);
      expect(typeOf(gpt, "aop_a")).toBe(GUID_INACTIVE);
      expect(typeOf(gpt, "aop_b")).toBe(GUID_AOP);
      expect(typeOf(gpt, "abl_a")).toBe(GUID_INACTIVE);
      expect(typeOf(gpt, "abl_b")).toBe(GUID_ABL);
    });

    test("factory LUN 0: swap activates system_b GUID", () => {
      const gpt = createTestGPT([
        { name: "system_a", type: GUID_SYSTEM, attributes: 0x0004000000000000n },
        { name: "system_b", type: GUID_INACTIVE, attributes: 0x0000000000000000n },
      ]);

      gpt.swapSlotGuids();

      expect(typeOf(gpt, "system_a")).toBe(GUID_INACTIVE);
      expect(typeOf(gpt, "system_b")).toBe(GUID_SYSTEM);
    });
  });


  describe("real device attribute values", () => {
    // Golden test vectors from live device readings captured during bug investigation.
    // Bytes 56-63 contain garbage from old buggy tools (0x11, 0x10, 0x21, 0x20).

    test("bricked state: getActiveSlot returns A (active+highest priority, even though unbootable)", () => {
      const gpt = createTestGPT([
        { name: "boot_a", attributes: 0x1187000000000000n },
        { name: "boot_b", attributes: 0x103a000000000000n },
        { name: "aop_a", attributes: 0x213f000000000000n },
        { name: "aop_b", attributes: 0x2039000000000000n },
      ]);
      // getActiveSlot matches ABL's GetActiveSlot — checks ACTIVE + PRIORITY, not unbootable
      expect(gpt.getActiveSlot()).toBe("a");
    });

    test("after fastboot --set-active=a: getActiveSlot returns A", () => {
      const gpt = createTestGPT([
        { name: "boot_a", attributes: 0x113f000000000000n },
        { name: "boot_b", attributes: 0x103a000000000000n },
        { name: "aop_a", attributes: 0x213f000000000000n },
        { name: "aop_b", attributes: 0x2039000000000000n },
      ]);
      expect(gpt.getActiveSlot()).toBe("a");
    });

    test("after fixed abctl: getActiveSlot returns A", () => {
      const gpt = createTestGPT([
        { name: "boot_a", attributes: 0x1177000000000000n },
        { name: "boot_b", attributes: 0x103a000000000000n },
        { name: "aop_a", attributes: 0x217f000000000000n },
        { name: "aop_b", attributes: 0x2039000000000000n },
      ]);
      expect(gpt.getActiveSlot()).toBe("a");
    });

    test("re-activating same slot is idempotent on real device state", () => {
      const gpt = createTestGPT([
        { name: "boot_a", attributes: 0x113f000000000000n },
        { name: "boot_b", attributes: 0x103a000000000000n },
        { name: "aop_a", attributes: 0x213f000000000000n },
        { name: "aop_b", attributes: 0x2039000000000000n },
      ]);

      gpt.setActiveSlot("a");

      // Already active — all attributes unchanged, including garbage bytes 56-63
      expect(attrOf(gpt, "boot_a")).toBe("0x113f000000000000");
      expect(attrOf(gpt, "boot_b")).toBe("0x103a000000000000");
      expect(attrOf(gpt, "aop_a")).toBe("0x213f000000000000");
      expect(attrOf(gpt, "aop_b")).toBe("0x2039000000000000");
    });

    test("switching to slot B on real device state", () => {
      const gpt = createTestGPT([
        { name: "boot_a", attributes: 0x113f000000000000n },
        { name: "boot_b", attributes: 0x103a000000000000n },
        { name: "aop_a", attributes: 0x213f000000000000n },
        { name: "aop_b", attributes: 0x2039000000000000n },
      ]);

      gpt.setActiveSlot("b");

      // boot_b active: pri=3, active=1, retry=7, garbage 0x10 preserved
      expect(attrOf(gpt, "boot_b")).toBe("0x103f000000000000");
      // boot_a inactive: pri=2, active=0, retry/succ/unboot preserved (were 7/0/0), garbage 0x11 preserved
      expect(attrOf(gpt, "boot_a")).toBe("0x113a000000000000");
      // aop_a: ACTIVE cleared (bit 50), everything else preserved
      expect(attrOf(gpt, "aop_a")).toBe("0x213b000000000000");
      // aop_b: ACTIVE set (bit 50), everything else preserved
      expect(attrOf(gpt, "aop_b")).toBe("0x203d000000000000");

      expect(gpt.getActiveSlot()).toBe("b");
    });
  });
});
