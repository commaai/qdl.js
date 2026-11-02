import { GPT } from "./gpt.js";

const DDR_TYPE = "20a0c19c-286a-42fa-9ce7-f64c3226a794";

/** A malformed partition table is distinct from a failed device read. */
export class CalibrationLayoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "CalibrationLayoutError";
  }
}

/** Extract DDR only from a validated, nonoverlapping GPT layout. The caller validates GPT CRCs. */
export function ddrPartitionFromGpt(gpt, lun = 3) {
  if (gpt.sectorSize !== 4096 || gpt.firstUsableLba < 6n || gpt.lastUsableLba < gpt.firstUsableLba
    || gpt.numPartEntries < 1 || gpt.numPartEntries > 128 || gpt.partEntrySize !== 128
    || gpt.lastUsableLba >= (gpt.currentLba > gpt.alternateLba ? gpt.currentLba : gpt.alternateLba) - BigInt(gpt.partEntriesSectors)) {
    throw new CalibrationLayoutError("Invalid calibration GPT bounds");
  }
  const partitions = gpt.getPartitions().sort((a, b) => a.start < b.start ? -1 : 1);
  const names = new Set();
  let end = gpt.firstUsableLba;
  for (const partition of partitions) {
    if (partition.start < end || partition.sectors <= 0n || partition.end > gpt.lastUsableLba || names.has(partition.name)) {
      throw new CalibrationLayoutError("Invalid or overlapping calibration partition layout");
    }
    names.add(partition.name);
    end = partition.end + 1n;
  }
  const partition = partitions.find(partition => partition.name === "ddr");
  return partition ? { ...partition, lun, sectorSize: gpt.sectorSize, firstUsableLba: gpt.firstUsableLba, lastUsableLba: gpt.lastUsableLba } : null;
}

/** Parse a canonical six-sector GPT image before any destructive operation. */
export function readDdrPartition(gptBytes, lun = 3) {
  if (!(gptBytes instanceof Uint8Array) || gptBytes.byteLength !== 6 * 4096) {
    throw new CalibrationLayoutError("Expected a six-sector calibration GPT image");
  }
  const bytes = new Uint8Array(gptBytes);
  const gpt = new GPT(4096);
  const header = gpt.parseHeader(bytes.subarray(4096, 8192), 1n);
  if (!header || header.mismatchCrc32 || gpt.currentLba !== 1n || gpt.partEntriesStartLba !== 2n
    || gpt.numPartEntries < 1 || gpt.numPartEntries > 128 || gpt.partEntrySize !== 128) {
    throw new CalibrationLayoutError("Invalid calibration GPT header");
  }
  if (gpt.parsePartEntries(bytes.subarray(8192)).mismatchCrc32) throw new CalibrationLayoutError("Invalid calibration GPT entries");
  return ddrPartitionFromGpt(gpt, lun);
}

/** The device may have expanded the last partition; its known first MiB must remain identical. */
export function canPreserveDdr(existing, desired) {
  const valid = partition => partition?.name === "ddr" && partition.lun === 3 && partition.sectorSize === 4096
    && partition.type === DDR_TYPE && partition.start === 64n && partition.sectors >= 256n
    && partition.end === partition.start + partition.sectors - 1n
    && partition.firstUsableLba <= partition.start && partition.lastUsableLba >= partition.end;
  return Boolean(valid(existing) && valid(desired) && desired.sectors === 256n);
}
