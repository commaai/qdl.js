import { describe, expect, mock, test } from "bun:test";

import { qdlDevice } from "./qdl";

function createFakeQdl(slot) {
  const qdl = new qdlDevice(new ArrayBuffer(1));
  const calls = [];
  const cmdSetBootLunId = mock((lun) => {
    calls.push(`bootlun:${lun}`);
    return Promise.resolve(true);
  });
  const cmdReset = mock(() => {
    calls.push("reset");
    return Promise.resolve(true);
  });

  qdl.getActiveSlot = mock(() => {
    calls.push("slot");
    if (slot instanceof Error) return Promise.reject(slot);
    return Promise.resolve(slot);
  });
  Object.defineProperty(qdl, "firehose", {
    value: { cmdSetBootLunId, cmdReset },
  });

  return { qdl, calls, cmdSetBootLunId, cmdReset };
}

describe("qdlDevice boot LUN sync", () => {
  test("maps active slot A to UFS boot LUN 1", async () => {
    const { qdl, cmdSetBootLunId } = createFakeQdl("a");

    await expect(qdl.syncBootLunWithActiveSlot()).resolves.toBe(true);

    expect(cmdSetBootLunId).toHaveBeenCalledWith(1);
  });

  test("maps active slot B to UFS boot LUN 2", async () => {
    const { qdl, cmdSetBootLunId } = createFakeQdl("b");

    await expect(qdl.syncBootLunWithActiveSlot()).resolves.toBe(true);

    expect(cmdSetBootLunId).toHaveBeenCalledWith(2);
  });

  test("reset repairs boot LUN before rebooting", async () => {
    const { qdl, calls } = createFakeQdl("b");

    await expect(qdl.reset()).resolves.toBe(true);

    expect(calls).toEqual(["slot", "bootlun:2", "reset"]);
  });

  test("reset still works on devices without A/B slot metadata", async () => {
    const { qdl, calls, cmdSetBootLunId } = createFakeQdl(new Error("Can't detect slot A or B"));

    await expect(qdl.reset()).resolves.toBe(true);

    expect(cmdSetBootLunId).not.toHaveBeenCalled();
    expect(calls).toEqual(["slot", "reset"]);
  });

  test("does not reset when boot LUN repair fails after detecting a slot", async () => {
    const { qdl, cmdSetBootLunId, cmdReset } = createFakeQdl("a");
    cmdSetBootLunId.mockImplementation(() => Promise.reject(new Error("set boot LUN failed")));

    await expect(qdl.reset()).rejects.toThrow("set boot LUN failed");

    expect(cmdReset).not.toHaveBeenCalled();
  });
});
