import * as constants from "./constants";
import { concatUint8Array } from "./utils";


export class usbClass {
  constructor() {
    /** @type {USBDevice|null} */
    this.device = null;
    /** @type {USBEndpoint|null} */
    this.epIn = null;
    /** @type {USBEndpoint|null} */
    this.epOut = null;
    this.maxSize = 512;
  }

  get connected() {
    return this.device?.opened && this.device.configurations[0].interfaces[0].claimed;
  }

  /**
   * @param {USBDevice} device
   */
  #validateDevice(device) {
    const ife = device.configurations[0].interfaces[0].alternates[0];
    if (ife.endpoints.length !== 2) {
      throw "USB - Attempted to connect to null device";
    }
    let epIn = null, epOut = null;
    for (const endpoint of ife.endpoints) {
      if (endpoint.type !== "bulk") {
        throw "USB - Interface endpoint is not bulk";
      }
      if (endpoint.direction === "in") {
        if (epIn) {
          throw "USB - Interface has multiple IN endpoints";
        }
        epIn = endpoint;
      } else if (endpoint.direction === "out") {
        if (epOut) {
          throw "USB - Interface has multiple OUT endpoints";
        }
        epOut = endpoint;
      }
    }
    this.epIn = epIn;
    this.epOut = epOut;
    this.maxSize = this.epIn.packetSize;
  }

  /**
   * @param {USBDevice} device
   * @returns {Promise<void>}
   * @private
   */
  async #connectDevice(device) {
    this.device = device;
    this.#validateDevice(device);
    try {
      await device.open();
      await device.selectConfiguration(1);
      await device.claimInterface(0);
    } catch (error) {
      try {
        await device.reset();
        await device.forget();
        await device.close();
      } catch {
        // ignore cleanup errors
      }
      throw new Error("Error while connecting to device", { cause: error });
    }
  }

  async connect() {
    if (!("usb" in navigator)) {
      throw "USB - WebUSB not supported";
    }
    const device = await navigator.usb.requestDevice({
      filters: [{
        vendorId: constants.VENDOR_ID,
        productId: constants.PRODUCT_ID,
        classCode: constants.QDL_CLASS_CODE,
      }],
    });
    await this.#connectDevice(device);
  }

  async reset() {
    await this.device.reset();
  }

  /**
   * @param {number} [length=0]
   * @returns {Promise<Uint8Array>}
   */
  async read(length = 0) {
    if (!this.device || !this.epIn) throw "USB - Not connected";
    if (length) {
      /** @type {Uint8Array[]} */
      const chunks = [];
      let received = 0;
      do {
        const chunk = await this.read();
        if (chunk.byteLength) {
          chunks.push(chunk);
          received += chunk.byteLength;
        }
      } while (received < length);
      return concatUint8Array(chunks);
    } else {
      const result = await this.device.transferIn(this.epIn.endpointNumber, this.maxSize);
      return new Uint8Array(result.data?.buffer);
    }
  }

  /**
   * @param {Uint8Array} data
   * @param {boolean} [wait=true]
   * @returns {Promise<void>}
   */
  async write(data, wait = true) {
    if (!this.device || !this.epOut) throw "USB - Not connected";
    let offset = 0;
    do {
      const chunk = data.subarray(offset, offset + constants.BULK_TRANSFER_SIZE);
      offset += chunk.byteLength;
      const promise = this.device.transferOut(this.epOut.endpointNumber, chunk);
      // this is a hack, webusb doesn't have timed out catching
      // this only happens in sahara.configure(). The loader receive the packet but doesn't respond back (same as edl repo).
      if (wait) await promise;
    } while (offset < data.byteLength);
  }
}
