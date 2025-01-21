import { describe, expect, test } from "bun:test";
import { buf as crc32 } from "crc-32";
import { gpt, gptPartition, setPartitionFlags, ensureGptHdrConsistency } from "./gpt";
import { AB_FLAG_OFFSET, AB_PARTITION_ATTR_SLOT_ACTIVE, PART_ATT_PRIORITY_BIT, PART_ATT_ACTIVE_BIT } from "./gpt";

// Helper to create a valid GPT layout with specified partition entries
function createGptWithPartitions(partitions = []) {
  // Create basic GPT structure
  const data = createTypicalGptHeader();
  const partitionTableOffset = 1024;  // After MBR + GPT header

  // Add specified partition entries
  partitions.forEach((part, index) => {
    const entry = createPartitionEntry(part.name, part.start, part.size, part.flags);
    data.set(entry, partitionTableOffset + (index * 128));
  });

  // Fill remaining entries with zeroes
  const emptyEntry = new Uint8Array(128);
  for (let i = partitions.length; i < 128; i++) {
    data.set(emptyEntry, partitionTableOffset + (i * 128));
  }

  return computeAndSetCrcs(data);
}

// Helper to create GPT header
function createTypicalGptHeader() {
  // Create space for MBR + GPT header + partition entries (512 + 512 + 128*128)
  const header = new Uint8Array(17408);  // Always include MBR
  const view = new DataView(header.buffer);
  const offset = 512;  // Always start after MBR

  // "EFI PART" signature
  const signature = new TextEncoder().encode("EFI PART");
  header.set(signature, offset);

  view.setUint32(offset + 8, 0x00010000, true);  // Revision 1.0
  view.setUint32(offset + 12, 0x5C, true);       // Header size (92 bytes)
  view.setUint32(offset + 16, 0, true);          // CRC32 (initially 0)
  view.setUint32(offset + 20, 0, true);          // Reserved
  view.setBigUint64(offset + 24, 1n, true);      // Current LBA
  view.setBigUint64(offset + 32, 0xFFFFFFFFn, true); // Backup LBA
  view.setBigUint64(offset + 40, 34n, true);     // First usable LBA
  view.setBigUint64(offset + 48, 0xFFFFFFFFn, true); // Last usable LBA

  // Disk GUID (typical for Snapdragon devices)
  const guid = new Uint8Array([
    0x51, 0x73, 0x95, 0x17, 0x22, 0x34, 0x43, 0x56,
    0x89, 0xAB, 0xCD, 0xEF, 0x01, 0x23, 0x45, 0x67
  ]);
  header.set(guid, offset + 56);

  view.setBigUint64(offset + 72, 2n, true);      // Partition entry start LBA
  view.setUint32(offset + 80, 128, true);        // Number of partition entries
  view.setUint32(offset + 84, 128, true);        // Size of partition entry
  view.setUint32(offset + 88, 0, true);          // CRC32 of partition array

  return header;
}

function createPartitionEntry(name, startLba, sizeLba, flags = 0) {
  const entry = new Uint8Array(128);
  const view = new DataView(entry.buffer);

  // Type GUID (Basic data partition - EBD0A0A2-B9E5-4433-87C0-68B6B72699C7)
  entry.set([0xA2, 0xA0, 0xD0, 0xEB, 0xE5, 0xB9, 0x33, 0x44,
    0x87, 0xC0, 0x68, 0xB6, 0xB7, 0x26, 0x99, 0xC7], 0);

  // Unique GUID
  entry.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
    0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00], 16);

  view.setBigUint64(32, BigInt(startLba), true);
  view.setBigUint64(40, BigInt(startLba + sizeLba - 1), true);
  view.setBigUint64(48, BigInt(flags), true);

  // Convert name to UTF-16LE
  const utf16Name = new Uint8Array(72);  // 36 UTF-16LE characters max
  for (let i = 0; i < Math.min(name.length, 36); i++) {
    utf16Name[i * 2] = name.charCodeAt(i);
    utf16Name[i * 2 + 1] = 0;  // High byte for UTF-16LE
  }
  entry.set(utf16Name, 56);

  return entry;
}

function computeAndSetCrcs(data, offset = 512) {
  const view = new DataView(data.buffer);
  const headerSize = view.getUint32(offset + 12, true);
  const numEntries = view.getUint32(offset + 80, true);
  const entrySize = view.getUint32(offset + 84, true);

  // Compute partition array CRC
  const partitionTableOffset = 2 * 512;  // after MBR and GPT header
  const partitionTableSize = numEntries * entrySize;
  const partitionTableCrc = crc32(data.slice(partitionTableOffset, partitionTableOffset + partitionTableSize));
  view.setUint32(offset + 88, partitionTableCrc, true);

  // Compute header CRC
  view.setUint32(offset + 16, 0, true);  // Zero CRC field
  const headerCrc = crc32(data.slice(offset, offset + headerSize));
  view.setUint32(offset + 16, headerCrc, true);

  return data;
}

