import { readableStreamToBlob } from "bun";
import { XzReadableStream } from "xz-decompress";

import { createQdl } from "../cli";

async function printGpt(lun) {
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

const qdl = await createQdl();

const manifestUrl = "https://raw.githubusercontent.com/commaai/openpilot/master/system/hardware/tici/all-partitions.json";
const manifest = await fetch(manifestUrl).then((res) => res.json());
const image = manifest.find((image) => image.name === "gpt_main_0");

console.info("Initial:");
await printGpt(0);

console.info("Flashing gpt_main_0");
const compressedResponse = await fetch(image.url);
const blob = await readableStreamToBlob(new XzReadableStream(compressedResponse.body));
await qdl.firehose.cmdProgram(image.gpt.lun, image.gpt.start_sector, blob);

console.info("Before fix:");
await printGpt(0);

await qdl.fixGpt(0, true);

console.info("After fix:");
await printGpt(0);

process.exit(0);
