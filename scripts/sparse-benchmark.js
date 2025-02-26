import * as Sparse from "../src/sparse";

if (Bun.argv.length < 3) {
  throw "Usage: bun sparse-benchmark.js <sparse.img> [expected-raw.img]";
}

const sparseImage = Bun.file(Bun.argv[2]);
const expectedRawImage = Bun.argv[3] ? Bun.file(Bun.argv[3]) : null;

const sparse = await Sparse.from(sparseImage);
if (!sparse) throw "Failed to parse sparse file";

let offset = 0;
const startTime = performance.now();
for await (const blob of sparse.chunks()) {
  if (expectedRawImage) {
    const receivedChunkBuffer = Buffer.from(new Uint8Array(await blob.arrayBuffer()));
    const [start, end] = [offset, offset + blob.size];
    const expectedSlice = expectedRawImage.slice(start, end);
    const expectedChunkBuffer = Buffer.from(new Uint8Array(await expectedSlice.arrayBuffer()));
    const result = receivedChunkBuffer.compare(expectedChunkBuffer);
    if (result) {
      console.debug("Expected:", expectedChunkBuffer.toString("hex"));
      console.debug("Received:", receivedChunkBuffer.toString("hex"));
      throw `range ${start} to ${end} differs`;
    }
  }
  offset += blob.size;
}
const endTime = performance.now();
if (expectedRawImage && offset !== expectedRawImage.size) {
  throw "size mismatch";
}

console.info(`Done in ${((endTime - startTime) / 1000).toFixed(3)}s`);
