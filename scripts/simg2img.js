#!/usr/bin/env bun
import * as Sparse from "../src/sparse";

export async function simg2img(inputPath, outputPath) {
  const sparseImage = Bun.file(inputPath);
  const outputImage = Bun.file(outputPath);

  const sparse = await Sparse.from(sparseImage);
  if (!sparse) throw "Failed to parse sparse file";

  const writer = outputImage.writer({ highWaterMark: 4 * 1024 * 1024 });
  for await (const data of sparse.read()) {
    writer.write(data);
  }
  writer.end();
}

if (import.meta.main) {
  if (Bun.argv.length < 4) {
    throw "Usage: simg2img.js <input_path> <output_path>";
  }
  const startTime = performance.now();
  await simg2img(Bun.argv[2], Bun.argv[3]);
  const endTime = performance.now();
  console.info(`Done in ${((endTime - startTime) / 1000).toFixed(3)}s`);
}
