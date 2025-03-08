import { webusb } from "usb";

import { qdlDevice } from "../src/qdl";
import { usbClass, USB_FILTER } from "../src/usblib";

const device = await webusb.requestDevice({
  filters: [USB_FILTER],
});

const usb = new usbClass();
await usb.connect(device);

const programmer = await fetch("https://raw.githubusercontent.com/commaai/flash/master/src/QDL/programmer.bin")
  .then((response) => response.blob())
  .then((blob) => blob.arrayBuffer());

const qdl = new qdlDevice(programmer);
await qdl.connect(usb);
console.debug("Connected!");
