import { concatUint8Array } from "./utils.js";


/**
 * @type {SerialOptions}
 */
const SERIAL_OPTIONS = {
  baudRate: 115_200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  bufferSize: 16384,
  flowControl: "hardware",  // RTS and CTS
};


/**
 * @type {SerialPortFilter}
 */
export const QDL_SERIAL_FILTER = {
  usbVendorId: 0x05c6, usbProductId: 0x9008,
};


const BULK_TRANSFER_SIZE = 16384;


export class serialClass {
  /**
   * @param {SerialPort} port
   */
  constructor(port) {
    this.port = port;
    this.opened = false;
  }

  /**
   * @returns {boolean}
   */
  get connected() {
    return this.port.connected && this.opened;
  }

  /**
   * @returns {Promise<void>}
   */
  async connect() {
    try {
      await this.port.open(SERIAL_OPTIONS);
      this.opened = true;
      console.debug("port opened", this.port);
    } catch (e) {
      throw new Error("Failed to connect to serial port", { cause: e });
    }
  }

  /**
   * @param {number|null} length
   * @param {number|null} [timeout=null]
   * @returns {Promise<Uint8Array>}
   */
  async read(length, timeout = null) {
    if (!this.connected) throw new Error("Not connected");
    const packets = [];
    let covered = 0;
    let finished = false;
    if (timeout) setTimeout(() => {
      finished = true;
    }, timeout);
    // TODO: is it always readable? should there be a default limit?
    if (!this.port.readable) throw new Error("Not readable");
    const reader = this.port.readable.getReader();
    try {
      while (this.port.readable && !finished) {
        const { value, done } = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: true }), 500))]);
        console.debug("read chunk", { value, done });
        if (done) {
          break;
        }
        packets.push(value);
        covered += value.length;
        if (length && covered >= length) {
          break;
        }
      }
    } catch (error) {
      console.error("[serialClass] Error reading from port", error);
    } finally {
      reader.releaseLock();
    }
    return concatUint8Array(packets);
  }

  /**
   * @param {Uint8Array} data
   * @returns {Promise<void>}
   */
  async #write(data) {
    if (!this.port.writable) throw new Error("Not writable");
    const writer = this.port.writable.getWriter();
    let pos = 0;
    while (pos < data.length) {
      await writer.ready;
      const chunk = data.slice(pos, pos + Math.max(8, Math.min(writer.desiredSize, BULK_TRANSFER_SIZE)));
      await writer.write(chunk);
      pos += chunk.length;
    }
    writer.releaseLock();
  }

  /**
   * @param {Uint8Array} data
   * @param {boolean} [wait=true]
   */
  async write(data, wait = true) {
    if (!this.connected) throw new Error("Not connected");
    const promise = this.#write(data)
    if (wait) {
      await promise;
    }
    return true;
  }
}
