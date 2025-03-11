#!/usr/bin/env bun
import arg from "arg";
import { webusb } from "usb";

import { qdlDevice } from "../qdl";
import { usbClass } from "../usblib";

navigator.usb = webusb;

const args = arg({
  "--help": Boolean,
  "-h": "--help",
  "--programmer": String,
});

const { _: commands } = args;

const help = `Usage: qdl.js <command> [...flags] [...args]

Commands:
  reset                                Reboot the device
  getactiveslot                        Get the active slot
  getstorageinfo                       Print UFS information

Flags:
  --programmer <url>                   Use a different loader [default is comma 3/3X]
  -h, --help                           Display this menu and exit`;

if (args["--help"] || commands.length === 0) {
  console.info(help);
  process.exit(0);
}

const programmerUrl = args["--programmer"] ?? "https://raw.githubusercontent.com/commaai/flash/master/src/QDL/programmer.bin";
const programmer = await fetch(programmerUrl)
  .then((response) => response.blob())
  .then((blob) => blob.arrayBuffer());

const qdl = new qdlDevice(programmer);
await qdl.connect(new usbClass());

if (commands[0] === "reset") {
  await qdl.reset();
} else if (commands[0] === "getactiveslot") {
  const activeSlot = await qdl.getActiveSlot();
  console.info(activeSlot);
} else if (commands[0] === "getstorageinfo") {
  const storageInfo = await qdl.getStorageInfo();
  storageInfo.serial_num = storageInfo.serial_num.toString(16).padStart(8, "0");
  console.info(storageInfo);
} else {
  console.error(`Unrecognized command: ${commands[0]}`);
  console.info(`\n${help}`)
  process.exit(1);
}

process.exit(0);
