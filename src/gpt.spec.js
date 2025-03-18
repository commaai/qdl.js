import { readableStreamToArrayBuffer } from "bun";
import { beforeAll, describe, expect, test } from "bun:test";
import { XzReadableStream } from "xz-decompress";

import { GPT } from "./gpt";

const SECTOR_SIZE = 4096;

describe("GPT", () => {
  describe.each([0, 1, 2, 3, 4, 5])("LUN %d", async (lun) => {
    /** @type {GPT} */
    let gpt;
    /** @type {ArrayBuffer} */
    let gptBuffer;

    beforeAll(async () => {
      gpt = new GPT(SECTOR_SIZE);

      const manifest = await fetch("https://raw.githubusercontent.com/commaai/openpilot/master/system/hardware/tici/all-partitions.json").then((res) => res.json());
      const gptImage= manifest.find((image) => image.name === `gpt_main_${lun}`);
      const compressedResponse = await fetch(gptImage.url);
      gptBuffer = await readableStreamToArrayBuffer(new XzReadableStream(compressedResponse.body));
    });

    test("parseHeader", () => {
      const headerData = gptBuffer.slice(SECTOR_SIZE, SECTOR_SIZE * 2);
      const result = gpt.parseHeader(headerData, 1n);
      expect(gpt.currentLba).toBe(1n);
      expect(gpt.partEntriesStartLba).toBe(2n);
      expect(gpt.firstUsableLba).toBe(6n);
      expect(result).toMatchObject({
        mismatchCrc32: false,
      });
    });

    test("parsePartEntries", () => {
      const begin = Number(gpt.partEntriesStartLba) * SECTOR_SIZE;
      const partEntriesData = gptBuffer.slice(begin, begin + gpt.partEntriesSectors * SECTOR_SIZE);
      const result = gpt.parsePartEntries(partEntriesData);
      expect(result).toMatchObject({
        mismatchCrc32: false,
      });
    });

    if (lun === 4) {
      test("setActiveSlot", () => {
        expect(gpt.getActiveSlot()).toBe("a");
        gpt.setActiveSlot("a");
        expect(gpt.getActiveSlot()).toBe("a");
        gpt.setActiveSlot("b");
        expect(gpt.getActiveSlot()).toBe("b");
      });
    }
  });
});
