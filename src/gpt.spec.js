import { readableStreamToArrayBuffer } from "bun";
import { beforeAll, describe, expect, test } from "bun:test";
import { XzReadableStream } from "xz-decompress";

import { GPT } from "./gpt";

const SECTOR_SIZE = 4096;

describe("GPT", async () => {
  /** @type {GPT} */
  let gpt;
  /** @type {ArrayBuffer} */
  let gptBuffer;

  beforeAll(async () => {
    gpt = new GPT(SECTOR_SIZE);

    const manifest = await fetch("https://raw.githubusercontent.com/commaai/openpilot/master/system/hardware/tici/all-partitions.json").then((res) => res.json());
    const gptImage= manifest.find((image) => image.name === "gpt_main_0");
    const compressedResponse = await fetch(gptImage.url);
    gptBuffer = readableStreamToArrayBuffer(new XzReadableStream(compressedResponse.body));
  });

  test("parseHeader", () => {
    const headerData = new Uint8Array(gptBuffer, SECTOR_SIZE, SECTOR_SIZE);
    const result = gpt.parseHeader(headerData, 1n);
    expect(result).toMatchObject({
      mismatchCrc32: false,
    });
  });

  test("parsePartEntries", () => {
    const partEntriesData = new Uint8Array(gptBuffer, gpt.partEntriesStartLba, gpt.partEntriesSectors);
    const result = gpt.parsePartEntries(partEntriesData);
    expect(result).toMatchObject({
      mismatchCrc32: false,
    });
  });
});
