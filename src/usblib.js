import { concatUint8Array, sleep } from "./utils";


/**
 * @type {USBDeviceFilter}
 */
export const QDL_DEVICE_FILTER = {
  vendorId: 0x05c6, productId: 0x9008, classCode: 0xff,
};


const BULK_TRANSFER_SIZE = 16384;


export class usbClass {
  /**
   * @param {USBDevice} device
   */
  constructor(device) {
    this.device = device;
    const { epIn, epOut } = usbClass.#validateDevice(device);
    this.epIn = epIn;
    this.epOut = epOut;
    this.maxSize = epIn.packetSize;
  }

  /**
   * @param {USBDevice} device
   * @returns {{ epIn: USBEndpoint, epOut: USBEndpoint }}
   */
  static #validateDevice(device) {
    const ife = device.configurations[0].interfaces[0].alternates[0];
    if (ife.endpoints.length !== 2) {
      throw "USB - Attempted to connect to null device";
    }

    let epIn = null;
    let epOut = null;
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
    console.debug("[usblib] endpoints: in =", epIn, ", out =", epOut);
    return { epIn, epOut };
  }

  /**
   * @returns {boolean}
   */
  get connected() {
    return this.device.opened && this.device.configurations[0].interfaces[0].claimed;
  }

  async #connectDevice() {
    await this.device.open();
    await this.device.selectConfiguration(1);
    try {
      await this.device.claimInterface(0);
    } catch (error) {
      await this.device.reset();
      await this.device.forget();
      await this.device.close();
      console.error(error);
      throw error;
    }
  }

  async connect() {
    try {
      await this.#connectDevice();
    } catch (error) {
      throw new Error("Failed to connect to USB device", { cause: error });
    }
  }

  async read(resplen=null) {
    let respData = new Uint8Array();
    let covered = 0;
    if (resplen === null) {
      resplen = this.epIn.packetSize;
    }

    while (covered < resplen) {
      let respPacket = await this.device.transferIn(this.epIn.endpointNumber, resplen);
      respData = concatUint8Array([respData, new Uint8Array(respPacket.data.buffer)]);
      resplen = respData.length;
      covered += respData.length;
    }
    return respData;
  }

  /**
   * @param {Uint8Array} cmdPacket
   * @param {boolean} [wait=true]
   * @returns {Promise<boolean>}
   */
  async write(cmdPacket, wait = true) {
    if (cmdPacket.length === 0) {
      try {
        await this.device.transferOut(this.epOut.endpointNumber, cmdPacket);
      } catch(error) {
        await this.device.transferOut(this.epOut.endpointNumber, cmdPacket);
      }
      return true;
    }

    let offset = 0;
    while (offset < cmdPacket.length) {
      if (wait) {
        await this.device.transferOut(this.epOut.endpointNumber, cmdPacket.slice(offset, offset + BULK_TRANSFER_SIZE));
      } else {
        // this is a hack, webusb doesn't have timed out catching
        // this only happens in sahara.configure(). The loader receive the packet but doesn't respond back (same as edl repo).
        void this.device.transferOut(this.epOut.endpointNumber, cmdPacket.slice(offset, offset + BULK_TRANSFER_SIZE));
        await sleep(80);
      }
      offset += BULK_TRANSFER_SIZE;
    }
    return true;
  }
}
