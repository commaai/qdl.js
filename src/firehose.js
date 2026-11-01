import { concatUint8Array, containsBytes, compareStringToBytes, runWithTimeout } from "./utils"
import { createLogger } from "./logger"
import { toXml, xmlParser } from "./xml"
import { validateSparseProgram } from "./sparse-program"

const logger = createLogger("firehose")


/**
 * Progress callback
 *
 * @callback progressCallback
 * @param {number} progress
 * @returns {void}
 */


class response {
  /**
   * @param {boolean} resp
   * @param {Uint8Array} data
   * @param {string|undefined} [error]
   * @param {string[]|undefined} [log]
   */
  constructor(resp, data, error, log) {
    this.resp = resp;
    this.data = data;
    this.error = error;
    this.log = log;
  }
}


class cfg {
  constructor() {
    this.ZLPAwareHost = 0;
    this.SkipStorageInit = 0;
    this.SkipWrite = 0;
    this.MaxPayloadSizeToTargetInBytes = 1048576;
    this.MaxPayloadSizeFromTargetInBytes = 4096;
    this.MaxXMLSizeInBytes = 4096;
    this.bit64 = true;
    this.SECTOR_SIZE_IN_BYTES = 4096;
    this.MemoryName = "UFS";
    this.maxlun = 6;
    this.FastErase = true;
  }
}

export class Firehose {
  /**
   * @param {usbClass} cdc
   */
  constructor(cdc) {
    this.cdc = cdc;
    this.xml = new xmlParser();
    this.cfg = new cfg();
    /** @type {number[]} */
    this.luns = [];
    this.programSparseMaxExtents = 0;
  }

  /**
   * @param {string} command
   * @param {boolean} [wait=true]
   * @returns {Promise<response>}
   */
  async xmlSend(command, wait = true) {
    // FIXME: warn if command is shortened
    const dataToSend = new TextEncoder().encode(command).slice(0, this.cfg.MaxXMLSizeInBytes);
    try {
      await runWithTimeout(this.cdc.write(dataToSend, wait), 1000);
    } catch (e) {
      throw "Firehose - Timed out while sending command";
    }

    const rData = await this.waitForData();
    const resp = this.xml.getResponse(rData);
    const log = this.xml.getLog(rData);
    this.#printLogMessages(log);
    const status = !("value" in resp) || resp.value === "ACK" || resp.value === "true";
    if ("rawmode" in resp) {
      if (resp.rawmode === "false") {
        return new response(status, rData, "", log)
      }
    } else {
      if (status) {
        if (containsBytes("log value=", rData)) {
          return new response(status, rData, "", log);
        }
        return new response(status, rData);
      }
    }
    return new response(true, rData);
  }

