import { CommandHandler, cmd_t, sahara_mode_t, status_t, exec_cmd_t } from "./saharaDefs"
import { concatUint8Array, packGenerator } from "./utils";


class localFile {
  constructor(url) {
    this.url = url;
    this.filename = url.substring(url.lastIndexOf("/") + 1);
  }

  async download() {
    const rootDir = await navigator.storage.getDirectory();
    let writable;
    try {
      const fileHandle = await rootDir.getFileHandle(this.filename, { create: true });
      writable = await fileHandle.createWritable();
    } catch (error) {
      throw `Sahara - Error getting file handle ${error}`;
    }
    const response = await fetch(this.url, { mode: "cors" })
    if (!response.ok || !response.body) {
      throw `Sahara - Failed to fetch loader: ${response.status} ${response.statusText}`;
    }
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
      }
    } catch (error) {
      throw `Sahara - Could not read response body: ${error}`;
    }
    try {
      await writable.close();
    } catch (error) {
      throw `Sahara - Error closing file handle: ${error}`;
    }
  }

  async get() {
    const rootDir = await navigator.storage.getDirectory();
    let fileHandle;
    try {
      fileHandle = await rootDir.getFileHandle(this.filename);
    } catch (error) {
      throw `Sahara - Error getting file handle: ${error}`;
    }
    return await fileHandle.getFile();
  }
}


export class Sahara {
  /**
   * @param {usbClass} cdc
   * @param {string} programmerUrl
   */
  constructor(cdc, programmerUrl) {
    this.cdc = cdc;
    this.programmer = new localFile(programmerUrl);
    this.ch = new CommandHandler();
    this.id = null;
    this.serial = "";
    this.mode = "";
  }

  /**
   * TODO: detect other modes
   * @returns {Promise<boolean>}
   */
  async connect() {
    const resp = await this.cdc.read(0xC * 0x4);
    if (resp.length > 1 && resp[0] === 0x01) {
      const pkt = this.ch.pkt_cmd_hdr(resp);
      if (pkt.cmd === cmd_t.SAHARA_HELLO_REQ) {
        return true;
      }
    }
    return false;
  }

  async cmdHello(mode, version=2, version_min=1, max_cmd_len=0) {
    const cmd = cmd_t.SAHARA_HELLO_RSP;
    const len = 0x30;
    const elements = [cmd, len, version, version_min, max_cmd_len, mode, 1, 2, 3, 4, 5, 6];
    const responseData = packGenerator(elements);
    await this.cdc.write(responseData);
    return true;
  }

  async cmdModeSwitch(mode) {
    const elements = [cmd_t.SAHARA_SWITCH_MODE, 0xC, mode];
    const data = packGenerator(elements);
    await this.cdc.write(data);
    return true;
  }

  async getResponse() {
    try {
      const data = await this.cdc.read();
      const data_text = new TextDecoder('utf-8').decode(data);
      if (data.length === 0) {
        return {};
      } else if (data_text.includes("<?xml")) {
        return {"firehose" : "yes"};
      }
      const pkt = this.ch.pkt_cmd_hdr(data);
      if (pkt.cmd === cmd_t.SAHARA_HELLO_REQ) {
        return {"cmd" : pkt.cmd, "data" : this.ch.pkt_hello_req(data)};
      } else if (pkt.cmd === cmd_t.SAHARA_DONE_RSP) {
        return {"cmd": pkt.cmd, "data":this.ch.pkt_done(data)}
      } else if (pkt.cmd === cmd_t.SAHARA_END_TRANSFER) {
        return {"cmd": pkt.cmd, "data": this.ch.pkt_image_end(data)};
      } else if (pkt.cmd === cmd_t.SAHARA_64BIT_MEMORY_READ_DATA) {
        return {"cmd": pkt.cmd, "data": this.ch.pkt_read_data_64(data)}
      } else if (pkt.cmd === cmd_t.SAHARA_EXECUTE_RSP) {
        return {"cmd": pkt.cmd, "data": this.ch.pkt_execute_rsp_cmd(data)};
      } else if (pkt.cmd === cmd_t.SAHARA_CMD_READY || pkt.cmd === cmd_t.SAHARA_RESET_RSP) {
        return {"cmd": pkt.cmd, "data": null };
      } else {
        console.error("Didn't match any cmd_t")
      }
      return {};
    } catch (error) {
      console.error(error);
      return {};
    }
  }

