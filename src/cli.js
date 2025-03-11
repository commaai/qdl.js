import { webusb } from "usb";

import { qdlDevice } from "./qdl.js";
import { usbClass } from "./usblib.js";

/**
 * @param {string} [programmerUrl]
 * @returns {Promise<qdlDevice>}
 */
export const createQdl = async (programmerUrl = "https://raw.githubusercontent.com/commaai/flash/master/src/QDL/programmer.bin") => {
  navigator.usb = webusb;

  // TODO: support local files
  const programmer = await fetch(programmerUrl)
    .then((response) => response.blob())
    .then((blob) => blob.arrayBuffer());

  // TODO: wait for device to connect
  const qdl = new qdlDevice(programmer);
  await qdl.connect(new usbClass());
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
  const terminalWidth = (process.stdout.columns || 80) - 7;
  let prevChars = -1;
  let finished = false;

  return (progress) => {
    if (progress <= 0) finished = false;
    if (finished) return;

    const pct = Math.min(1, progress / total);
    const chars = Math.floor(pct * terminalWidth);

    if (chars === prevChars) return;
    prevChars = chars;

    const bar = "=".repeat(chars).padEnd(terminalWidth, " ");
    const percentStr = `${Math.round(pct * 100)}%`.padStart(4);
    process.stderr.write(`\r\x1b[K[${bar}] ${percentStr}`);

    if (pct >= 1) {
      process.stderr.write("\n");
      finished = true;
    }
  };
};
