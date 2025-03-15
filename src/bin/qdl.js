#!/usr/bin/env bun
import arg from "arg";

import { createProgress, createQdl } from "../cli";
import { LogLevel, createLogger } from "../logger";

// Create CLI logger with empty name so messages aren't prefixed
const logger = createLogger("");

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
  getstorageinfo                       Print UFS information
  printgpt                             Print GPT luns and partitions
  fixgpt <lun> [grow]                  Fix GPT and grow last partition [default is true]
  erase <partition>                    Erase a partition
  flash <partition> <image>            Flash an image to a partition

Flags:
  --programmer <url>                   Use a different loader [default is comma 3/3X]
  --log-level, -l <level>              Set log level (silent, error, warn, info, debug) [default is info]
  -h, --help                           Display this menu and exit`;

if (args["--help"] || commands.length === 0) {
  logger.info(help);
  process.exit(0);
}

// Set log level if specified
if (args["--log-level"]) {
  const level = args["--log-level"].toLowerCase();
  let logLevel;
  
  switch (level) {
    case "silent":
      logLevel = LogLevel.SILENT;
      break;
    case "error":
      logLevel = LogLevel.ERROR;
      break;
    case "warn":
      logLevel = LogLevel.WARN;
      break;
    case "info":
      logLevel = LogLevel.INFO;
      break;
    case "debug":
      logLevel = LogLevel.DEBUG;
      break;
    default:
      logger.warn(`Unknown log level: '${level}', using 'info' level`);
      logLevel = LogLevel.INFO;
  }
  
  // Set environment variable so it's passed to the QDL instance
  process.env.QDL_LOG_LEVEL = logLevel.toString();
}

const qdl = await createQdl(args["--programmer"]);

const [command, ...commandArgs] = args._;
if (command === "reset") {
  await qdl.reset();
} else if (command === "getactiveslot") {
  const activeSlot = await qdl.getActiveSlot();
  logger.info(activeSlot);
} else if (command === "getstorageinfo") {
  const storageInfo = await qdl.getStorageInfo();
  storageInfo.serial_num = storageInfo.serial_num.toString(16).padStart(8, "0");
  logger.info(storageInfo);
} else if (command === "printgpt") {
  for (const lun of qdl.firehose.luns) {
    logger.info(`LUN ${lun}`);
    const [guidGpt] = await qdl.getGpt(lun);
    console.table(Object.entries(guidGpt.partentries).map(([name, info]) => ({
      name,
      startSector: info.sector,
      sectorCount: info.sectors,
      type: info.type,
      flags: `0x${info.flags.toString(16)}`,
      uuid: info.unique.replace(/\s+/g, ""),
    })));
  }
} else if (command === "fixgpt") {
  if (commandArgs.length < 1 || commandArgs.length > 2) throw "Usage: qdl.js fixgpt <lun> [grow]";
  const lun = Number.parseInt(commandArgs[0], 10);
  if (Number.isNaN(lun)) throw "Expected physical partition number";
  const grow = commandArgs[1] ? ["y", "yes", "true", "1"].includes(commandArgs[1]) : true;
  await qdl.fixGpt(lun, grow);
  logger.info(`Fixed GPT for LUN ${lun} (growLastPartition: ${grow})`);
} else if (command === "erase") {
  if (commandArgs.length !== 1) {
    logger.error("Expected partition name");
    process.exit(1);
  }
  const [partitionName] = commandArgs;
  await qdl.erase(partitionName);
} else if (command === "flash") {
  if (commandArgs.length !== 2) {
    logger.error("Expected partition name and image path");
    process.exit(1);
  }
  const [partitionName, imageName] = commandArgs;
  const image = Bun.file(imageName);
  await qdl.flashBlob(partitionName, image, createProgress(image.size));
} else {
  logger.error(`Unrecognized command: ${commands[0]}`);
  logger.info(`\n${help}`)
  process.exit(1);
}

process.exit(0);
