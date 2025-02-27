import { describe, expect, test } from "bun:test";

import { cmd_t, sahara_mode_t } from "./saharaDefs";
import { bytes2Number, compareStringToBytes, concatUint8Array, containsBytes, packGenerator, StructHelper } from "./utils";

describe("StructHelper", () => {
  describe("dword", () => {
    test("read multiple dwords and advance position", () => {
      const data = new Uint8Array([
        0x12, 0x34, 0x56, 0x78,
        0xFF, 0xFF, 0x00, 0x00,
      ]);
      const helper = new StructHelper(data);
      expect(helper.dword()).toBe(0x78563412);
      expect(helper.dword()).toBe(0x0000FFFF);
      expect(helper.pos).toBe(8);
    });

    test("read 32-bit integer in big-endian", () => {
      const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
      const helper = new StructHelper(data);

      const result = helper.dword(false);  // false for big-endian
      expect(result).toBe(0x12345678);
      expect(helper.pos).toBe(4);
    });
  });

  describe("qword", () => {
    test("read multiple qwords and advance position", () => {
      const data = new Uint8Array([
        0xEF, 0xCD, 0xAB, 0x90, 0x78, 0x56, 0x34, 0x12,
        0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00,
      ]);
      const helper = new StructHelper(data);
      expect(helper.qword()).toBe(BigInt("0x1234567890ABCDEF"));
      expect(helper.qword()).toBe(BigInt("0x00000000FFFFFFFF"));
      expect(helper.pos).toBe(16);
    });

    test("read 64-bit integer in big-endian", () => {
      const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90, 0xAB, 0xCD, 0xEF]);
      const helper = new StructHelper(data);

      const result = helper.qword(false);  // false for big-endian
      expect(result).toBe(BigInt("0x1234567890ABCDEF"));
      expect(helper.pos).toBe(8);
    });
  });

  test("read specified number of bytes and update position", () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const helper = new StructHelper(data);
    expect(helper.bytes(3)).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
    expect(helper.pos).toBe(3);
  });

  test("track position across multiple operations", () => {
    const data = new Uint8Array([0x78, 0x56, 0x34, 0x12, 0x41, 0x42]);
    const helper = new StructHelper(data);
    expect(helper.dword()).toBe(0x12345678);
    expect(helper.pos).toBe(4);
    expect(new TextDecoder().decode(helper.bytes(2))).toBe("AB");
    expect(helper.pos).toBe(6);
  });
});

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
    const result = packGenerator([]);
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
      1, 2, 3, 4, 5, 6,         // reserved values
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

describe("concatUint8Array", () => {
  test("should concatenate all arrays", () => {
    const array1 = new Uint8Array([0x01, 0x02]);
    const array2 = new Uint8Array([0x03, 0x04]);
    const result = concatUint8Array([array1, array2]);

    expect(result).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    expect(result.length).toEqual(array1.length + array2.length);
  });

  test("should handle empty arrays", () => {
    const array1 = new Uint8Array();
    const array2 = new Uint8Array([0x01]);
    const result = concatUint8Array([array1, array2]);

    expect(result).toEqual(new Uint8Array([0x01]));
    expect(result.length).toEqual(array1.length + array2.length);
  });

  test("should skip null values", () => {
    const array1 = new Uint8Array([0x01]);
    const array2 = null;
    const result = concatUint8Array([array1, array2] as Uint8Array[]);

    expect(result).toEqual(new Uint8Array([0x01]));
    expect(result.length).toEqual(array1.length);
  });

  test("should handle multiple nulls", () => {
    const array1 = new Uint8Array([0x01]);
    const array2 = null;
    const array3 = new Uint8Array([0x02]);
    const result = concatUint8Array([array1, array2, array3] as Uint8Array[]);

    expect(result).toEqual(new Uint8Array([0x01, 0x02]));
    expect(result.length).toEqual(array1.length + array3.length);
  });
});

describe("containsBytes", () => {
  test("empty string", () => {
    const input = new TextEncoder().encode("");
    expect(containsBytes("", input)).toBeTrue();
    expect(containsBytes("a", input)).toBeFalse();
  });

  test("substring", () => {
    const input = new TextEncoder().encode("GPT EFI PART12");
    expect(containsBytes("", input)).toBeTrue();
    expect(containsBytes("a", input)).toBeFalse();
    expect(containsBytes("EFI PART", input)).toBeTrue();
  });
});

describe("compareStringToBytes", () => {
  test("empty string", () => {
    const input = new TextEncoder().encode("");
    expect(compareStringToBytes("", input)).toBeTrue();
    expect(compareStringToBytes("a", input)).toBeFalse();
  });

  test("longer string", () => {
    const input = new TextEncoder().encode("Hello, world!");
    expect(compareStringToBytes("", input)).toBeFalse();
    expect(compareStringToBytes("Hello", input)).toBeFalse();
    expect(compareStringToBytes("Hello, world!", input)).toBeTrue();
  });

  test("empty bytes", () => {
    const input = new Uint8Array(0);
    expect(compareStringToBytes("", input)).toBeTrue();
  });
});

describe("bytes2Number", () => {
  describe("valid byte arrays", () => {
    test("should convert 4 bytes to a number correctly", () => {
      const bytes = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
      expect(bytes2Number(bytes)).toBe(0x78563412);
    });

    test("should convert 8 bytes to a number correctly", () => {
      const bytes = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]);
      expect(bytes2Number(bytes)).toBe(0xF0DEBC9A78563412n);
    });
  });

  describe("edge values", () => {
    test("should handle maximum values", () => {
      const fourBytesMax = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
      expect(bytes2Number(fourBytesMax)).toBe(0xFFFFFFFF);

      const eightBytesMax = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
      expect(bytes2Number(eightBytesMax)).toBe(0xFFFFFFFFFFFFFFFFn);
    });
  });

  describe("invalid inputs", () => {
    test("should throw error for empty array", () => {
      const emptyArray = new Uint8Array();
      expect(() => bytes2Number(emptyArray)).toThrow("Only convert to 64 and 32 bit Number");
    });

    test("should throw error for incorrect length", () => {
      const fiveBytes = new Uint8Array(5);
      expect(() => bytes2Number(fiveBytes)).toThrow("Only convert to 64 and 32 bit Number");

      const nineBytes = new Uint8Array(9);
      expect(() => bytes2Number(nineBytes)).toThrow("Only convert to 64 and 32 bit Number");
    });
  });
});
