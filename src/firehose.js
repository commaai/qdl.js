import * as Sparse from "./sparse"
import { concatUint8Array, containsBytes, compareStringToBytes, sleep, readBlobAsBuffer } from "./utils"
import { xmlParser } from "./xmlParser"


class response {
  constructor(resp=false, data=new Uint8Array(), error="", log=[]) {
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
  }
}

export class Firehose {
  constructor(cdc) {
    this.cdc = cdc;
    this.xml = new xmlParser();
    this.cfg = new cfg();
    this.luns = [];
  }

  getStatus(resp) {
    if ("value" in resp) {
      let value = resp.value;
      return (value === "ACK" || value === "true");
    }
    return true;
  }

  async xmlSend(data, wait=true) {
    let dataToSend = new TextEncoder().encode(data).slice(0, this.cfg.MaxXMLSizeInBytes);
    await this.cdc?.write(dataToSend, null, wait);

    let rData = new Uint8Array();
    let counter = 0;
    let timeout = 3;
    while (!(containsBytes("<response value", rData))) {
      let tmp = await this.cdc?.read();
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
    const status = this.getStatus(resp);
    if ("rawmode" in resp) {
      if (resp.rawmode === "false") {
        let log = this.xml.getLog(rData);
        return new response(status, rData, "", log)
      }
    } else {
      if (status) {
        if (containsBytes("log value=", rData)) {
          let log = this.xml.getLog(rData);
          return new response(status, rData, "", log);
        }
        return new response(status, rData);
      }
    }
    return new response(true, rData);
  }

  getLuns() {
    return Array.from({length: this.cfg.maxlun}, (x, i) => i)
  }

  async configure() {
    const connectCmd = `<?xml version="1.0" encoding="UTF-8" ?><data>` +
              `<configure MemoryName="${this.cfg.MemoryName}" ` +
              `Verbose="0" ` +
              `AlwaysValidate="0" ` +
              `MaxDigestTableSizeInBytes="2048" ` +
              `MaxPayloadSizeToTargetInBytes="${this.cfg.MaxPayloadSizeToTargetInBytes}" ` +
              `ZLPAwareHost="${this.cfg.ZLPAwareHost}" ` +
              `SkipStorageInit="${this.cfg.SkipStorageInit}" ` +
              `SkipWrite="${this.cfg.SkipWrite}"/>` +
              `</data>`

    await this.xmlSend(connectCmd, false);
    this.luns = this.getLuns();
    return true;
  }

  async cmdReadBuffer(physicalPartitionNumber, startSector, numPartitionSectors) {
    const data = `<?xml version="1.0" ?><data><read SECTOR_SIZE_IN_BYTES="${this.cfg.SECTOR_SIZE_IN_BYTES}"` +
        ` num_partition_sectors="${numPartitionSectors}"` +
        ` physical_partition_number="${physicalPartitionNumber}"` +
        ` start_sector="${startSector}"/>\n</data>`

    let rsp = await this.xmlSend(data);
    let resData = new Uint8Array();
    if (!rsp.resp) {
      return rsp;
    } else {
      let bytesToRead = this.cfg.SECTOR_SIZE_IN_BYTES * numPartitionSectors;
      while (bytesToRead > 0) {
        let tmp = await this.cdc.read(Math.min(this.cdc.maxSize, bytesToRead));
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
    let resp = rsp.value === "ACK";
    return new response(resp, resData, rsp[2]);
  }

  async waitForData() {
    let tmp = new Uint8Array();
    let timeout = 0;

    while (!containsBytes("response value", tmp)) {
      let res = await this.cdc.read();
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

  async cmdProgram(physicalPartitionNumber, startSector, blob, onProgress=()=>{}) {
    let total = blob.size;
    let sparseformat = false;

    let sparseHeader = await Sparse.parseFileHeader(blob.slice(0, Sparse.FILE_HEADER_SIZE));
    if (sparseHeader !== null) {
      sparseformat = true;
      total = await Sparse.getSparseRealSize(blob, sparseHeader);
    }

    let numPartitionSectors = Math.floor(total / this.cfg.SECTOR_SIZE_IN_BYTES);
    if (total % this.cfg.SECTOR_SIZE_IN_BYTES !== 0) {
      numPartitionSectors += 1;
    }

    const data = `<?xml version="1.0" ?><data>\n` +
              `<program SECTOR_SIZE_IN_BYTES="${this.cfg.SECTOR_SIZE_IN_BYTES}"` +
              ` num_partition_sectors="${numPartitionSectors}"` +
              ` physical_partition_number="${physicalPartitionNumber}"` +
              ` start_sector="${startSector}" />\n</data>`;
    let i = 0;
    let bytesWritten = 0;
    let rsp = await this.xmlSend(data);

    if (rsp.resp) {
      for await (let split of Sparse.splitBlob(blob)) {
        let offset = 0;
        let bytesToWriteSplit = split.size;

        while (bytesToWriteSplit > 0) {
          const wlen = Math.min(bytesToWriteSplit, this.cfg.MaxPayloadSizeToTargetInBytes);
          let wdata = new Uint8Array(await readBlobAsBuffer(split.slice(offset, offset + wlen)));
          if (wlen % this.cfg.SECTOR_SIZE_IN_BYTES !== 0) {
            let fillLen = (Math.floor(wlen/this.cfg.SECTOR_SIZE_IN_BYTES) * this.cfg.SECTOR_SIZE_IN_BYTES) +
                          this.cfg.SECTOR_SIZE_IN_BYTES;
            const fillArray = new Uint8Array(fillLen-wlen).fill(0x00);
            wdata = concatUint8Array([wdata, fillArray]);
          }
          await this.cdc.write(wdata);
          await this.cdc.write(new Uint8Array(0), null, true);
          offset += wlen;
          bytesWritten += wlen;
          bytesToWriteSplit -= wlen;

          // Need this for sparse image when the data.length < MaxPayloadSizeToTargetInBytes
          // Add ~2.4s to total flash time
          if (sparseformat && bytesWritten < total) {
            await this.cdc.write(new Uint8Array(0), null, true);
          }

          if (i % 10 === 0) {
            onProgress(bytesWritten/total);
          }
          i += 1;
        }
      }

      const wd  = await this.waitForData();
      const response = this.xml.getResponse(wd);
      if ("value" in response) {
        if (response.value !== "ACK") {
          return false;
        }
      } else {
        return false;
      }
    }

    onProgress(1.0);
    return true;
  }

  async cmdErase(physicalPartitionNumber, startSector, numPartitionSectors) {
    const data = `<?xml version="1.0" ?><data>\n` +
          `<program SECTOR_SIZE_IN_BYTES="${this.cfg.SECTOR_SIZE_IN_BYTES}"` +
          ` num_partition_sectors="${numPartitionSectors}"` +
          ` physical_partition_number="${physicalPartitionNumber}"` +
          ` start_sector="${startSector}" />\n</data>`;
    let rsp = await this.xmlSend(data)
    let bytesToWrite = this.cfg.SECTOR_SIZE_IN_BYTES * numPartitionSectors;
    let empty = new Uint8Array(this.cfg.MaxPayloadSizeToTargetInBytes).fill(0);

    if (rsp.resp) {
      while (bytesToWrite > 0) {
        let wlen = Math.min(bytesToWrite, this.cfg.MaxPayloadSizeToTargetInBytes);
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

  async cmdSetBootLunId(lun) {
    const data = `<?xml version="1.0" ?><data>\n<setbootablestoragedrive value="${lun}" /></data>`
    const val = await this.xmlSend(data);
    if (val.resp) {
      console.log(`Successfully set bootID to lun ${lun}`);
      return true;
    } else {
      throw `Firehose - Failed to set boot lun ${lun}`;
    }
  }

  async cmdReset() {
    let data = '<?xml version="1.0" ?><data><power value="reset"/></data>';
    let val = await this.xmlSend(data);
    if (val.resp) {
      console.log("Reset succeeded");
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
}
