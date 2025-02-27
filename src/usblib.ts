import * as constants from "./constants";
import { concatUint8Array, sleep } from "./utils";


class usbConnection {
  readonly endpointIn: number;
  readonly packetSizeIn: number;
  readonly endpointOut: number;

  constructor(readonly device: USBDevice) {
    const ife = device.configurations[0].interfaces[0].alternates[0];
    let epIn = undefined, epOut = undefined;
    for (const endpoint of ife.endpoints) {
      if (endpoint.type !== "bulk") throw "USB - Interface endpoint is not bulk";
      if (endpoint.direction === "in") {
        if (epIn) throw "USB - Interface has multiple IN endpoints";
        epIn = endpoint;
      } else if (endpoint.direction === "out") {
        if (epOut) throw "USB - Interface has multiple OUT endpoints";
        epOut = endpoint;
      }
    }
    if (!epIn || !epOut) throw "USB - Attempted to connect to null device";
    console.debug("[usblib] endpoints: in =", epIn, ", out =", epOut);
    this.endpointIn = epIn.endpointNumber;
    this.packetSizeIn = epIn.packetSize;
    this.endpointOut = epOut.endpointNumber;
  }

  get connected() {
    return this.device.opened && this.device.configurations[0].interfaces[0].claimed;
  }

  async connect() {
    try {
      await this.device.open();
      await this.device.selectConfiguration(1);
      await this.device.claimInterface(0);
    } catch (error) {
      try {
        await this.device.reset();
        await this.device.forget();
        await this.device.close();
      } catch {
        // ignore cleanup errors
      }
      throw new Error("Error while connecting to device", { cause: error });
    }
  }
}


export class usbClass {
  private connection?: usbConnection;

  get connected() {
    return !!this.connection?.connected;
  }

  async #connectDevice(device: USBDevice) {
    this.connection = new usbConnection(device);
    await this.connection.connect();
  }

  async connect() {
    const device = await navigator.usb.requestDevice({
      filters: [{
        vendorId: constants.VENDOR_ID,
        productId: constants.PRODUCT_ID,
        classCode: constants.QDL_CLASS_CODE,
      }],
    });
    console.debug("[usblib] Using USB device:", device);
    // TODO: is this event listener required?
    navigator.usb.addEventListener("connect", async (event) => {
      console.debug("[usblib] USB device connected:", event.device);
      await this.#connectDevice(event.device);
    });
    await this.#connectDevice(device);
  }

  async read(length = 0): Promise<Uint8Array> {
    if (!this.connection) throw "usblib - Device not connected";
    if (length) {
      const chunks: Uint8Array[] = [];
      let received = 0;
      do {
        const chunk = await this.read();
        if (chunk.byteLength) {
          chunks.push(chunk);
          received += chunk.byteLength;
        }
      } while (received < length);
      return concatUint8Array(chunks);
    }
    const { device, endpointIn, packetSizeIn } = this.connection;
    const result = await device.transferIn(endpointIn, packetSizeIn);
    return result.data ? new Uint8Array(result.data?.buffer) : new Uint8Array();
  }

  async write(data: Uint8Array, wait = true) {
    if (!this.connection) throw "usblib - Device not connected";
    const { device, endpointOut } = this.connection;
    if (data.byteLength === 0) {
      try {
        await device.transferOut(endpointOut, data);
      } catch {
        await device.transferOut(endpointOut, data);
      }
      return;
    }
    let offset = 0;
    do {
      const chunk = data.slice(offset, offset + constants.BULK_TRANSFER_SIZE);
      offset += chunk.byteLength;
      const promise = device.transferOut(endpointOut, chunk);
      // this is a hack, webusb doesn't have timed out catching
      // this only happens in sahara.configure(). The loader receive the packet but doesn't respond back (same as edl repo).
      await (wait ? promise : sleep(80));
    } while (offset < data.byteLength);
  }
}