describe("gpt", () => {
  describe("parse", () => {
    test("should parse typical Snapdragon 845 GPT header", () => {
      const gptInstance = new gpt();
      const gptData = createGptWithPartitions();
      const success = gptInstance.parse(gptData, 512);

      expect(success).toBeTrue();
      expect(gptInstance.header.revision).toBe(0x10000);
      expect(gptInstance.header.headerSize).toBe(0x5C);
      expect(gptInstance.header.firstUsableLba).toBe(34);
      expect(gptInstance.header.numPartEntries).toBe(128);
      expect(gptInstance.header.partEntrySize).toBe(128);
    });

    test("should parse typical boot partition entry", () => {
      const gptInstance = new gpt();
      const bootPartition = { name: "boot_a", start: 2048, size: 32768, flags: 0x006f << 48 };
      const gptData = createGptWithPartitions([bootPartition]);
      const success = gptInstance.parse(gptData, 512);

      expect(success).toBeTrue();
      expect(gptInstance.partentries["boot_a"]).toBeDefined();
      expect(gptInstance.partentries["boot_a"].sector).toBe(2048);
      expect(gptInstance.partentries["boot_a"].sectors).toBe(32768);
    });

    test("should parse multiple A/B partitions", () => {
      const gptInstance = new gpt();
      const partitions = [
        { name: "boot_a", start: 2048, size: 32768, flags: 0x006f << 48 },
        { name: "boot_b", start: 34816, size: 32768, flags: 0x003a << 48 },
        { name: "system_a", start: 67584, size: 2097152, flags: 0 },
        { name: "system_b", start: 2164736, size: 2097152, flags: 0 }
      ];
      const gptData = createGptWithPartitions(partitions);
      const success = gptInstance.parse(gptData, 512);

      expect(success).toBeTrue();
      expect(gptInstance.partentries["boot_a"]).toBeDefined();
      expect(gptInstance.partentries["boot_b"]).toBeDefined();
      expect(gptInstance.partentries["system_a"]).toBeDefined();
      expect(gptInstance.partentries["system_b"]).toBeDefined();
    });
  });

  describe("ensureGptHdrConsistency", () => {
    test("should handle valid, matching GPTs without modification", () => {
      const partitions = [
        { name: "boot_a", start: 2048, size: 32768, flags: 0x006f << 16 }
      ];
      const primaryData = createGptWithPartitions(partitions);
      const backupData = createGptWithPartitions(partitions);
      const primaryGpt = new gpt();
      const backupGpt = new gpt();
      primaryGpt.parse(primaryData, 512);
      backupGpt.parse(backupData, 512);

      // Save original CRCs
      const originalHeaderCrc = new DataView(primaryData.buffer).getUint32(512 + 16, true);
      const originalPartTableCrc = new DataView(primaryData.buffer).getUint32(512 + 88, true);

      const result = ensureGptHdrConsistency(
        primaryData,
        backupData,
        primaryGpt,
        backupGpt
      );

      const resultView = new DataView(result.buffer);
      expect(resultView.getUint32(512 + 16, true)).toBe(originalHeaderCrc);
      expect(resultView.getUint32(512 + 88, true)).toBe(originalPartTableCrc);
    });

    // test("should restore corrupted primary header using backup", () => {
    //   const partitions = [
    //     { name: "boot_a", start: 2048, size: 32768, flags: 0x006f << 48 }
    //   ];
    //   const primaryData = createGptWithPartitions(partitions);
    //   const backupData = createGptWithPartitions(partitions);
    //   const primaryGpt = new gpt();
    //   const backupGpt = new gpt();
    //   primaryGpt.parse(primaryData, 512);
    //   backupGpt.parse(backupData, 512);
    //
    //   // Save original CRCs
    //   const originalHeaderCrc = new DataView(backupData.buffer).getUint32(512 + 16, true);
    //   const originalPartTableCrc = new DataView(backupData.buffer).getUint32(512 + 88, true);
    //
    //   // Corrupt primary GPT header
    //   const primaryView = new DataView(primaryData.buffer);
    //   primaryView.setUint32(512 + 16, 0xDEADBEEF, true);  // Bad CRC
    //   primaryView.setUint32(512 + 12, 0xFF, true);        // Bad header size
    //
    //   const result = ensureGptHdrConsistency(
    //     primaryData,
    //     backupData,
    //     primaryGpt,
    //     backupGpt
    //   );
    //
    //   // Verify restored header matches backup
    //   const resultView = new DataView(result.buffer);
    //   expect(resultView.getUint32(512 + 16, true)).toBe(originalHeaderCrc);
    //   expect(resultView.getUint32(512 + 88, true)).toBe(originalPartTableCrc);
    //   expect(resultView.getUint32(512 + 12, true)).toBe(0x5C);
    // });

    // test("should throw when both primary and backup are corrupted", () => {
    //   const partitions = [
    //     { name: "boot_a", start: 2048, size: 32768, flags: 0x006f << 48 }
    //   ];
    //   const primaryData = createGptWithPartitions(partitions);
    //   const backupData = createGptWithPartitions(partitions);
    //   const primaryGpt = new gpt();
    //   const backupGpt = new gpt();
    //   primaryGpt.parse(primaryData, 512);
    //   backupGpt.parse(backupData, 512);
    //
    //   // Corrupt both headers
    //   const primaryView = new DataView(primaryData.buffer);
    //   const backupView = new DataView(backupData.buffer);
    //   primaryView.setUint32(512 + 16, 0xDEADBEEF, true);
    //   backupView.setUint32(512 + 16, 0xDEADBEEF, true);
    //
    //   expect(() => ensureGptHdrConsistency(
    //     primaryData,
    //     backupData,
    //     primaryGpt,
    //     backupGpt
    //   )).toThrow("Both primary and backup gpt headers are corrupted, cannot recover");
    // });
  });
});
