#!/usr/bin/env node
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { webusb } from "usb";
import { flashManifest } from "../manifest-flash.js";
import { localOrRemoteUrl, openVerifiedImage, readResource, requireNativeZstd } from "../manifest-source.js";
import { qdlDevice } from "../qdl.js";
import { usbClass } from "../usblib.js";

// performance.now() starts with the Node process, before static imports run.
const startupSeconds = performance.now() / 1000;
const { values } = parseArgs({ options: {
  manifest: { type: "string" },
  programmer: { type: "string" },
  "programmer-sha256": { type: "string" },
  "decode-concurrency": { type: "string", default: "8" },
  "prefetch-mib": { type: "string", default: "128" },
  slot: { type: "string", default: "a" },
  help: { type: "boolean", short: "h" },
} });
if (values.help || !values.manifest || !values.programmer) {
  console.info("Usage: qdl-flash-manifest --manifest URL_OR_PATH --programmer URL_OR_PATH [--slot a|b] [--programmer-sha256 HEX]\n\nFull comma four factory flash: preserves persist, writes the selected slot (default A), and resets.\nRequires native zstd Node.js 22.23.2+ and a native sparse programmer. XZ-only manifests are rejected.");
  process.exit(values.help ? 0 : 1);
}

const controller = new AbortController();
const usb = new usbClass();
const interrupted = () => {
  process.exitCode = 130;
  controller.abort(new Error("Interrupted"));
  void usb.close().catch(() => undefined);
  setTimeout(() => process.exit(130), 2000).unref();
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
try {
  console.info(JSON.stringify({ phase: "startup", seconds: startupSeconds }));
  requireNativeZstd();
  if (values.slot !== "a" && values.slot !== "b") throw new Error("--slot must be a or b");
  const concurrency = Number(values["decode-concurrency"]);
  if (concurrency !== 4 && concurrency !== 8) throw new Error("--decode-concurrency must be 4 or 8");
  const prefetchMiB = Number(values["prefetch-mib"]);
  if (!Number.isInteger(prefetchMiB) || prefetchMiB < 0 || prefetchMiB > 256 || (prefetchMiB !== 0 && prefetchMiB < 4)) throw new Error("--prefetch-mib must be 0 or 4..256");
  const manifestStarted = performance.now();
  const manifestUrl = localOrRemoteUrl(values.manifest);
  const entries = JSON.parse((await readResource(manifestUrl, 16 * 1024 * 1024, controller.signal)).toString("utf8"));
  console.info(JSON.stringify({ phase: "fetch_manifest", seconds: (performance.now() - manifestStarted) / 1000 }));
  const programmerStarted = performance.now();
  const programmer = await readResource(localOrRemoteUrl(values.programmer), 32 * 1024 * 1024, controller.signal);
  if (!programmer.length) throw new Error("Programmer is empty");
  const actual = createHash("sha256").update(programmer).digest("hex");
  if (values["programmer-sha256"] && values["programmer-sha256"] !== actual) throw new Error("Programmer SHA-256 mismatch");
  console.info(JSON.stringify({ phase: "fetch_programmer", seconds: (performance.now() - programmerStarted) / 1000, sha256: actual }));
  globalThis.navigator.usb = webusb;
  const device = new qdlDevice(programmer.buffer.slice(programmer.byteOffset, programmer.byteOffset + programmer.byteLength));
  const start = performance.now();
  await device.connect(usb);
  console.info(JSON.stringify({ phase: "connect", seconds: (performance.now() - start) / 1000 }));
  await flashManifest(device, entries, manifestUrl, {
    slot: values.slot,
    prefetchBytes: prefetchMiB * 1024 * 1024,
    signal: controller.signal,
    report: event => console.info(JSON.stringify(event)),
    openImage: (image, signal) => openVerifiedImage(image, signal, concurrency),
  });
} catch (error) {
  controller.abort(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  const closeStarted = performance.now();
  // A timed-out libusb read can keep close pending. Process exit releases its USB handle.
  const deadline = setTimeout(() => process.exit(process.exitCode ?? 0), 2000);
  deadline.unref();
  await usb.close().catch(() => undefined);
  console.info(JSON.stringify({ phase: "close_usb", seconds: (performance.now() - closeStarted) / 1000 }));
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
}
console.info(JSON.stringify({ phase: "command", seconds: performance.now() / 1000, success: !process.exitCode }));
await new Promise(resolve => process.stdout.write("", resolve));
process.exit(process.exitCode ?? 0);
