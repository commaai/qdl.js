#!/usr/bin/env bun
import arg from "arg";

import { createProgress, createQdl } from "../cli";

const args = arg({
  "--help": Boolean,
  "-h": "--help",
  "--programmer": String,
  "--log-level": String,
  "-l": "--log-level",
});

const { _: commands } = args;

const help = `Usage: qdl.js <command> [...flags] [...args]

Commands:
  reset                                Reboot the device
  getactiveslot                        Get the active slot
  setactiveslot <slot>                 Set the active slot (a or b)
  getstorageinfo                       Print UFS information
  printgpt                             Print GPT luns and partitions
  repairgpt <lun> <image>              Repair GPT by flashing primary table and creating backup table
  erase <partition>                    Erase a partition
  flash <partition> <image>            Flash an image to a partition

Flags:
  --programmer <url>                   Use a different loader [default is comma 3/3X]
  --log-level, -l <level>              Set log level (silent, error, warn, info, debug) [default is info]
  -h, --help                           Display this menu and exit`;

if (args["--help"] || commands.length === 0) {
  console.info(help);
  process.exit(0);
}

if (args["--log-level"]) {
  // Set environment variable so it's passed to the QDL instance
  process.env.QDL_LOG_LEVEL = args["--log-level"].toLowerCase();
}

const qdl = await createQdl(args["--programmer"]);

const [command, ...commandArgs] = args._;
if (command === "reset") {
  await qdl.reset();
} else if (command === "getactiveslot") {
  const activeSlot = await qdl.getActiveSlot();
  console.info(activeSlot);
} else if (command === "setactiveslot") {
  if (commandArgs.length !== 1) {
    console.error("Expected slot name (a or b)");
    process.exit(1);
  }
  const [slot] = commandArgs;
  if (slot !== "a" && slot !== "b") {
    console.error("Slot must be 'a' or 'b'");
    process.exit(1);
  }
  await qdl.setActiveSlot(slot);
} else if (command === "getstorageinfo") {
  const storageInfo = await qdl.getStorageInfo();
  storageInfo.serial_num = storageInfo.serial_num.toString(16).padStart(8, "0");
  console.info(storageInfo);
} else if (command === "printgpt") {
  for (const lun of qdl.firehose.luns) {
    console.info(`LUN ${lun}`);

    console.info("\nPrimary GPT:");
    const primaryGpt = await qdl.getGpt(lun, 1n);
    console.table(primaryGpt.getPartitions());

    console.info("\nBackup GPT:");
    const backupGpt = await qdl.getGpt(lun, primaryGpt.alternateLba);
    console.table(backupGpt.getPartitions());

    const consistentPartEntries = primaryGpt.partEntriesCrc32 === backupGpt.partEntriesCrc32;
    if (!consistentPartEntries) {
      console.warn("\nPrimary and backup GPT partition entries are inconsistent");
    }

    console.info("\n\n");
  }
} else if (command === "repairgpt") {
  if (commandArgs.length !== 2) throw "Usage: qdl.js repairgpt <lun> <image>";
  const lun = Number.parseInt(commandArgs[0], 10);
  if (Number.isNaN(lun)) throw "Expected physical partition number";
  const image = Bun.file(commandArgs[1]);
  await qdl.repairGpt(lun, image);
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
  console.info(`\n${help}`);
  process.exit(1);
}

qdl.firehose.flushDeviceMessages();
process.exit(0);
