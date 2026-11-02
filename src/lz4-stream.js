import { createLz4Stream } from "./lz4-frame-reader.js";

export { validateLz4Metadata } from "./lz4-frame-reader.js";

/** @typedef {import("./lz4-frame-reader.js").Lz4Metadata} Lz4Metadata */

/**
 * Validate chained native LZ4 frames from an authenticated source stream.
 * The complete final frame is held until the exact source length and EOF pass.
 * Returned chunks own their bytes and may be retained after subsequent reads.
 * @param {ReadableStream<Uint8Array>} source
 * @param {Lz4Metadata} metadata
 * @param {(progress: {wireBytes: number, dataBytes: number}) => void} [onFrame]
 * @returns {ReadableStream<Uint8Array>}
 */
export function validateLz4Stream(source, metadata, onFrame = undefined) {
  return createLz4Stream(source, metadata, onFrame);
}
