#!/usr/bin/env bun
import { createQdl } from "../cli";

/**
 * @typedef {Object} Partition
 * @property {number} lun
 * @property {number} start_sector
 * @property {number} num_sectors
 */

/**
 * @typedef {Object} ManifestImage
 * @property {string} name
 * @property {string} url
 * @property {string} hash
 * @property {string} hash_raw
 * @property {number} size
 * @property {boolean} full_check
 * @property {boolean} has_ab
 * @property {string} ondevice_hash
 * @property {(Partition|undefined)} gpt
 */

const qdl = await createQdl();
const storageInfo = await qdl.getStorageInfo();

console.debug("UFS Serial:", storageInfo.serial_num.toString(16).padStart(8, "0"))

const manifestUrl = "https://raw.githubusercontent.com/commaai/openpilot/release3-staging/system/hardware/tici/all-partitions.json";
/** @type {ManifestImage[]} */
const manifest = await fetch(manifestUrl).then((res) => res.json());
console.debug("Loaded manifest:");
console.debug(manifest);


// Erase device
for (const lun of qdl.firehose.luns) {
  console.debug(`Erasing lun ${lun}`);
  await qdl.eraseLun(lun);
}


// Flash partitions
// TODO

process.exit(0);
