import * as constants from "./constants";
import { concatUint8Array } from "./utils";


/**
 * @type {SerialOptions}
 */
const SERIAL_OPTIONS = {
  baudRate: 115_200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  bufferSize: 16_384,
  flowControl: "hardware",  // RTS and CTS
};


export class serialClass {
  constructor() {
    /** @type {SerialPort|null} */
    this.port = null;
    this.opened = false;
  }

  get connected() {
    return this.port?.connected && this.opened;
  }

  async connect() {
    if (!("serial" in navigator)) {
      throw new Error("Browser missing Web Serial support");
    }
    const port = await navigator.serial.requestPort({
      filters: [{
        usbVendorId: constants.VENDOR_ID,
        usbProductId: constants.PRODUCT_ID,
      }],
    });
    console.debug("[seriallib] Using serial port:", port);
    this.port = port;
    try {
      await this.port.open(SERIAL_OPTIONS);
    } catch (e) {
      throw new Error("Failed to connect to serial port", { cause: e });
    }
    this.opened = true;
    console.debug("[seriallib] Connected");
  }

  /**
   * @param {number} [length=0]
   * @param {number} [timeout=0]
   * @returns {Promise<Uint8Array>}
   */
  async read(length = 0, timeout = 0) {
    if (!this.connected) throw new Error("Not connected");
    let canceled = false;
    if (timeout) setTimeout(() => {
      canceled = true;
    }, timeout);
    /** @type {Uint8Array[]} */
    const chunks = [];
    let received = 0;
    while (this.port.readable && !canceled) {
      const reader = this.port.readable.getReader();
      try {
        do {
          const { value, done } = await reader.read();
          if (done) {
            canceled = true;
            break;
          }
          chunks.push(value);
          received += value.byteLength;
        } while (length && received < length);
      } catch (error) {
        // Handle error
      } finally {
        reader.releaseLock();
      }
    }
    return concatUint8Array(chunks);
  }

  /**
   * @param {Uint8Array} data
   * @returns {Promise<void>}
   */
  async #write(data) {
    if (!this.port.writable) throw new Error("Not writable");
    const writer = this.port.writable.getWriter();
    try {
      let pos = 0;
      while (pos < data.length) {
        await writer.ready;
        const chunk = data.slice(pos, pos + Math.max(1, Math.min(constants.BULK_TRANSFER_SIZE, writer.desiredSize)));
        await writer.write(chunk);
        pos += chunk.length;
      }
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * @param {Uint8Array} data
   * @param {boolean} [wait=true]
   * @returns {Promise<void>}
   */
  async write(data, wait = true) {
    if (!this.connected) throw new Error("Not connected");
    const promise = this.#write(data);
    if (wait) await promise;
  }
}
