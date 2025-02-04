import { concatUint8Array, sleep } from "./utils";


/**
 * @type {USBDeviceFilter}
 */
const QDL_DEVICE_FILTER = {
  vendorId: 0x05c6, productId: 0x9008, classCode: 0xff,
};


const BULK_TRANSFER_SIZE = 16384;


/**
 * @param {USBDevice} device
 * @returns {{ epIn: USBEndpoint, epOut: USBEndpoint }}
 */
function getEndpoints(device) {
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
 * @returns {Promise<usbClass>}
 */
export async function requestDevice() {
  const device = await navigator.usb.requestDevice({
    filters: [QDL_DEVICE_FILTER],
  });
  console.info("[usblib] Using USB device:", device);
  return new usbClass(device);
}


export class usbClass {
  /**
   * @param {USBDevice} device
   */
  constructor(device) {
    this.device = device;
    const { epIn, epOut } = getEndpoints(device);
    this.epIn = epIn;
    this.epOut = epOut;
    this.maxSize = epIn.packetSize;
  }

  get connected() {
    return this.device.opened && this.device.configurations[0].interfaces[0].claimed;
  }

  async connect() {
    try {
      await this.device.open();
      await this.device.selectConfiguration(1);
      try {
        await this.device.claimInterface(0);
      } catch (error) {
        try {
          await this.device.reset();
          await this.device.forget();
          await this.device.close();
        } catch {
          // ignored
        }
        throw error;
      }
    } catch (error) {
      throw new Error("Failed to connect to USB device", { cause: error });
    }
  }

  /**
   * @param {number|undefined} [length=undefined]
   * @returns {Promise<Uint8Array<ArrayBuffer>>}
   */
  async read(length = undefined) {
    if (length) {
      /** @type {Uint8Array<ArrayBuffer>[]} */
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
    if (data.byteLength === 0) {
      try {
        await this.device.transferOut(this.epOut.endpointNumber, data);
      } catch {
        await this.device.transferOut(this.epOut.endpointNumber, data);
      }
      return;
    }

    let offset = 0;
    do {
      const chunk = data.slice(offset, offset + BULK_TRANSFER_SIZE);
      offset += chunk.byteLength;
      const promise = this.device.transferOut(this.epOut.endpointNumber, chunk);
      // this is a hack, webusb doesn't have timed out catching
      // this only happens in sahara.configure(). The loader receive the packet but doesn't respond back (same as edl repo).
      await (wait ? promise : sleep(80));
    } while (offset < data.byteLength);
  }
}
