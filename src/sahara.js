import { CommandHandler, cmd_t, sahara_mode_t, status_t, exec_cmd_t } from "./saharaDefs"
import { containsBytes, packGenerator, runWithTimeout } from "./utils";
import { toXml } from "./xml.js";


export class Sahara {
  /**
   * @param {usbClass} cdc
   * @param {ArrayBuffer} programmer
   */
  constructor(cdc, programmer) {
    this.cdc = cdc;
    this.programmer = programmer;
    this.ch = new CommandHandler();
    this.id = null;
    this.serial = "";
    this.mode = "";
  }

  /**
   * TODO: detect other modes
   * @returns {Promise<string>}
   */
  async connect() {
    console.debug("sahara#connect");
    let respPromise = this.cdc.read(0xC * 0x4);
    let resp = await runWithTimeout(respPromise, 2000).catch(() => new Uint8Array());
    console.debug("resp:", resp);
    if (resp.length > 1) {
      if (resp[0] === 0x01) {
        const pkt = this.ch.pkt_cmd_hdr(resp);
        if (pkt.cmd === cmd_t.SAHARA_HELLO_REQ) {
          console.debug("SAHARA_HELLO_REQ");
          return "sahara";
        }
        if (pkt.cmd === cmd_t.SAHARA_END_TRANSFER) {
          console.debug("SAHARA_END_TRANSFER");
          return "sahara";
        }
        throw "Sahara - Connect failed: unknown command";
      }
      if (containsBytes("<?xml", resp)) {
        return "firehose";
      }
      if (resp[0] === 0x7E) {
        return "nandprg";
      }
    } else {
      console.debug("try nop");
      try {
        await runWithTimeout(this.cdc.write(new TextEncoder().encode(toXml("nop"))), 1000);
        if (!resp) respPromise = this.cdc.read();
        resp = await runWithTimeout(respPromise, 2000).catch(() => new Uint8Array());
      } catch {
        console.debug("write timed out");
        resp = new Uint8Array();
      }
      console.debug("resp:", resp);
      if (containsBytes("<?xml", resp)) {
        return "firehose";
      }
      if (resp.length > 0) {
        if (resp[0] === 0x7E) {
          return "nandprg";
        }
        if (resp[0] === cmd_t.SAHARA_END_TRANSFER) {
          console.debug("SAHARA_END_TRANSFER");
          return "sahara";
        }
      } else {
        const cmd = new Uint8Array([0x7E, 0x11, 0x00, 0x12, 0x00, 0xA0, 0xE3, 0x00, 0x00, 0xC1, 0xE5, 0x01, 0x40, 0xA0, 0xE3, 0x1E, 0xFF, 0x2F, 0xE1, 0x4B, 0xD9, 0x7E]);
        try {
          await runWithTimeout(this.cdc.write(cmd), 1000);
          if (!resp) respPromise = this.cdc.read();
          resp = await runWithTimeout(respPromise, 2000).catch(() => new Uint8Array());
        } catch {
          console.debug("write timed out");
          resp = new Uint8Array();
        }
        console.debug("resp:", resp);
        if (resp.length > 0 && resp[0] === 0x12) {
          return "nandprg";
        }
        if (resp.length === 0) {
          console.error("Device is in Sahara error state, please reboot the device.");
          return "error";
        }
      }
    }
    return "error";
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
    if (!(await this.cmdHello(sahara_mode_t.SAHARA_MODE_IMAGE_TX_PENDING))) {
      throw "Sahara - Error while uploading loader";
    }

    const start = performance.now();
    let remainingBytes = this.programmer.byteLength;
    while (remainingBytes >= 0) {
      const resp = await this.getResponse();
      if (!resp || !("cmd" in resp)) {
        throw "Sahara - Timeout while uploading loader. Wrong loader?";
      }
      const { cmd, data: pkt } = resp;
      if (cmd === cmd_t.SAHARA_64BIT_MEMORY_READ_DATA) {
        const { image_id, data_offset, data_len } = pkt;
        this.id = image_id;
        if (this.id < 0xC) {
          throw "Sahara - Unknown sahara id";
        }
        if (this.mode !== "firehose") {
          console.debug("[sahara] Firehose mode detected, uploading...");
          this.mode = "firehose";
        }

        let dataToWrite;
        if (data_offset + data_len > this.programmer.byteLength) {
          dataToWrite = new Uint8Array(data_len);
          if (data_offset < this.programmer.byteLength) {
            dataToWrite.set(new Uint8Array(this.programmer, data_offset, this.programmer.byteLength - data_offset));
          }
        } else {
          dataToWrite = new Uint8Array(this.programmer, data_offset, data_len);
        }

        await this.cdc.write(dataToWrite);
        remainingBytes -= data_len;
      } else if (cmd === cmd_t.SAHARA_END_TRANSFER) {
        if (pkt.image_tx_status === status_t.SAHARA_STATUS_SUCCESS) {
          if (!await this.cmdDone()) {
            throw "Sahara - Failed to upload loader";
          }
          console.debug(`[sahara] Loader successfully uploaded in ${(performance.now() - start).toFixed(3)}ms`);
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