  /**
   * Prints log messages from the device using appropriate log levels
   * @param {string[]} logs - Array of log messages
   * @private
   */
  #printLogMessages(logs) {
    for (const log of logs) logger.deviceMessage(log);
  }

  /**
   * @returns {Promise<boolean>}
   */
  async configure() {
    this.programSparseMaxExtents = 0;
    const connectCmd = toXml("configure", {
      MemoryName: this.cfg.MemoryName,
      Verbose: 0,
      AlwaysValidate: 0,
      MaxDigestTableSizeInBytes: 2048,
      MaxPayloadSizeToTargetInBytes: this.cfg.MaxPayloadSizeToTargetInBytes,
      ZlpAwareHost: this.cfg.ZLPAwareHost,
      SkipStorageInit: this.cfg.SkipStorageInit,
      SkipWrite: this.cfg.SkipWrite,
    });
    await this.cdc.write(new TextEncoder().encode(connectCmd), false);
    let data = await this.waitForData();
    let response = this.xml.getResponse(data);
    if (!("MemoryName" in response)) {
      // not reached handler yet
      data = await this.waitForData();
      response = this.xml.getResponse(data);
    }
    if (response.value !== "ACK") {
      throw new Error("Negative response");
    }
    const log = this.xml.getLog(data);
    this.#printLogMessages(log);
    if (!log.find((message) => message.includes("Calling handler for configure"))) {
      throw new Error("Failed to configure: handler not called");
    }
    if (!log.find((message) => message.includes("Storage type set to value UFS"))) {
      throw new Error("Failed to configure: storage type not set");
    }
    const sparseLimit = response.ProgramSparseMaxExtents;
    if (/^[1-9][0-9]*$/.test(sparseLimit)) {
      const limit = Number(sparseLimit);
      if (Number.isSafeInteger(limit)) this.programSparseMaxExtents = Math.min(limit, 4096);
    }
    this.luns = Array.from({ length: this.cfg.maxlun }, (x, i) => i);
    return true;
  }

  /**
   * @param {number} physicalPartitionNumber
   * @param {bigint} startSector
   * @param {number} numPartitionSectors
   * @returns {Promise<Uint8Array>}
   */
  async cmdReadBuffer(physicalPartitionNumber, startSector, numPartitionSectors) {
    await this.cdc.write(new TextEncoder().encode(toXml("read", {
      SECTOR_SIZE_IN_BYTES: this.cfg.SECTOR_SIZE_IN_BYTES,
      num_partition_sectors: numPartitionSectors,
      physical_partition_number: physicalPartitionNumber,
      start_sector: startSector,
    })));

    let data = await this.waitForData(1);
    let rsp = this.xml.getResponse(data);
    this.#printLogMessages(this.xml.getLog(data));

    if (rsp.value !== "ACK") {
      throw new Error("Failed to read buffer: negative response code");
    }
    if (rsp.rawmode !== "true") {
      throw new Error("Failed to read buffer: wrong mode");
    }

    let buffer;
    try {
      buffer = await runWithTimeout(this.cdc.read(this.cfg.SECTOR_SIZE_IN_BYTES * numPartitionSectors), 2000);
    } catch {
      throw new Error("Failed to read buffer: timed out");
    }

    data = await this.waitForData();
    rsp = this.xml.getResponse(data);
    this.#printLogMessages(this.xml.getLog(data));

    if (rsp.value !== "ACK") {
      logger.error("Negative response code", rsp);
      throw new Error("Failed to read buffer: negative response code")
    }

    return buffer;
  }

  /**
   * @param {number} [retries]
   * @returns {Promise<Uint8Array>}
   */
  async waitForData(retries = 3) {
    let tmp = new Uint8Array();
    let timeout = 0;
    while (!containsBytes("<response", tmp)) {
      const res = await runWithTimeout(this.cdc.read(), 1000).catch(() => new Uint8Array());
      if (compareStringToBytes("", res)) {
        timeout += 1;
        if (timeout > retries) break;
        continue;
      }
      timeout = 0;
      tmp = concatUint8Array([tmp, res]);
    }
    return tmp;
  }

  /**
   * @param {number} physicalPartitionNumber
   * @param {bigint} startSector
   * @param {Blob | Blob[]} blob
   * @param {progressCallback|undefined} [onProgress] - Returns number of bytes written
   * @returns {Promise<boolean>}
   */
  async cmdProgram(physicalPartitionNumber, startSector, blob, onProgress = undefined) {
    const parts = Array.isArray(blob) ? blob : [blob];
    const total = parts.reduce((size, part) => size + part.size, 0);
    const numPartitionSectors = Math.ceil(total / this.cfg.SECTOR_SIZE_IN_BYTES);
    logger.debug(`Starting program on LUN ${physicalPartitionNumber} at ${startSector} - ${BigInt(startSector) + BigInt(numPartitionSectors - 1)} (${numPartitionSectors})`);
    const rsp = await this.xmlSend(toXml("program", {
      SECTOR_SIZE_IN_BYTES: this.cfg.SECTOR_SIZE_IN_BYTES,
      num_partition_sectors: numPartitionSectors,
      physical_partition_number: physicalPartitionNumber,
      start_sector: startSector,
    }));
    if (!rsp.resp) {
      logger.error("Failed to program");
      return false;
    }

    return this.#programData(parts, onProgress);
  }

  /**
   * @param {number} physicalPartitionNumber
   * @param {bigint} startSector
   * @param {import("./sparse-program").SparseProgram} plan
   * @param {progressCallback} [onProgress]
   * @returns {Promise<boolean>}
   */
  async cmdProgramSparse(physicalPartitionNumber, startSector, plan, onProgress = undefined) {
    if (!this.programSparseMaxExtents || this.cfg.ZLPAwareHost) {
      throw new Error("Native sparse programming requires negotiated support and ZlpAwareHost=0");
    }
    const table = validateSparseProgram(plan, this.cfg.SECTOR_SIZE_IN_BYTES, plan.numPartitionSectors, this.programSparseMaxExtents);
    const result = await this.xmlSend(toXml("program_sparse", {
      SECTOR_SIZE_IN_BYTES: this.cfg.SECTOR_SIZE_IN_BYTES,
      num_partition_sectors: plan.numPartitionSectors,
      physical_partition_number: physicalPartitionNumber,
      start_sector: startSector,
      extent_count: plan.extents.length,
      data_sectors: plan.dataSectors,
    }));
    const initial = this.xml.getResponse(result.data);
    if (initial.value !== "ACK" || initial.rawmode !== "true") return false;
    await this.cdc.write(table);
    const tableData = await this.waitForData();
    this.#printLogMessages(this.xml.getLog(tableData));
    const accepted = this.xml.getResponse(tableData);
    if (accepted.value !== "ACK" || accepted.rawmode !== "true") return false;
    return this.#programData(plan.parts, onProgress, true);
  }

  async #programData(blob, onProgress, requireRawMode = false) {
    const parts = Array.isArray(blob) ? blob : [blob];
    const total = parts.reduce((size, part) => size + part.size, 0);
    let partIndex = 0;
    let partOffset = 0;
    const readPart = async (length) => {
      const data = await parts[partIndex].slice(partOffset, partOffset + length).arrayBuffer();
      if (data.byteLength !== length) throw new Error("Short image read while programming");
      partOffset += length;
      return new Uint8Array(data);
    };
    const readChunk = async (length) => {
      while (partOffset === parts[partIndex].size) {
        partIndex++;
        partOffset = 0;
      }
      const remaining = parts[partIndex].size - partOffset;
      if (remaining >= length) return readPart(length);
      if (!this.cfg.ZLPAwareHost && remaining % this.cfg.SECTOR_SIZE_IN_BYTES === 0) return readPart(remaining);
      const data = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        while (partOffset === parts[partIndex].size) {
          partIndex++;
          partOffset = 0;
        }
        const count = Math.min(length - offset, parts[partIndex].size - partOffset);
        data.set(await readPart(count), offset);
        offset += count;
      }
      return data;
    };

    const pending = [];
    const depth = this.cfg.ZLPAwareHost ? 1 : 8;
    let completed = 0;
    let chunks = 0;
    const completeWrite = async () => {
      const [result, length] = pending.shift();
      const failure = await result;
      if (failure) throw failure.error;
      completed += length;
      if (chunks++ % 10 === 0) onProgress?.(completed);
    };

    try {
      for (let offset = 0; offset < total;) {
        let wdata = await readChunk(Math.min(total - offset, this.cfg.MaxPayloadSizeToTargetInBytes));
        const wlen = wdata.byteLength;
        offset += wlen;
        if (wlen % this.cfg.SECTOR_SIZE_IN_BYTES !== 0) {
          const padded = new Uint8Array(Math.ceil(wlen / this.cfg.SECTOR_SIZE_IN_BYTES) * this.cfg.SECTOR_SIZE_IN_BYTES);
          padded.set(wdata);
          wdata = padded;
        }
        const write = this.cdc.write(wdata).then(async () => {
          if (this.cfg.ZLPAwareHost) await this.cdc.write(new Uint8Array(0));
        });
        // Observe failures immediately, including while the next file read is pending.
        pending.push([write.then(() => null, error => ({ error })), wlen]);
        if (pending.length === depth) await completeWrite();
      }
      while (pending.length) await completeWrite();
    } finally {
      await Promise.all(pending.map(([result]) => result));
    }
    onProgress?.(total);

    const wd = await this.waitForData();
    const response = this.xml.getResponse(wd);
    this.#printLogMessages(this.xml.getLog(wd));

    if (!("value" in response)){
      logger.error("Failed to program: no return value");
      return false;
    }
    if (response.value !== "ACK" || (requireRawMode && response.rawmode !== "false")) {
      logger.error("Failed to program: negative response or unexpected mode");
      return false;
    }
    return true;
  }

  /**
   * @param {number} physicalPartitionNumber
   * @param {bigint} startSector
   * @param {number} numPartitionSectors
   * @returns {Promise<boolean>}
   */
  async cmdErase(physicalPartitionNumber, startSector, numPartitionSectors) {
    const attributes = {
      SECTOR_SIZE_IN_BYTES: this.cfg.SECTOR_SIZE_IN_BYTES,
      num_partition_sectors: numPartitionSectors,
      physical_partition_number: physicalPartitionNumber,
      start_sector: startSector,
    };
    if (this.cfg.FastErase) {
      const rsp = await this.xmlSend(toXml("erase", attributes));
      const resp = this.xml.getResponse(rsp.data);
      if (!("value" in resp)) throw "Failed to erase: no return value";
      if (resp.value !== "ACK") throw "Failed to erase: NAK";
      return true;
    }
    const rsp = await this.xmlSend(toXml("program", attributes));
    let bytesToWrite = this.cfg.SECTOR_SIZE_IN_BYTES * numPartitionSectors;
    const empty = new Uint8Array(this.cfg.MaxPayloadSizeToTargetInBytes).fill(0);

    if (rsp.resp) {
      while (bytesToWrite > 0) {
        const wlen = Math.min(bytesToWrite, this.cfg.MaxPayloadSizeToTargetInBytes);
        await this.cdc.write(empty.slice(0, wlen));
        bytesToWrite -= wlen;
        if (this.cfg.ZLPAwareHost) await this.cdc.write(new Uint8Array(0));
      }

      const res = await this.waitForData();
      const response = this.xml.getResponse(res);
      this.#printLogMessages(this.xml.getLog(res));

      if ("value" in response) {
        if (response.value !== "ACK") {
          throw "Failed to erase: NAK";
        }
      } else {
        throw "Failed to erase no return value";
      }
    }
    return true;
  }

  /**
   * @param {number} lun
   * @returns {Promise<boolean>}
   */
  async cmdSetBootLunId(lun) {
    const val = await this.xmlSend(toXml("setbootablestoragedrive", { value: lun }));
    if (val.resp) {
      logger.info(`Successfully set bootID to lun ${lun}`);
      return true;
    }
    throw `Failed to set boot lun ${lun}`;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async cmdReset() {
    const val = await this.xmlSend(toXml("power", { value: "reset" }));
    if (val.resp) {
      logger.info("Reset succeeded");
      // Drain log buffer
      try {
        const rData = await this.waitForData();
        this.#printLogMessages(this.xml.getLog(rData));
      } catch {
        // Ignore any errors
      }
      return true;
    }
    throw "Reset failed";
  }

  /**
   * @returns {Promise<string[]>}
   */
  async cmdGetStorageInfo() {
    const resp = await this.xmlSend(toXml("getstorageinfo", { physical_partition_number: 0 }));
    if (!resp.resp || !resp.log) throw new Error("Failed to get storage info", { cause: resp.error });
    return resp.log;
  }

  async cmdDeviceType() {
    const resp = await this.xmlSend(toXml("devicetype"));
    try {
      const dt = this.xml.getResponse(resp.data).DeviceType;
      return dt;
    } catch (err) {
      throw new Error("Failed to get device type", { cause: err });
    }
  }

  /**
   * @param {number} lun
   * @param {number} grow_last_partition
   * @returns {Promise<void>}
   */
  async cmdFixGpt(lun, grow_last_partition) {
    const val = await this.xmlSend(toXml("fixgpt", { lun, grow_last_partition }));
    if (!val.resp) {
      throw "Firehose - Failed to fix gpt";
    }
  }

  flushDeviceMessages() {
    logger.flushDeviceMessages()
  }
}