  async cmdExec(mcmd) {
    const dataToSend = packGenerator([cmd_t.SAHARA_EXECUTE_REQ, 0xC, mcmd]);
    await this.cdc.write(dataToSend);
    const res = await this.getResponse();
    if ("cmd" in res) {
      const cmd = res.cmd;
      if (cmd === cmd_t.SAHARA_EXECUTE_RSP) {
        const pkt = res.data;
        const data = packGenerator([cmd_t.SAHARA_EXECUTE_DATA, 0xC, mcmd]);
        await this.cdc.write(data);
        return await this.cdc.read(pkt.data_len);
      } else if (cmd === cmd_t.SAHARA_END_TRANSFER) {
        throw "Sahara - error while executing command";
      }
      return null;
    }
    return res;
  }

  async cmdGetSerialNum() {
    const res = await this.cmdExec(exec_cmd_t.SAHARA_EXEC_CMD_SERIAL_NUM_READ);
    if (res === null) {
      throw "Sahara - Unable to get serial number of device";
    }
    const data = new DataView(res.buffer, 0).getUint32(0, true);
    return "0x"+data.toString(16).padStart(8,'0');
  }

  async enterCommandMode() {
    if (!await this.cmdHello(sahara_mode_t.SAHARA_MODE_COMMAND)) {
      return false;
    }
    const res = await this.getResponse();
    if ("cmd" in res) {
      if (res.cmd === cmd_t.SAHARA_END_TRANSFER) {
        if ("data" in res) {
          return false;
        }
      } else if (res.cmd === cmd_t.SAHARA_CMD_READY) {
        return true;
      }
    }
    return false;
  }

  async uploadLoader() {
    if (!(await this.enterCommandMode())) {
      throw "Sahara - Failed to enter command mode in Sahara";
    }
    this.serial = await this.cmdGetSerialNum();
    await this.cmdModeSwitch(sahara_mode_t.SAHARA_MODE_COMMAND);

    await this.connect();
    console.debug("[sahara] Uploading loader...");
    await this.programmer.download();
    const loaderBlob = await this.programmer.get();
    let programmer = new Uint8Array(await loaderBlob.arrayBuffer());
    if (!(await this.cmdHello(sahara_mode_t.SAHARA_MODE_IMAGE_TX_PENDING))) {
      throw "Sahara - Error while uploading loader";
    }

    let datalen = programmer.length;
    let loop    = 0;
    while (datalen >= 0) {
      const resp = await this.getResponse();
      let cmd;
      if ("cmd" in resp) {
        cmd = resp.cmd;
      } else {
        throw "Sahara - Timeout while uploading loader. Wrong loader?";
      }
      if (cmd === cmd_t.SAHARA_64BIT_MEMORY_READ_DATA) {
        const pkt = resp.data;
        this.id = pkt.image_id;
        if (this.id >= 0xC) {
          this.mode = "firehose";
          if (loop === 0) {
            console.debug("[sahara] Firehose mode detected, uploading...");
          }
        } else {
          throw "Sahara - Unknown sahara id";
        }

        loop += 1;
        const dataOffset = pkt.data_offset;
        const dataLen    = pkt.data_len;
        if (dataOffset + dataLen > programmer.length) {
          const fillerArray = new Uint8Array(dataOffset+dataLen-programmer.length).fill(0xff);
          programmer = concatUint8Array([programmer, fillerArray]);
        }
        const dataToSend = programmer.slice(dataOffset, dataOffset+dataLen);
        await this.cdc.write(dataToSend);
        datalen -= dataLen;
      } else if (cmd === cmd_t.SAHARA_END_TRANSFER) {
        const pkt = resp.data;
        if (pkt.image_tx_status === status_t.SAHARA_STATUS_SUCCESS) {
          if (await this.cmdDone()) {
            console.debug("[sahara] Loader successfully uploaded");
          } else {
            throw "Sahara - Failed to upload loader";
          }
          return this.mode;
        }
      }
    }
    return this.mode;
  }

  async cmdDone() {
    const toSendData = packGenerator([cmd_t.SAHARA_DONE_REQ, 0x8]);
    await this.cdc.write(toSendData);
    const res = await this.getResponse();
    if ("cmd" in res) {
      const cmd = res.cmd;
      if (cmd === cmd_t.SAHARA_DONE_RSP) {
        return true;
      } else if (cmd === cmd_t.SAHARA_END_TRANSFER) {
        if ("data" in res) {
          const pkt = res.data;
          if (pkt.image_tx_status === status_t.SAHARA_NAK_INVALID_CMD) {
            console.error("Invalid transfer command received");
            return false;
          }
        }
      } else {
        throw "Sahara - Received invalid response";
      }
    }
    return false;
  }
}
