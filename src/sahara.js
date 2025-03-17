import { custom, struct, uint32 } from "@incognitojam/tiny-struct";

import { cmd_t, sahara_mode_t, status_t, exec_cmd_t } from "./saharaDefs"
import { containsBytes, packGenerator, runWithTimeout } from "./utils";
import { createLogger } from "./logger";
import { toXml } from "./xml";

// parse uint64 but cast to Number
const uint64 = () => custom(8, (buffer, offset, littleEndian) => {
  return Number(buffer.getBigUint64(offset, littleEndian));
}, (buffer, offset, value, littleEndian) => {
  buffer.setBigUint64(offset, value, littleEndian);
});

const CommandHandler = {
  pkt_cmd_hdr: struct("pkt_cmd_hdr", {
    cmd: uint32(),
    len: uint32(),
  }, { littleEndian: true }),
  pkt_hello_req: struct("pkt_hello_req", {
    cmd: uint32(),
    len: uint32(),
    version: uint32(),
    version_supported: uint32(),
    cmd_packet_length: uint32(),
    mode: uint32(),
    reserved1: uint32(),
    reserved2: uint32(),
    reserved3: uint32(),
    reserved4: uint32(),
    reserved5: uint32(),
    reserved6: uint32(),
  }, { littleEndian: true }),
  pkt_image_end: struct("pkt_image_end", {
    cmd: uint32(),
    len: uint32(),
    image_id: uint32(),
    image_tx_status: uint32(),
  }, { littleEndian: true }),
  pkt_done: struct("pkt_done", {
    cmd: uint32(),
    len: uint32(),
    image_tx_status: uint32(),
  }, { littleEndian: true }),
  pkt_read_data_64: struct("pkt_read_data_64", {
    cmd: uint32(),
    len: uint32(),
    image_id: uint64(),
    data_offset: uint64(),
    data_len: uint64(),
  }, { littleEndian: true }),
  pkt_execute_rsp_cmd: struct("pkt_execute_rsp_cmd", {
    cmd: uint32(),
    len: uint32(),
    client_cmd: uint32(),
    data_len: uint32(),
  }, { littleEndian: true }),
};

const logger = createLogger("sahara");


export class Sahara {
  /**
   * @param {usbClass} cdc
   * @param {ArrayBuffer} programmer
   */
  constructor(cdc, programmer) {
    this.cdc = cdc;
    this.programmer = programmer;
    this.id = null;
    this.serial = "";
    this.mode = "";
  }

  /**
   * @returns {Promise<string>}
   */
  async connect() {
    let respPromise = this.cdc.read(0xC * 0x4);
    let resp = await runWithTimeout(respPromise, 500).catch(() => new Uint8Array());
    if (resp.length > 1) {
      if (resp[0] === 0x01) {
        const pkt = CommandHandler.pkt_cmd_hdr.from(resp);
        if (pkt.cmd === cmd_t.SAHARA_HELLO_REQ) {
          return "sahara";
        }
        if (pkt.cmd === cmd_t.SAHARA_END_TRANSFER) {
          return "sahara";
        }
        throw "Sahara - Connect failed: unknown command";
      }
      if (containsBytes("<?xml", resp)) {
        return "firehose";
      }
    } else {
      try {
        await runWithTimeout(this.cdc.write(new TextEncoder().encode(toXml("nop"))), 1000);
        if (!resp) respPromise = this.cdc.read();
        resp = await runWithTimeout(respPromise, 2000).catch(() => new Uint8Array());
      } catch {
        resp = new Uint8Array();
      }
      if (containsBytes("<?xml", resp)) {
        return "firehose";
      }
      if (resp[0] === cmd_t.SAHARA_END_TRANSFER) {
        return "sahara";
      }
    }
    logger.error("Device is in Sahara error state, please reboot the device.");
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

  /**
   * @returns {Promise<{}|{firehose: string}|{cmd: *, data: null}|{cmd: *, data: *}>}
   */
  async getResponse() {
    try {
      const data = await this.cdc.read();
      if (data.length === 0) {
        return {};
      }
      const dataText = new TextDecoder("utf-8").decode(data);
      if (dataText.includes("<?xml")) {
        return { "firehose": "yes" };
      }
      const pkt = CommandHandler.pkt_cmd_hdr.from(data);
      if (pkt.cmd === cmd_t.SAHARA_HELLO_REQ) {
        return { "cmd": pkt.cmd, "data": CommandHandler.pkt_hello_req.from(data) };
      } else if (pkt.cmd === cmd_t.SAHARA_DONE_RSP) {
        return { "cmd": pkt.cmd, "data": CommandHandler.pkt_done.from(data) };
      } else if (pkt.cmd === cmd_t.SAHARA_END_TRANSFER) {
        return { "cmd": pkt.cmd, "data": CommandHandler.pkt_image_end.from(data) };
      } else if (pkt.cmd === cmd_t.SAHARA_64BIT_MEMORY_READ_DATA) {
        return { "cmd": pkt.cmd, "data": CommandHandler.pkt_read_data_64.from(data) };
      } else if (pkt.cmd === cmd_t.SAHARA_EXECUTE_RSP) {
        return { "cmd": pkt.cmd, "data": CommandHandler.pkt_execute_rsp_cmd.from(data) };
      } else if (pkt.cmd === cmd_t.SAHARA_CMD_READY || pkt.cmd === cmd_t.SAHARA_RESET_RSP) {
        return { "cmd": pkt.cmd, "data": null };
      } else {
        logger.error("Didn't match any cmd_t");
      }
      return {};
    } catch (error) {
      logger.error(error);
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
    logger.debug("Uploading loader...");
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
          logger.debug("Firehose mode detected, uploading...");
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
          logger.debug(`Loader successfully uploaded in ${(performance.now() - start).toFixed(3)}ms`);
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
            logger.error("Invalid transfer command received");
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
