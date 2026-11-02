import { webcrypto } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

export const VERIFIED_CHUNK_SIZE = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const webBuffer = { strategy: { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength } };

export function resourceUrl(value, base = pathToFileURL(`${process.cwd()}/`)) {
  return value instanceof URL ? value : new URL(value, base);
}

export function localOrRemoteUrl(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? new URL(value) : pathToFileURL(resolve(value));
}

export function requireNativeZstd() {
  if (typeof zlib.createZstdDecompress !== "function") {
    throw new Error("Native zstd requires Node.js with createZstdDecompress (tested with 22.23.2); Bun is not supported by this CLI");
  }
}

export function validateImageHashes(image) {
  if (!Number.isSafeInteger(image.fileSize) || image.fileSize <= 0 || !SHA256.test(image.hash)
    || image.chunkSize !== VERIFIED_CHUNK_SIZE || !Array.isArray(image.chunkHashes)
    || image.chunkHashes.length !== Math.ceil(image.fileSize / VERIFIED_CHUNK_SIZE)
    || image.chunkHashes.some(hash => typeof hash !== "string" || !SHA256.test(hash))) {
    throw new Error(`Invalid decoded length or SHA-256 chunk metadata for ${image.name}`);
  }
}

export function validateFrameSizes(sizes, image) {
  if (!Array.isArray(sizes) || sizes.length !== image.chunkHashes.length
    || sizes.some(size => !Number.isSafeInteger(size) || size <= 0 || size > 2 * VERIFIED_CHUNK_SIZE)
    || sizes.reduce((sum, size) => sum + size, 0) !== image.archiveSize) {
    throw new Error(`Invalid independent zstd frame sizes for ${image.name}`);
  }
  return [...sizes];
}

/** Independent frames can decode concurrently while one archive download stays sequential. */
async function openVerifiedFrames(image, signal, concurrency) {
  const frameSizes = validateFrameSizes(image.frameSizes, image);
  if (concurrency !== 4 && concurrency !== 8) throw new Error("Expected zstd concurrency 4 or 8");
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const source = await openResource(image.archiveUrl, combined, image.archiveSize);
  const reader = source.getReader();
  const decompress = promisify(zlib.zstdDecompress);
  let cancelled = false;
  let buffer = new Uint8Array();
  let offset = 0;
  let received = 0;
  const pending = [];
  let failure;
  async function frame(length) {
    const bytes = new Uint8Array(length);
    for (let used = 0; used < length;) {
      if (offset === buffer.length) {
        const next = await reader.read();
        if (next.done) throw new Error(`Truncated archive: ${image.name}`);
        if (!(next.value instanceof Uint8Array) || !next.value.length) throw new Error("Invalid archive chunk");
        buffer = next.value;
        offset = 0;
        received += buffer.length;
        if (received > image.archiveSize) throw new Error(`Archive too long: ${image.name}`);
      }
      const count = Math.min(length - used, buffer.length - offset);
      bytes.set(buffer.subarray(offset, offset + count), used);
      used += count;
      offset += count;
    }
    return bytes;
  }
  async function decode(bytes, index) {
    const expected = Math.min(VERIFIED_CHUNK_SIZE, image.fileSize - index * VERIFIED_CHUNK_SIZE);
    const decoded = await decompress(bytes, {
      // One spare byte avoids zlib allocating another output buffer just to discover EOF.
      chunkSize: Math.max(64, expected + 1),
      maxOutputLength: expected,
      params: { [zlib.constants.ZSTD_d_windowLogMax]: 22 },
    });
    if (decoded.length !== expected) throw new Error(`Unexpected decoded frame length: ${image.name} chunk ${index}`);
    const actual = Buffer.from(await webcrypto.subtle.digest("SHA-256", decoded)).toString("hex");
    if (actual !== image.chunkHashes[index]) throw new Error(`SHA-256 mismatch for ${image.name} chunk ${index}`);
    return decoded;
  }
  async function* frames() {
    let index = 0;
    try {
      while (index < frameSizes.length || pending.length) {
        while (index < frameSizes.length && pending.length < concurrency) {
          const bytes = await frame(frameSizes[index]);
          pending.push(decode(bytes, index++).then(value => ({ value }), error => {
            failure ??= error;
            // A later archive read must not hide an already known decode/hash failure.
            controller.abort(error);
            void reader.cancel(error).catch(() => undefined);
            return { error };
          }));
        }
        const result = await pending.shift();
        if (result.error) throw result.error;
        if (!pending.length && index === frameSizes.length) {
          if (offset !== buffer.length || received !== image.archiveSize || !(await reader.read()).done) throw new Error(`Unexpected archive EOF: ${image.name}`);
        }
        if (!cancelled) yield result.value;
      }
    } catch (error) {
      throw failure ?? error;
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await Promise.all(pending);
    }
  }
  const iterator = frames();
  return new ReadableStream({
    async pull(output) {
      try {
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) output.close();
        else output.enqueue(next.value);
      } catch (error) {
        if (!cancelled) output.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      controller.abort(reason);
      await reader.cancel(reason).catch(() => undefined);
      await iterator.return();
      try { reader.releaseLock(); } catch { /* The generator may have released it. */ }
    },
  }, { highWaterMark: 0 });
}

