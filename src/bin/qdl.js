#!/usr/bin/env bun
import { webusb } from "usb";

import { qdlDevice } from "../qdl";
import { usbClass, USB_FILTER } from "../usblib";

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

const activeSlot = await qdl.getActiveSlot();
console.debug("Active slot:", activeSlot);
const storageInfo = await qdl.getStorageInfo();
console.debug("UFS Serial Number:", storageInfo.serial_num.toString(16).padStart(8, "0"));

process.exit(0);
