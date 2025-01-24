import { describe, test, expect } from "bun:test";

import { structHelper } from "./gpt.js";


describe("gpt structHelper", () => {
  // Helper function to create test data
  function createTestHelper(data) {
    return new structHelper(new Uint8Array(data));
  }

  test("qword should read 64-bit number and update position", () => {
    const helper = createTestHelper([0xEF, 0xCD, 0xAB, 0x89, 0x67, 0x45, 0x23, 0x01]);
    const result = helper.qword(); // little-endian by default
    expect(result).toBe(0x0123456789ABCDEF);
    expect(helper.pos).toBe(8);
  });

  test("dword should read 32-bit number and update position", () => {
    const helper = createTestHelper([0x78, 0x56, 0x34, 0x12]);
    const result = helper.dword(); // little-endian by default
    expect(result).toBe(0x12345678);
    expect(helper.pos).toBe(4);
  });

  test("bytes should read specified number of bytes and update position", () => {
    const helper = createTestHelper([0x01, 0x02, 0x03, 0x04, 0x05]);
    const result = helper.bytes(3);
    expect(Array.from(result)).toEqual([0x01, 0x02, 0x03]);
    expect(helper.pos).toBe(3);
  });

  test("toString should read bytes as string and update position", () => {
    const text = "Hello";
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const helper = createTestHelper(data);
    const result = helper.toString(5);
    const decoder = new TextDecoder();
    expect(decoder.decode(result)).toBe(text);
    expect(helper.pos).toBe(5);
  });

  test("should track position across multiple operations", () => {
    const helper = createTestHelper([
      0x78, 0x56, 0x34, 0x12,  // dword
      0x01, 0x02,              // bytes(2)
      0x41, 0x42               // toString(2)
    ]);

    // Read dword
    const dwordResult = helper.dword();
    expect(dwordResult).toBe(0x12345678);
    expect(helper.pos).toBe(4);

    // Read bytes
    const bytesResult = helper.bytes(2);
    expect(Array.from(bytesResult)).toEqual([0x01, 0x02]);
    expect(helper.pos).toBe(6);

    // Read string
    const stringResult = helper.toString(2);
    const decoder = new TextDecoder();
    expect(decoder.decode(stringResult)).toBe("AB");
    expect(helper.pos).toBe(8);
  });
});