/** Verify each decoded chunk before exposing it. The final chunk also waits for exact EOF. */
export function verifyImageStream(source, image) {
  validateImageHashes(image);
  const reader = source.getReader();
  let cancelled = false;
  async function* verified() {
    let total = 0;
    let index = 0;
    let used = 0;
    let block = new Uint8Array(Math.min(VERIFIED_CHUNK_SIZE, image.fileSize));
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || value.length === 0 || total + value.length > image.fileSize) {
          throw new Error(`Unexpected decoded length for ${image.name}`);
        }
        total += value.length;
        for (let offset = 0; offset < value.length;) {
          const length = Math.min(block.length - used, value.length - offset);
          block.set(value.subarray(offset, offset + length), used);
          used += length;
          offset += length;
          if (used === block.length) {
            const actual = Buffer.from(await webcrypto.subtle.digest("SHA-256", block)).toString("hex");
            if (actual !== image.chunkHashes[index]) throw new Error(`SHA-256 mismatch for ${image.name} chunk ${index}`);
            index++;
            if (index === image.chunkHashes.length) break;
            yield block;
            block = new Uint8Array(Math.min(VERIFIED_CHUNK_SIZE, image.fileSize - index * VERIFIED_CHUNK_SIZE));
            used = 0;
          }
        }
      }
      if (total !== image.fileSize || index !== image.chunkHashes.length) throw new Error(`Truncated decoded image ${image.name}`);
      if (!cancelled) yield block;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const iterator = verified();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason).catch(() => undefined);
      await iterator.return();
      // A generator cancelled before its first pull does not run its finally block.
      try { reader.releaseLock(); } catch { /* Already released by the generator. */ }
    },
  }, { highWaterMark: 0 });
}

/** Read a URL or local file with a hard limit; used only for small metadata and the programmer. */
export async function readResource(url, limit, signal) {
  const stream = await openResource(url, signal);
  const parts = [];
  let size = 0;
  for await (const part of stream) {
    size += part.length;
    if (size > limit) throw new Error(`Resource exceeds ${limit} bytes: ${url}`);
    parts.push(part);
  }
  return Buffer.concat(parts, size);
}

export async function openResource(url, signal, expectedSize = undefined) {
  if (url.protocol === "file:") {
    const path = fileURLToPath(url);
    const info = await stat(path);
    if (!info.isFile() || (expectedSize !== undefined && info.size !== expectedSize)) throw new Error(`Unexpected archive length: ${url}`);
    return Readable.toWeb(createReadStream(path, { highWaterMark: 256 * 1024, signal }), webBuffer);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  const length = response.headers.get("content-length");
  if (expectedSize !== undefined && length !== null && Number(length) !== expectedSize) {
    await response.body.cancel();
    throw new Error(`Unexpected archive length: ${url}`);
  }
  return response.body;
}

/** Bounded native decompression: no archive cache and no whole-image allocation. */
export async function openVerifiedImage(image, signal, concurrency = 8) {
  requireNativeZstd();
  validateImageHashes(image);
  if (image.frameSizes) return openVerifiedFrames(image, signal, concurrency);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let source;
  try {
    source = await openResource(image.archiveUrl, controller.signal, image.archiveSize);
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    throw error;
  }
  async function* compressed() {
    let bytes = 0;
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > image.archiveSize) throw new Error(`Archive too long: ${image.name}`);
      yield chunk;
    }
    if (bytes !== image.archiveSize) throw new Error(`Truncated archive: ${image.name}`);
  }
  const input = Readable.from(compressed(), { objectMode: false, highWaterMark: 256 * 1024 });
  const decoder = zlib.createZstdDecompress({ chunkSize: 256 * 1024 });
  // Observe pipeline rejection immediately; the decoder forwards it to the consumer.
  const completion = pipeline(input, decoder, { signal: controller.signal }).catch(error => {
    decoder.destroy(error);
  });
  const verified = verifyImageStream(Readable.toWeb(decoder, webBuffer), image);
  const reader = verified.getReader();
  let cancelled = false;
  async function finish() {
    controller.abort();
    await completion;
    signal?.removeEventListener("abort", abort);
  }
  return new ReadableStream({
    async pull(output) {
      try {
        const next = await reader.read();
        if (cancelled) return;
        if (next.done) {
          await finish();
          reader.releaseLock();
          output.close();
        } else output.enqueue(next.value);
      } catch (error) {
        await finish();
        if (!cancelled) output.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      controller.abort(reason);
      await reader.cancel(reason).catch(() => undefined);
      reader.releaseLock();
      await finish();
    },
  }, { highWaterMark: 0 });
}
