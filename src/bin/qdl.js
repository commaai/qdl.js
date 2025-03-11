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
  erase <partition>                    Erase a partition
  flash <partition> <image>            Flash an image to a partition

Flags:
  --programmer <url>                   Use a different loader [default is comma 3/3X]
  -h, --help                           Display this menu and exit`;

if (args["--help"] || commands.length === 0) {
  console.info(help);
  process.exit(0);
}

const createProgress = (total) => {
  const terminalWidth = (process.stdout.columns || 80) - 1;
  let prevChars = -1;
  return (progress) => {
    if (progress > 0 && progress < total) {
      const pct = progress / total;
      const chars = Math.floor(pct * terminalWidth);

      if (chars === prevChars) return;
      prevChars = chars;

      const bar = "=".repeat(chars).padEnd(terminalWidth, " ");
      process.stderr.write(`\r[${bar}] ${Math.round(pct * 100)}%`);
    } else {
      process.stderr.write("\n");
    }
  };
}

const programmerUrl = args["--programmer"] ?? "https://raw.githubusercontent.com/commaai/flash/master/src/QDL/programmer.bin";
const programmer = await fetch(programmerUrl)
  .then((response) => response.blob())
  .then((blob) => blob.arrayBuffer());

const qdl = new qdlDevice(programmer);
await qdl.connect(new usbClass());

const [command, ...commandArgs] = args._;
if (command === "reset") {
  await qdl.reset();
} else if (command === "getactiveslot") {
  const activeSlot = await qdl.getActiveSlot();
  console.info(activeSlot);
} else if (command === "getstorageinfo") {
  const storageInfo = await qdl.getStorageInfo();
  storageInfo.serial_num = storageInfo.serial_num.toString(16).padStart(8, "0");
  console.info(storageInfo);
} else if (command === "erase") {
  if (commandArgs.length !== 1) {
    console.error("Expected partition name");
    process.exit(1);
  }
  const [partitionName] = commandArgs;
  await qdl.erase(partitionName);
} else if (command === "flash") {
  if (commandArgs.length !== 2) {
    console.error("Expected partition name and image path");
    process.exit(1);
  }
  const [partitionName, imageName] = commandArgs;
  const image = Bun.file(imageName);
  await qdl.flashBlob(partitionName, image, createProgress(image.size));
} else {
  console.error(`Unrecognized command: ${commands[0]}`);
  console.info(`\n${help}`)
  process.exit(1);
}

process.exit(0);
