import { expect, test } from "bun:test";
import { usbClass } from "./usblib";

function transport(device) {
  const usb = new usbClass();
  usb.device = device;
  usb.epIn = { endpointNumber: 1 };
  usb.epOut = { endpointNumber: 2 };
  usb.maxSize = 1024;
  return usb;
}

test("raw reads use large requests and preserve DataView offsets", async () => {
  const sizes = [];
  const source = new Uint8Array(8194).fill(7);
  const usb = transport({ transferIn: (_, size) => {
    sizes.push(size);
    return Promise.resolve({ status: "ok", data: new DataView(source.buffer, 1, 8192) });
  } });
  const data = await usb.read(8192);
  expect(sizes).toEqual([8192]);
  expect(data.length).toBe(8192);
  expect(data.every(byte => byte === 7)).toBe(true);
});

test("raw reads handle short transfers without reading past the requested bytes", async () => {
  const sizes = [];
  const usb = transport({ transferIn: (_, size) => {
    sizes.push(size);
    return Promise.resolve({ status: "ok", data: new DataView(new ArrayBuffer(Math.min(size, 4096))) });
  } });
  expect((await usb.read(12288)).length).toBe(12288);
  expect(sizes).toEqual([12288, 8192, 4096]);
});

test("writes preserve payload order and fail on short transfers", async () => {
  const chunks = [];
  const usb = transport({ transferOut: (_, data) => {
    chunks.push(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    return Promise.resolve({ status: "ok", bytesWritten: data.byteLength });
  } });
  const data = new Uint8Array(1048576 + 4096);
  data[1048576] = 42;
  await usb.write(data);
  expect(chunks.map(chunk => chunk.length)).toEqual([1048576, 4096]);
  expect(chunks[1][0]).toBe(42);
  usb.device.transferOut = async () => ({ status: "ok", bytesWritten: 0 });
  await expect(usb.write(data)).rejects.toThrow("USB write failed");
});

test("read errors fail instead of silently returning empty data", async () => {
  const usb = transport({ transferIn: async () => ({ status: "stall" }) });
  await expect(usb.read()).rejects.toThrow("USB read failed: stall");
  await expect(usb.read(4096)).rejects.toThrow("USB read failed: stall");
});


test("whole buffers avoid the native WebUSB shim's typed-array copy", async () => {
  const data = new Uint8Array(4096);
  const usb = transport({ transferOut: (_, payload) => {
    expect(payload).toBe(data.buffer);
    return Promise.resolve({ status: "ok", bytesWritten: payload.byteLength });
  } });
  await usb.write(data);
});

test("close drops the connection and prevents further I/O even if device cleanup fails", async () => {
  const usb = transport({ opened: true, close: () => Promise.reject(new Error("disconnected")) });
  await expect(usb.close()).rejects.toThrow("disconnected");
  expect(usb.device).toBeNull();
  expect(usb.epIn).toBeNull();
  expect(usb.epOut).toBeNull();
  await expect(usb.write(new Uint8Array(1))).rejects.toBe("USB - Not connected");
});
