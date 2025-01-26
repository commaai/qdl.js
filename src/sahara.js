import { CommandHandler, cmd_t, sahara_mode_t, status_t, exec_cmd_t } from "./saharaDefs"
import { concatUint8Array, packGenerator, readBlobAsBuffer } from "./utils";


export class Sahara {
  /**
   * @param {usbClass} cdc
   * @param {string} programmerUrl
   */
  constructor(cdc, programmerUrl) {
    this.cdc = cdc;
    this.programmerUrl = programmerUrl;
    this.ch = new CommandHandler();
    this.programmer = programmerUrl.substring(programmerUrl.lastIndexOf("/") + 1);
    this.id = null;
    this.serial = "";
    this.mode = "";
    this.rootDir = null;
  }

  async connect() {
    const v = await this.cdc.read(0xC * 0x4);
    if (v.length > 1) {
      if (v[0] === 0x01) {
        let pkt = this.ch.pkt_cmd_hdr(v);
        if (pkt.cmd === cmd_t.SAHARA_HELLO_REQ) {
          const rsp = this.ch.pkt_hello_req(v);
          return { "mode" : "sahara", "cmd" : cmd_t.SAHARA_HELLO_REQ, "data" : rsp };
        }
      }
    }
    throw "Sahara - Unable to connect to Sahara";
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
    let data = packGenerator(elements);
    await this.cdc.write(data);
    return true;
  }

  async getResponse() {
    try {
      let data = await this.cdc.read();
      let data_text = new TextDecoder('utf-8').decode(data.data);
      if (data.length === 0) {
        return {};
      } else if (data_text.includes("<?xml")) {
        return {"firehose" : "yes"};
      }
      let pkt = this.ch.pkt_cmd_hdr(data);
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
    let res = await this.getResponse();
    if ("cmd" in res) {
      let cmd = res.cmd;
      if (cmd === cmd_t.SAHARA_EXECUTE_RSP) {
        let pkt = res.data;
        let data = packGenerator([cmd_t.SAHARA_EXECUTE_DATA, 0xC, mcmd]);
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
    let res = await this.cmdExec(exec_cmd_t.SAHARA_EXEC_CMD_SERIAL_NUM_READ);
    if (res === null) {
      throw "Sahara - Unable to get serial number of device";
    }
    let data = new DataView(res.buffer, 0).getUint32(0, true);
    return "0x"+data.toString(16).padStart(8,'0');
  }

  async enterCommandMode() {
    if (!await this.cmdHello(sahara_mode_t.SAHARA_MODE_COMMAND)) {
      return false;
    }
    let res = await this.getResponse();
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

  async downloadLoader() {
    this.rootDir = await navigator.storage.getDirectory();
    let writable;
    try {
      const fileHandle = await this.rootDir.getFileHandle(this.programmer, { create: true });
      writable = await fileHandle.createWritable();
    } catch (error) {
      throw `Sahara - ${error}`;
    }

    const response = await fetch(this.programmerUrl, { mode: 'cors' })
    if (!response.ok) {
      throw `Sahara - Failed to fetch loader: ${response.status} ${response.statusText}`;
    }

    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        await writable.write(value);
      }
    } catch (error) {
      throw `Sahara - Could not read response body: ${error}`;
    }

    try {
      await writable.close()
    } catch (error) {
      throw `Sahara - Error closing file handle: ${error}`;
    }
  }

  async getLoader() {
    let fileHandle;
    try {
      fileHandle = await this.rootDir.getFileHandle(this.programmer, { create: false })
    } catch (error) {
      throw `Sahara - Error getting file handle: ${error}`;
    }
    return await fileHandle.getFile();
  }

  async uploadLoader() {
    if (!(await this.enterCommandMode())) {
      throw "Sahara - Failed to enter command mode in Sahara";
    } else {
      this.serial = await this.cmdGetSerialNum();
      await this.cmdModeSwitch(sahara_mode_t.SAHARA_MODE_COMMAND);
    }

    await this.connect();
    console.log("Uploading loader...");
    await this.downloadLoader();
    const loaderBlob = await this.getLoader();
    let programmer = new Uint8Array(await readBlobAsBuffer(loaderBlob));
    if (!(await this.cmdHello(sahara_mode_t.SAHARA_MODE_IMAGE_TX_PENDING))) {
      throw "Sahara - Error while uploading loader";
    }

    let datalen = programmer.length;
    let loop    = 0;
    while (datalen >= 0) {
      let resp = await this.getResponse();
      let cmd;
      if ("cmd" in resp) {
        cmd = resp.cmd;
      } else {
        throw "Sahara - Timeout while uploading loader. Wrong loader?";
      }
      if (cmd === cmd_t.SAHARA_64BIT_MEMORY_READ_DATA) {
        let pkt = resp.data;
        this.id = pkt.image_id;
        if (this.id >= 0xC) {
          this.mode = "firehose";
          if (loop === 0) {
            console.log("Firehose mode detected, uploading...");
          }
        } else {
          throw "Sahara - Unknown sahara id";
        }

        loop += 1;
        let dataOffset = pkt.data_offset;
        let dataLen    = pkt.data_len;
        if (dataOffset + dataLen > programmer.length) {
          const fillerArray = new Uint8Array(dataOffset+dataLen-programmer.length).fill(0xff);
          programmer = concatUint8Array([programmer, fillerArray]);
        }
        let dataToSend = programmer.slice(dataOffset, dataOffset+dataLen);
        await this.cdc.write(dataToSend);
        datalen -= dataLen;
      } else if (cmd === cmd_t.SAHARA_END_TRANSFER) {
        let pkt = resp.data;
        if (pkt.image_tx_status === status_t.SAHARA_STATUS_SUCCESS) {
          if (await this.cmdDone()) {
            console.log("Loader successfully uploaded");
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
    if (await this.cdc.write(toSendData)) {
      let res = await this.getResponse();
      if ("cmd" in res) {
        let cmd = res.cmd;
        if (cmd === cmd_t.SAHARA_DONE_RSP) {
          return true;
        } else if (cmd === cmd_t.SAHARA_END_TRANSFER) {
          if ("data" in res) {
            let pkt = res.data;
            if (pkt.image_tx_status === status_t.SAHARA_NAK_INVALID_CMD) {
              console.error("Invalid transfer command received");
              return false;
            }
          }
        } else {
          throw "Sahara - Received invalid response";
        }
      }
    }
    return false;
  }
}
