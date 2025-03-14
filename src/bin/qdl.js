#!/usr/bin/env bun
import arg from "arg";

import { createProgress, createQdl } from "../cli";
import { checkHeaderCrc } from "../gpt";

const args = arg({
  "--help": Boolean,
  "-h": "--help",
  "--programmer": String,
  "--backup": Boolean,
  "-b": "--backup",
});

const { _: commands } = args;

const help = `Usage: qdl.js <command> [...flags] [...args]

Commands:
  reset                                Reboot the device
  getactiveslot                        Get the active slot
  getstorageinfo                       Print UFS information
  printgpt [--backup|-b]               Print GPT luns and partitions (optional: show backup GPT)
  repairgpt <lun> <image>              Repair GPT by flashing primary table and creating backup table
  erase <partition>                    Erase a partition
  flash <partition> <image>            Flash an image to a partition

Flags:
  --programmer <url>                   Use a different loader [default is comma 3/3X]
  -b, --backup                         Include backup GPT in operations like printgpt
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
} else if (command === "printgpt") {
  function printGpt(gpt) {
    console.table(Object.entries(gpt.partentries).map(([name, info]) => ({
      name,
      startSector: info.sector,
      sectorCount: info.sectors,
      type: info.type,
      flags: `0x${info.flags.toString(16)}`,
      uuid: info.unique.replace(/\s+/g, ""),
    })));
  }

  for (const lun of qdl.firehose.luns) {
    console.info(`LUN ${lun} - Primary GPT`);
    const [primaryGpt, mainData] = await qdl.getGpt(lun);
    printGpt(primaryGpt);
    const [primaryGptCorrupted, primaryPartTableCrc] = checkHeaderCrc(mainData, primaryGpt);
    if (primaryGptCorrupted) console.warn("Primary GPT is corrupted");

    if (args["--backup"]) {
      console.info("");
      console.info(`LUN ${lun} - Backup GPT at LBA ${primaryGpt.header.backupLba}`);
      try {
        const [backupGpt, backupData] = await qdl.getGpt(lun, primaryGpt.header.backupLba);
        printGpt(backupGpt);
        const [backupGptCorrupted, backupPartTableCrc] = checkHeaderCrc(backupData, backupGpt);
        if (backupGptCorrupted) console.warn("Backup GPT is corrupted");
        if (primaryPartTableCrc !== backupPartTableCrc) console.warn("Primary and backup GPT mismatch");
      } catch (error) {
        console.error(`Error reading backup GPT: ${error.message || error}`);
      }
    }
    console.info("");
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
  console.info(`\n${help}`)
  process.exit(1);
}

process.exit(0);
