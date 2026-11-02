#!/usr/bin/env node
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { webusb } from "usb";
import { flashManifest } from "../manifest-flash.js";
import { localOrRemoteUrl, readResource, requireNativeZstd } from "../manifest-source.js";
import { qdlDevice } from "../qdl.js";
import { usbClass } from "../usblib.js";

const { values } = parseArgs({ options: {
  manifest: { type: "string" },
  programmer: { type: "string" },
  "programmer-sha256": { type: "string" },
  help: { type: "boolean", short: "h" },
} });
if (values.help || !values.manifest || !values.programmer) {
  console.info("Usage: qdl-flash-manifest --manifest URL_OR_PATH --programmer URL_OR_PATH [--programmer-sha256 HEX]\n\nFull comma four factory flash: preserves persist, replaces both slots, and resets to slot A.\nRequires native zstd Node.js 22.23.2+ and a native sparse-copy programmer. XZ-only manifests are rejected.");
  process.exit(values.help ? 0 : 1);
}

const controller = new AbortController();
const usb = new usbClass();
const interrupted = () => { controller.abort(new Error("Interrupted")); void usb.close().catch(() => undefined); };
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
try {
  requireNativeZstd();
  const manifestUrl = localOrRemoteUrl(values.manifest);
  const entries = JSON.parse((await readResource(manifestUrl, 16 * 1024 * 1024, controller.signal)).toString("utf8"));
  const programmer = await readResource(localOrRemoteUrl(values.programmer), 32 * 1024 * 1024, controller.signal);
  if (!programmer.length) throw new Error("Programmer is empty");
  const actual = createHash("sha256").update(programmer).digest("hex");
  if (values["programmer-sha256"] && values["programmer-sha256"] !== actual) throw new Error("Programmer SHA-256 mismatch");
  console.info(JSON.stringify({ phase: "programmer", sha256: actual }));
  globalThis.navigator.usb = webusb;
  const device = new qdlDevice(programmer.buffer.slice(programmer.byteOffset, programmer.byteOffset + programmer.byteLength));
  const start = performance.now();
  await device.connect(usb);
  console.info(JSON.stringify({ phase: "connect", seconds: (performance.now() - start) / 1000 }));
  if (Number(await device.getDeviceType()) !== 34) throw new Error("This full-manifest CLI supports comma four only");
  await flashManifest(device, entries, manifestUrl, { signal: controller.signal, report: event => console.info(JSON.stringify(event)) });
} catch (error) {
  controller.abort(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await usb.close().catch(() => undefined);
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
}
