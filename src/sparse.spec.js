import * as Bun from "bun";
import { describe, it, expect } from "bun:test";

import * as Sparse from "./sparse";

const inputData = Bun.file("./test/fixtures/boot.simg");
const expectedData = Bun.file("./test/fixtures/boot.img");

describe("sparse", () => {
  it("should match expected data", async () => {
    console.time("splitBlob");
    const receivedData = new Blob(await Array.fromAsync(Sparse.splitBlob(inputData)));
    console.timeEnd("splitBlob");

    const expectedBytes = await expectedData.bytes();
    console.log(receivedData);
    const receivedBytes = new Uint8Array(await receivedData.arrayBuffer());
    expect(receivedBytes.byteLength).toEqual(expectedBytes.byteLength);
    expect(Buffer.from(receivedBytes).compare(Buffer.from(expectedBytes))).toBe(0);
  });
});
