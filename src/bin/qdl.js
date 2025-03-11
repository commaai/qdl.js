#!/usr/bin/env bun
import arg from "arg";

import { createProgress, createQdl } from "../cli";

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

const qdl = await createQdl(args["--programmer"]);

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
