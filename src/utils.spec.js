import { describe, expect, test } from "bun:test";

import { cmd_t, sahara_mode_t } from "./saharaDefs";
import { packGenerator } from "./utils";

describe("packGenerator", () => {
  test("should convert single number into 4-byte Uint8Array", () => {
    const input = [42];
    const result = packGenerator(input);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(4);
    expect(result[0]).toBe(42);  // little-endian by default
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(0);
    expect(result[3]).toBe(0);
  });

  test("should handle multiple numbers", () => {
    const input = [1, 2, 3];
    const result = packGenerator(input);

    expect(result.length).toBe(12);  // 3 * 4 bytes
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(0);
    expect(result[3]).toBe(0);
    expect(result[4]).toBe(2);
    expect(result[5]).toBe(0);
    expect(result[6]).toBe(0);
    expect(result[7]).toBe(0);
    expect(result[8]).toBe(3);
    expect(result[9]).toBe(0);
    expect(result[10]).toBe(0);
    expect(result[11]).toBe(0);
  });

  test("should handle large numbers", () => {
    const input = [0xFFFFFFFF];  // max 32-bit unsigned int
    const result = packGenerator(input);

    expect(result.length).toBe(4);
    expect(result[0]).toBe(0xFF);
    expect(result[1]).toBe(0xFF);
    expect(result[2]).toBe(0xFF);
    expect(result[3]).toBe(0xFF);
  });


  test("should handle endianness correctly", () => {
    const input = [0x12345678];

    const littleEndian = packGenerator(input, true);
    expect(Array.from(littleEndian)).toEqual([0x78, 0x56, 0x34, 0x12]);

    const bigEndian = packGenerator(input, false);
    expect(Array.from(bigEndian)).toEqual([0x12, 0x34, 0x56, 0x78]);
  });

  test("should handle empty input array", () => {
    const input = [];
    const result = packGenerator(input);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  test("should handle actual Sahara protocol commands", () => {
    // This represents the hello command sequence from Sahara.js cmdHello()
    const elements = [
      cmd_t.SAHARA_HELLO_RSP,  // cmd = 0x2
      0x30,                    // len = 48 bytes (0x30)
      0x2,                     // version = 2
      0x1,                     // version_min = 1
      0x0,                     // max_cmd_len = 0
      sahara_mode_t.SAHARA_MODE_IMAGE_TX_PENDING,  // mode = 0x0
      1, 2, 3, 4, 5, 6         // reserved values
    ];
    const result = packGenerator(elements);

    // Verify length - 12 numbers * 4 bytes each
    expect(result.length).toBe(48);

    // Verify first command byte (SAHARA_HELLO_RSP = 0x2)
    expect(result[0]).toBe(0x02);
    expect(result[1]).toBe(0x00);
    expect(result[2]).toBe(0x00);
    expect(result[3]).toBe(0x00);

    // Verify length field
    expect(result[4]).toBe(0x30);
    expect(result[5]).toBe(0x00);
    expect(result[6]).toBe(0x00);
    expect(result[7]).toBe(0x00);

    // Verify mode field (SAHARA_MODE_IMAGE_TX_PENDING = 0x0)
    expect(result[20]).toBe(0x00);
    expect(result[21]).toBe(0x00);
    expect(result[22]).toBe(0x00);
    expect(result[23]).toBe(0x00);

    // Verify reserved values
    for (let i = 0; i < 6; i++) {
      expect(result[24 + (i * 4)]).toBe(i + 1);
      expect(result[24 + (i * 4) + 1]).toBe(0);
      expect(result[24 + (i * 4) + 2]).toBe(0);
      expect(result[24 + (i * 4) + 3]).toBe(0);
    }
  });
});
