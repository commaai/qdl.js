import { concatUint8Array, containsBytes, compareStringToBytes, sleep } from "./utils"
import { toXml, xmlParser } from "./xml"


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
    this.ZLPAwareHost = 1;
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
  }

  /**
   * @param {string} command
   * @param {boolean} [wait=true]
   * @returns {Promise<response>}
   */
  async xmlSend(command, wait = true) {
    // FIXME: warn if command is shortened
    const dataToSend = new TextEncoder().encode(command).slice(0, this.cfg.MaxXMLSizeInBytes);
    await this.cdc.write(dataToSend, wait);

    let rData = new Uint8Array();
    let counter = 0;
    const timeout = 3;
    while (!(containsBytes("<response value", rData))) {
      const tmp = await this.cdc.read();
      if (compareStringToBytes("", tmp)) {
        counter += 1;
        await sleep(50);
        if (counter > timeout) {
          break;
        }
      }
      rData = concatUint8Array([rData, tmp]);
    }

    const resp = this.xml.getResponse(rData);
    const status = !("value" in resp) || resp.value === "ACK" || resp.value === "true";
    if ("rawmode" in resp) {
      if (resp.rawmode === "false") {
        const log = this.xml.getLog(rData);
        return new response(status, rData, "", log)
      }
    } else {
      if (status) {
        if (containsBytes("log value=", rData)) {
          const log = this.xml.getLog(rData);
          return new response(status, rData, "", log);
        }
        return new response(status, rData);
      }
    }
    return new response(true, rData);
  }

  /**
   * @returns {Promise<boolean>}
   */
  async configure() {
    const connectCmd = toXml("configure", {
      MemoryName: this.cfg.MemoryName,
      Verbose: 0,
      AlwaysValidate: 0,
      MaxDigestTableSizeInBytes: 2048,
      MaxPayloadSizeToTargetInBytes: this.cfg.MaxPayloadSizeToTargetInBytes,
      ZLPAwareHost: this.cfg.ZLPAwareHost,
      SkipStorageInit: this.cfg.SkipStorageInit,
      SkipWrite: this.cfg.SkipWrite,
    });
    await this.xmlSend(connectCmd, false);
    this.luns = Array.from({length: this.cfg.maxlun}, (x, i) => i);
    return true;
  }

  /**
   * @param {number} physicalPartitionNumber
   * @param {number} startSector
   * @param {number} numPartitionSectors
   * @returns {Promise<response>}
   */
  async cmdReadBuffer(physicalPartitionNumber, startSector, numPartitionSectors) {
    let rsp = await this.xmlSend(toXml("read", {
      SECTOR_SIZE_IN_BYTES: this.cfg.SECTOR_SIZE_IN_BYTES,
      num_partition_sectors: numPartitionSectors,
      physical_partition_number: physicalPartitionNumber,
      start_sector: startSector,
    }));
    let resData = new Uint8Array();
    if (!rsp.resp) {
      return rsp;
    } else {
      let bytesToRead = this.cfg.SECTOR_SIZE_IN_BYTES * numPartitionSectors;
      while (bytesToRead > 0) {
        const tmp = await this.cdc.read(Math.min(this.cdc.maxSize, bytesToRead));
        const size = tmp.length;
        bytesToRead -= size;
        resData = concatUint8Array([resData, tmp]);
      }

      const wd = await this.waitForData();
      const info = this.xml.getLog(wd);
      rsp = this.xml.getResponse(wd);
      if ("value" in rsp) {
        if (rsp.value !== "ACK") {
          return new response(false, resData, info);
        } else if ("rawmode" in rsp) {
          if (rsp.rawmode === "false") {
            return new response(true, resData);
          }
        }
      } else {
        console.error("Failed read buffer");
        return new response(false, resData, rsp[2]);
      }
    }
    const resp = rsp.value === "ACK";
    return new response(resp, resData, rsp[2]);
  }

  /**
   * @returns {Promise<Uint8Array>}
   */
  async waitForData() {
    let tmp = new Uint8Array();
    let timeout = 0;

    while (!containsBytes("response value", tmp)) {
      const res = await this.cdc.read();
      if (compareStringToBytes("", res)) {
        timeout += 1;
        if (timeout === 4) {
          break;
        }
        await sleep(20);
      }
      tmp = concatUint8Array([tmp, res]);
    }
    return tmp;
  }

  /**
   * @param {number} physicalPartitionNumber
   * @param {number} startSector
   * @param {Blob} blob
   * @param {progressCallback|undefined} [onProgress]
   * @returns {Promise<boolean>}
   */
  async cmdProgram(physicalPartitionNumber, startSector, blob, onProgress = undefined) {
    const total = blob.size;

    const rsp = await this.xmlSend(toXml("program", {
      SECTOR_SIZE_IN_BYTES: this.cfg.SECTOR_SIZE_IN_BYTES,
      num_partition_sectors: Math.ceil(total / this.cfg.SECTOR_SIZE_IN_BYTES),
      physical_partition_number: physicalPartitionNumber,
      start_sector: startSector,
    }));
    if (!rsp.resp) {
      console.error("Firehose - Failed to program");
      console.debug(rsp);
      return false;
    }

    let i = 0;
    let bytesWritten = 0;
    let offset = 0;
    let bytesToWrite = total;

    while (bytesToWrite > 0) {
      const wlen = Math.min(bytesToWrite, this.cfg.MaxPayloadSizeToTargetInBytes);
      let wdata = new Uint8Array(await blob.slice(offset, offset + wlen).arrayBuffer());
      if (wlen % this.cfg.SECTOR_SIZE_IN_BYTES !== 0) {
        const fillLen = (Math.floor(wlen / this.cfg.SECTOR_SIZE_IN_BYTES) + 1) * this.cfg.SECTOR_SIZE_IN_BYTES;
        const fillArray = new Uint8Array(fillLen - wlen).fill(0x00);
        wdata = concatUint8Array([wdata, fillArray]);
      }
      await this.cdc.write(wdata);
      await this.cdc.write(new Uint8Array(0), true);
      offset += wlen;
      bytesWritten += wlen;
      bytesToWrite -= wlen;

      // Need this for sparse image when the data.length < MaxPayloadSizeToTargetInBytes
      // Add ~2.4s to total flash time
      // if (sparseformat && bytesWritten < total) {
      //   await this.cdc.write(new Uint8Array(0), true);
      // }

      if (i % 10 === 0) {
        onProgress?.(bytesWritten / total);
      }
      i += 1;
    }

    const wd  = await this.waitForData();
    const response = this.xml.getResponse(wd);
    if (!("value" in response)){
      console.error("Firehose - Failed to program: no return value");
      return false;
    }
    if (response.value !== "ACK") {
      console.error("Firehose - Failed to program: negative response");
      return false;
    }

    onProgress?.(1.0);
    return true;
  }

  /**
   * @param {number} physicalPartitionNumber
   * @param {number} startSector
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
        await this.cdc.write(new Uint8Array(0));
      }

      const res = await this.waitForData();
      const response = this.xml.getResponse(res);
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
      console.info(`Successfully set bootID to lun ${lun}`);
      return true;
    } else {
      throw `Firehose - Failed to set boot lun ${lun}`;
    }
  }

  /**
   * @returns {Promise<boolean>}
   */
  async cmdReset() {
    const val = await this.xmlSend(toXml("power", { value: "reset" }));
    if (val.resp) {
      console.info("Reset succeeded");
      // Drain log buffer
      try {
        await this.waitForData();
      } catch {
        // Ignore any errors
      }
      return true;
    } else {
      throw "Firehose - Reset failed";
    }
  }

  /**
   * @returns {Promise<string[]>}
   */
  async cmdGetStorageInfo() {
    const resp = await this.xmlSend(toXml("getstorageinfo", { physical_partition_number: 0 }));
    if (!resp.resp || !resp.log) throw new Error("Failed to get storage info", { cause: resp.error });
    return resp.log;
  }
}
