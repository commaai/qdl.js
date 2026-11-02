import { concatUint8Array, containsBytes, compareStringToBytes, runWithTimeout } from "./utils.js"
import { createLogger } from "./logger.js"
import { toXml, xmlParser } from "./xml.js"
import { validateSparseProgram } from "./sparse-program.js"
import { validateLz4Metadata, validateLz4Stream } from "./lz4-stream.js"

const logger = createLogger("firehose")

/**
 * @typedef {object} TransferOptions
 * @property {number} [transferSize=1048576] Host USB payload bytes, independent of the target receive buffer.
 * @property {number} [transferQueueDepth=8] Maximum outstanding payload writes.
 */

/** @param {TransferOptions} [options] */
export function normalizeTransferOptions({ transferSize = 1048576, transferQueueDepth = 8 } = {}) {
  if (!Number.isInteger(transferSize) || transferSize < 4096 || transferSize > 1048576 || transferSize % 4096 !== 0) {
    throw new Error("Transfer size must be a multiple of 4096 between 4096 and 1048576 bytes");
  }
  if (!Number.isInteger(transferQueueDepth) || transferQueueDepth < 1 || transferQueueDepth > 64 || transferSize * transferQueueDepth > 8 * 1048576) {
    throw new Error("Transfer queue depth must be between 1 and 64 with at most 8 MiB outstanding");
  }
  return Object.freeze({ transferSize, transferQueueDepth });
}


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
  #transferOptions;

  /**
   * @param {usbClass} cdc
   * @param {TransferOptions} [transferOptions]
   */
  constructor(cdc, transferOptions = undefined) {
    this.#transferOptions = normalizeTransferOptions(transferOptions);
    this.cdc = cdc;
    this.xml = new xmlParser();
    this.cfg = new cfg();
    /** @type {number[]} */
    this.luns = [];
    this.programSparseMaxExtents = 0;
    this.programSparseLz4 = false;
    this.ufsUnmapLimits = false;
    this.failed = false;
  }

  /**
   * @param {string} command
   * @param {boolean} [wait=true]
   * @param {number} [responseTimeoutMs=1000]
   * @returns {Promise<response>}
   */
  async xmlSend(command, wait = true, responseTimeoutMs = 1000) {
    if (this.failed) throw new Error("Flash transfer interrupted; power-cycle the device before retrying");
    // FIXME: warn if command is shortened
    const dataToSend = new TextEncoder().encode(command).slice(0, this.cfg.MaxXMLSizeInBytes);
    try {
      await runWithTimeout(this.cdc.write(dataToSend, wait), 1000);
    } catch (error) {
      throw await this.#abortProgram(error);
    }

    const rData = await this.waitForData(3, responseTimeoutMs);
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
    return new response(status, rData);
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
    if (this.failed) throw new Error("Flash transfer interrupted; power-cycle the device before retrying");
    this.programSparseMaxExtents = 0;
    this.programSparseLz4 = false;
    this.ufsUnmapLimits = false;
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
    this.ufsUnmapLimits = response.UfsUnmapLimits === "1";
    this.programSparseLz4 = response.ProgramSparseLz4 === "1" && this.programSparseMaxExtents > 0;
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
    if (this.failed) throw new Error("Flash transfer interrupted; power-cycle the device before retrying");
    try {
      await runWithTimeout(this.cdc.write(new TextEncoder().encode(toXml("read", {
        SECTOR_SIZE_IN_BYTES: this.cfg.SECTOR_SIZE_IN_BYTES,
        num_partition_sectors: numPartitionSectors,
        physical_partition_number: physicalPartitionNumber,
        start_sector: startSector,
      }))), 1000);
    } catch (error) {
      throw await this.#abortProgram(error);
    }

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
    } catch (error) {
      throw await this.#abortProgram(error);
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
   * @param {number} [timeoutMs=1000]
   * @returns {Promise<Uint8Array>}
   */
  async waitForData(retries = 3, timeoutMs = 1000) {
    if (this.failed) throw new Error("Flash transfer interrupted; power-cycle the device before retrying");
    let tmp = new Uint8Array();
    let timeout = 0;
    while (!containsBytes("<response", tmp)) {
      let res;
      try { res = await runWithTimeout(this.cdc.read(), timeoutMs); }
      catch (error) {
        // A timed-out WebUSB read cannot be withdrawn portably. Retrying could
        // let the abandoned read consume the next command's response.
        throw await this.#abortProgram(error);
      }
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
    const attributes = {
      SECTOR_SIZE_IN_BYTES: this.cfg.SECTOR_SIZE_IN_BYTES,
      num_partition_sectors: plan.numPartitionSectors,
      physical_partition_number: physicalPartitionNumber,
      start_sector: startSector,
      extent_count: plan.extents.length,
      data_sectors: plan.dataSectors,
    };
    const result = await this.xmlSend(toXml("program_sparse", attributes));
    const initial = this.xml.getResponse(result.data);
    if (initial.value !== "ACK" || initial.rawmode !== "true") return false;
    try {
      await this.cdc.write(table);
      const tableData = await this.waitForData();
      this.#printLogMessages(this.xml.getLog(tableData));
      const accepted = this.xml.getResponse(tableData);
      if (accepted.value !== "ACK" || accepted.rawmode !== "true") return false;
      return await this.#programData(plan.parts, onProgress, true);
    } catch (error) {
      if (this.failed) throw error;
      throw await this.#abortProgram(error);
    }
  }

  /**
   * @param {number} physicalPartitionNumber
   * @param {bigint} startSector
   * @param {import("./lz4-stream.js").Lz4Metadata} metadata
   * @param {ReadableStream<Uint8Array>} source Verified encoded wire bytes.
   * @param {progressCallback} [onProgress] Decoded data bytes sent, excluding sparse gaps.
   * @returns {Promise<boolean>}
   */
  async cmdProgramSparseLz4(physicalPartitionNumber, startSector, metadata, source, onProgress = undefined) {
    if (!this.programSparseLz4 || !this.programSparseMaxExtents || this.cfg.ZLPAwareHost) {
      throw new Error("LZ4 sparse programming requires negotiated support and ZlpAwareHost=0");
    }
    const plan = validateLz4Metadata(metadata, metadata.numPartitionSectors, this.programSparseMaxExtents);
    if (plan.sectorSize !== this.cfg.SECTOR_SIZE_IN_BYTES || !Number.isInteger(physicalPartitionNumber)
      || physicalPartitionNumber < 0 || physicalPartitionNumber >= this.cfg.maxlun
      || typeof startSector !== "bigint" || startSector < 0n || startSector + BigInt(plan.numPartitionSectors) > 0xffffffffffffffffn) {
      throw new Error("Invalid LZ4 sparse destination");
    }
    if (!source || typeof source.getReader !== "function" || source.locked) throw new Error("Expected an unlocked verified LZ4 stream");
    const result = await this.xmlSend(toXml("program_sparse_lz4", {
      SECTOR_SIZE_IN_BYTES: plan.sectorSize,
      num_partition_sectors: plan.numPartitionSectors,
      physical_partition_number: physicalPartitionNumber,
      start_sector: startSector,
      extent_count: plan.extents.length,
      data_sectors: plan.dataSectors,
      compressed_bytes: plan.compressedBytes,
      first_frame_bytes: plan.firstFrameBytes,
    }));
    const initial = this.xml.getResponse(result.data);
    if (initial.value !== "ACK" || initial.rawmode !== "true") return false;
    try {
      await this.cdc.write(plan.table);
      const tableData = await this.waitForData();
      this.#printLogMessages(this.xml.getLog(tableData));
      const accepted = this.xml.getResponse(tableData);
      if (accepted.value !== "ACK" || accepted.rawmode !== "true") return false;
      const frames = [];
      let decoded = 0;
      const progress = written => {
        let completed = 0;
        while (completed < frames.length && frames[completed].wireBytes <= written) decoded = frames[completed++].dataBytes;
        if (completed) frames.splice(0, completed);
        onProgress?.(decoded);
      };
      // Only a bounded USB window can run ahead of these completion markers.
      const parts = [{ size: plan.compressedBytes, stream: () => validateLz4Stream(source, plan, frame => frames.push(frame)) }];
      return await this.#programData(parts, progress, true);
    } catch (error) {
      if (this.failed) throw error;
      throw await this.#abortProgram(error);
    }
  }

  async #abortProgram(error) {
    this.failed = true;
    try { await runWithTimeout(Promise.resolve(this.cdc.close?.()), 2000); } catch { /* Preserve the transfer error. */ }
    return new Error(`${error instanceof Error ? error.message : error}; power-cycle the device before retrying`, { cause: error });
  }

  async #programData(blob, onProgress, requireRawMode = false) {
    const parts = Array.isArray(blob) ? blob : [blob];
    const total = parts.reduce((size, part) => size + part.size, 0);
    const transferSize = Math.min(this.cfg.MaxPayloadSizeToTargetInBytes, this.#transferOptions.transferSize);
    let partIndex = 0;
    let partOffset = 0;
    let reader = null;
    let readBuffer = new Uint8Array();
    let readOffset = 0;
    let writeFailure = null;
    let rejectWait = null;
    const failWrite = error => {
      writeFailure ??= { error };
      rejectWait?.(error);
      rejectWait = null;
    };
    const waitForOperation = read => {
      if (writeFailure) return Promise.reject(writeFailure.error);
      return new Promise((resolve, reject) => {
        rejectWait = reject;
        const finish = (callback, value) => {
          if (rejectWait === reject) rejectWait = null;
          callback(value);
        };
        try { Promise.resolve(read()).then(value => finish(resolve, value), error => finish(reject, error)); }
        catch (error) { finish(reject, error); }
      });
    };
    const pool = [];
    const borrowed = new Set();
    const acquire = (length) => {
      const buffer = pool.pop() || new ArrayBuffer(transferSize);
      borrowed.add(buffer);
      return new Uint8Array(buffer, 0, length);
    };
    const release = (data) => {
      if (borrowed.delete(data.buffer)) pool.push(data.buffer);
    };
    const closeReader = async () => {
      if (!reader) return;
      const current = reader;
      reader = null;
      readBuffer = new Uint8Array();
      readOffset = 0;
      try { await current.cancel(); } finally { current.releaseLock(); }
    };
    const readPart = async (length) => {
      const part = parts[partIndex];
      if (!reader && partOffset === 0 && (part.size >= transferSize || typeof part.slice !== "function") && typeof part.stream === "function") {
        reader = part.stream().getReader();
      }
      if (!reader) {
        const data = await waitForOperation(() => part.slice(partOffset, partOffset + length).arrayBuffer());
        if (data.byteLength !== length) throw new Error("Short image read while programming");
        partOffset += length;
        return new Uint8Array(data);
      }
      let data = null;
      let offset = 0;
      while (offset < length) {
        if (readOffset === readBuffer.length) {
          const result = await waitForOperation(() => reader.read());
          if (result.done) throw new Error("Short image read while programming");
          readBuffer = result.value;
          readOffset = 0;
          if (!(readBuffer instanceof Uint8Array) || readBuffer.length > part.size - partOffset) {
            throw new Error("Invalid image stream length");
          }
          if (!readBuffer.length) continue;
        }
        const count = Math.min(length - offset, readBuffer.length - readOffset);
        data ??= acquire(length);
        data.set(readBuffer.subarray(readOffset, readOffset + count), offset);
        readOffset += count;
        partOffset += count;
        offset += count;
      }
      if (partOffset === part.size) {
        // One-shot input must finish validation before its final bytes reach USB.
        if (typeof part.slice !== "function" && !(await waitForOperation(() => reader.read())).done) throw new Error("Image stream exceeds its declared size");
        await closeReader();
      }
      return data;
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
        const chunk = await readPart(count);
        data.set(chunk, offset);
        release(chunk);
        offset += count;
      }
      return data;
    };

    const pending = [];
    const depth = this.cfg.ZLPAwareHost ? 1 : this.#transferOptions.transferQueueDepth;
    let completed = 0;
    let chunks = 0;
    const completeWrite = async () => {
      const [result, length] = pending[0];
      const failure = await waitForOperation(() => result);
      pending.shift();
      if (failure) throw failure.error;
      completed += length;
      if (chunks++ % 10 === 0) onProgress?.(completed);
    };

    try {
      for (let offset = 0; offset < total;) {
        let wdata = await readChunk(Math.min(total - offset, transferSize));
        const wlen = wdata.byteLength;
        offset += wlen;
        if (wlen % this.cfg.SECTOR_SIZE_IN_BYTES !== 0) {
          const padded = new Uint8Array(Math.ceil(wlen / this.cfg.SECTOR_SIZE_IN_BYTES) * this.cfg.SECTOR_SIZE_IN_BYTES);
          padded.set(wdata);
          release(wdata);
          wdata = padded;
        }
        const write = this.cdc.write(wdata).then(async () => {
          if (this.cfg.ZLPAwareHost) await this.cdc.write(new Uint8Array(0));
        }).finally(() => release(wdata));
        // Observe failures immediately, including while the next file read is pending.
        pending.push([write.then(() => null, error => {
          failWrite(error);
          return { error };
        }), wlen]);
        if (pending.length === depth) await completeWrite();
      }
      while (pending.length) await completeWrite();
    } catch (error) {
      throw await this.#abortProgram(error);
    } finally {
      if (this.failed) {
        await Promise.allSettled([
          runWithTimeout(closeReader(), 2000),
          runWithTimeout(Promise.all(pending.map(([result]) => result)), 2000),
        ]);
      } else {
        await closeReader();
        await Promise.all(pending.map(([result]) => result));
      }
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
      const rsp = await this.xmlSend(toXml("erase", attributes), true, this.ufsUnmapLimits ? 60000 : 1000);
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
    if (val.resp && this.xml.getResponse(val.data).value === "ACK") {
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
   * @param {number} [lun=0]
   * @returns {Promise<string[]>}
   */
  async cmdGetStorageInfo(lun = 0) {
    const resp = await this.xmlSend(toXml("getstorageinfo", { physical_partition_number: lun, print_raw: 0 }));
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
