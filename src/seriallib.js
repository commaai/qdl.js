import { concatUint8Array } from "./utils.js";


/**
 * @type {SerialOptions}
 */
const SERIAL_OPTIONS = {
  baudRate: 115_200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  bufferSize: undefined,
  flowControl: "hardware",  // RTS and CTS
};


/**
 * @type {SerialPortFilter}
 */
export const QDL_SERIAL_FILTER = {
  usbVendorId: 0x05c6, usbProductId: 0x9008,
};


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
    } catch (e) {
      throw new Error("Failed to connect to serial port", { cause: e });
    }
  }

  /**
   * @param {number|undefined} [length=undefined]
   * @returns {Promise<Uint8Array>}
   */
  async read(length = undefined) {
    if (!this.connected) throw new Error("Not connected");
    const packets = [];
    let covered = 0;
    // TODO: is it always readable? should there be a default limit?
    while (this.port.readable && (!length || covered < length)) {
      const reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          packets.push(value);
          covered += value.length;
        }
      } catch (error) {
        console.error("[serialClass] Error reading from port", error);
      } finally {
        reader.releaseLock();
      }
    }
    return concatUint8Array(packets);
  }

  /**
   * @param {Uint8Array} data
   * @param {boolean} [wait=true]
   */
  async write(data, wait = true) {
    if (!this.connected) throw new Error("Not connected");
    if (!this.port.writable) throw new Error("Not writable");
    const writer = this.port.writable.getWriter();
    const promise = writer.write(data).then(() => writer.releaseLock());
    if (wait) {
      await promise;
    }
  }
}
