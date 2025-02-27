const build = await Bun.build({
  entrypoints: ["./src/index.html"],
  outdir: "./dist",
  sourcemap: "linked",
  // https://github.com/oven-sh/bun/issues/16335
  // minify: true,
});

const outputs = build.outputs.map(({ path, kind, size }) => ({ path, kind, "size (KiB)": (size / 1024).toFixed(1) }));
console.info("Build outputs:");
console.table(outputs);

const totalSize = outputs.reduce((acc, output) => output.kind === "sourcemap" ? acc : Number(output["size (KiB)"]) + acc, 0);
console.info("Total asset size excluding sourcemaps (KiB):", totalSize.toFixed(1));
