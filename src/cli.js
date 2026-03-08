import { webusb } from "usb";

import { qdlDevice } from "./qdl.js";
import { usbClass } from "./usblib.js";

/**
 * @param {string} [programmerUrl]
 * @returns {Promise<qdlDevice>}
 */
export const createQdl = async (programmerUrl = "https://raw.githubusercontent.com/commaai/flash/master/src/QDL/programmer.bin") => {
  navigator.usb = webusb;

  let programmer;
  if (programmerUrl.startsWith("file://") || programmerUrl.startsWith("/")) {
    const path = programmerUrl.replace(/^file:\/\//, "");
    programmer = await Bun.file(path).arrayBuffer();
  } else {
    programmer = await fetch(programmerUrl)
      .then((response) => response.blob())
      .then((blob) => blob.arrayBuffer());
  }

  // TODO: wait for device to connect
  const qdl = new qdlDevice(programmer);
  try {
    await qdl.connect(new usbClass());
  } catch (e) {
    throw new Error(`Failed to connect: ${e.message || e}`, { cause: e });
  }
  return qdl;
};

/**
 * Display a progress bar in the terminal.
 *
 * Call the returned function with the current progress, out of <code>total</code>,
 * to update the progress bar.
 *
 * @param {number} [total = 1.0]
 * @returns {(function(number): void)}
 */
export const createProgress = (total = 1.0) => {
  const barLength = 20;
  let finished = false;
  let startTime = 0;

  return (progress) => {
    if (startTime === 0) startTime = Date.now();
    if (progress <= 0) finished = false;
    if (finished) return;

    const now = Date.now();
    const pct = Math.min(1, progress / total);
    const filledLength = Math.round(pct * barLength);
    const bar = "\u2588".repeat(filledLength) + "-".repeat(barLength - filledLength);
    const percentStr = `${Math.round(pct * 100)}%`.padStart(4);

    // cumulative average throughput (MB/s)
    const elapsed = (now - startTime) / 1000;
    const throughput = elapsed > 0 ? progress / elapsed / 1024 / 1024 : 0;
    // fixed-width: " 1234 MB/s" = 10 chars
    const speedStr = `${Math.round(throughput).toString().padStart(5)} MB/s`;

    // fixed-width time: "00h:00m:00s ____" = 16 chars
    let timeStr = " ".repeat(16);
    if (pct > 0 && elapsed > 0) {
      const t = pct >= 1 ? elapsed : Math.max(0, (elapsed / pct) * (1 - pct));
      const label = pct >= 1 ? "done" : "left";
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = Math.floor(t % 60);
      timeStr = `${String(h).padStart(2, "0")}h:${String(m).padStart(2, "0")}m:${String(s).padStart(2, "0")}s ${label}`;
    }

    const line = ` |${bar}| ${percentStr} ${speedStr} ${timeStr}`;
    process.stderr.write(`\r${line}`);

    if (pct >= 1) {
      process.stderr.write("\n");
      finished = true;
    }
  };
};
