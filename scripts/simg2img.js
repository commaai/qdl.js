import { Sparse } from "../src/sparse";

export async function simg2img(inputPath, outputPath) {
  const sparseImage = Bun.file(inputPath);
  const outputImage = Bun.file(outputPath);

  const sparse = await Sparse.from(sparseImage);
  if (!sparse) throw "Failed to parse sparse file";

  const writer = outputImage.writer({ highWaterMark: 4 * 1024 * 1024 });
  const size = await sparse.getSize();
  let prevOffset = 0;
  for await (const [offset, chunk] of sparse.read()) {
    if (prevOffset < offset) {
      writer.write(new Uint8Array(offset - prevOffset).buffer);
    }
    writer.write(await chunk.arrayBuffer());
    prevOffset = offset + chunk.size;
  }
  if (prevOffset < size) {
    writer.write(new Uint8Array(size - prevOffset).buffer);
  }
  writer.end();
}

if (import.meta.main) {
  if (Bun.argv.length < 4) {
    throw "Usage: bun simg2img.js <input-path> <output-path>";
  }
  const startTime = performance.now();
  await simg2img(Bun.argv[2], Bun.argv[3]);
  const endTime = performance.now();
  console.info(`Done in ${((endTime - startTime) / 1000).toFixed(3)}s`);
}
