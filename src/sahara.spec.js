import { expect, test } from "bun:test";
import { Sahara } from "./sahara.js";
import { cmd_t, status_t } from "./saharaDefs.js";

function uploader(write, close = () => Promise.resolve()) {
  const image = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const sahara = new Sahara({ write, close }, image.buffer);
  sahara.enterCommandMode = () => Promise.resolve(true);
  sahara.cmdGetSerialNum = () => Promise.resolve("serial");
  sahara.cmdModeSwitch = () => Promise.resolve(true);
  sahara.connect = () => Promise.resolve("sahara");
  sahara.cmdHello = () => Promise.resolve(true);
  sahara.cmdDone = () => Promise.resolve(true);
  return sahara;
}

const data = offset => ({ cmd: cmd_t.SAHARA_64BIT_MEMORY_READ_DATA, data: { image_id: 13, data_offset: offset, data_len: 4 } });
const end = { cmd: cmd_t.SAHARA_END_TRANSFER, data: { image_tx_status: status_t.SAHARA_STATUS_SUCCESS } };

test("loader reads the next ROM request while its current payload write completes", async () => {
  const events = [];
  const payload = [];
  const sahara = uploader(bytes => {
    payload.push([...bytes]);
    events.push("write");
    return new Promise(resolve => setTimeout(() => { events.push("written"); resolve(); }, 1));
  });
  const responses = [data(0), data(4), end];
  sahara.getResponse = () => { events.push("read"); return Promise.resolve(responses.shift()); };
  sahara.cmdDone = () => { events.push("done"); return Promise.resolve(true); };
  expect(await sahara.uploadLoader()).toBe("firehose");
  expect(payload).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
  expect(events).toEqual(["read", "write", "read", "written", "write", "read", "written", "done"]);
});

test("loader closes USB when a write fails with a response already pending", async () => {
  let closed = false;
  let finishRead;
  let requests = 0;
  let done = false;
  const sahara = uploader(() => Promise.reject(new Error("USB disconnected")), () => {
    closed = true;
    finishRead({});
    return Promise.resolve();
  });
  sahara.getResponse = () => requests++ ? new Promise(resolve => { finishRead = resolve; }) : Promise.resolve(data(0));
  sahara.cmdDone = () => { done = true; return Promise.resolve(true); };
  await expect(sahara.uploadLoader()).rejects.toThrow("USB disconnected");
  expect(closed).toBe(true);
  expect(done).toBe(false);
  expect(requests).toBe(2);
});
