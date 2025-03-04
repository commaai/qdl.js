import { Sparse } from "../src/sparse";

if (Bun.argv.length < 4) {
  throw "Usage: bun sparse-benchmark.js <input-path> <output-path>";
}

const sparseImage = Bun.file(Bun.argv[2]);
const outputImage = Bun.file(Bun.argv[3]);

const sparse = await Sparse.from(sparseImage);
if (!sparse) throw "Failed to parse sparse file";

const startTime = performance.now();
const writer = outputImage.writer({ highWaterMark: 4 * 1024 * 1024 });
const size = await sparse.getSize();
let prevOffset = 0;
for await (const [offset, chunk] of sparse.read()) {
  if (prevOffset < offset) {
    console.debug(`filling gap of ${offset - prevOffset} bytes at offset ${prevOffset}`);
    writer.write(new Uint8Array(offset - prevOffset).buffer);
  }
  console.debug(`writing ${chunk.size} bytes at offset ${offset}`);
  writer.write(await chunk.arrayBuffer());
  prevOffset = offset + chunk.size;
}
if (prevOffset < size) {
  console.debug(`filling trailing gap of ${size - prevOffset} bytes at offset ${prevOffset}`);
  writer.write(new Uint8Array(size - prevOffset).buffer);
}
const endTime = performance.now();

console.info(`Done in ${((endTime - startTime) / 1000).toFixed(3)}s`);
