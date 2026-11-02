# Full comma four flash

Use Node.js 22.23.2 or newer with native zstd support; tested on Linux x86-64 and ARM64 with Node 22.23.2. Install the package dependencies and provide a comma four programmer advertising native sparse writes and two destinations. Bun's zstd implementation is not used by this command.

```sh
qdl-flash-manifest \
  --manifest /path/to/all-partitions.json \
  --programmer /path/to/programmer.elf \
  --programmer-sha256 EXPECTED_SHA256
```

The manifest and programmer accept local paths or HTTP(S) URLs. Relative archive URLs resolve against the manifest location. The command uses a merged full manifest; each entry may contain a `flash` companion that overrides the original XZ metadata. Every selected image requires `zstd_url`, `archive_size`, `file_size`, `hash`, `chunk_size: 4194304`, and `chunk_hashes`. Partition images also require the sparse `stream` index produced by the flash image packager. XZ-only manifests fail before GPT repair or erase.

The CLI checks the UFS model and capacity, verifies all six GPT images, and validates image destinations before modifying storage. It repairs the GPTs, erases all six LUNs while retaining GPT/MBR and `persist`, writes both slots explicitly, selects slot A, and resets. It selects `userdata_89` or `userdata_90` for supported WDC and Samsung storage. `persist` is never flashed.

Archives stream through native zstd without an intermediate file or cache. Each decoded 4 MiB chunk must match its SHA-256 before it reaches USB. Ordered chunk hashes and exact lengths verify the whole source; the final chunk waits for EOF. Compressed and decoded lengths are checked. Source queues use byte limits; memory usage does not grow with image size. To reuse downloads, keep the compressed archives locally and reference them from a local manifest.

Optional `zstd_chunked_url`, `zstd_chunked_size`, and `zstd_frame_sizes` select a concatenated archive of independent zstd frames. Each frame corresponds to one decoded chunk and its existing hash. The CLI decodes up to four frames concurrently, preserving output order and limiting each frame's output and decoder window to 4 MiB. This archive may be larger than the solid archive, but avoids serial decompression on slower CPUs. Without these fields, the CLI uses the solid archive. Six small GPT downloads run concurrently; up to four partition sources open ahead of the current write.

For an eight-thread comparison, set `UV_THREADPOOL_SIZE=8` before starting Node and pass `--decode-concurrency 8`. The default is four. More threads can contend with USB processing and are not necessarily faster.

The command writes one JSON timing event per phase. If a download, hash, USB transfer, or signal interrupts the flash, the command closes USB and does not proceed to activation or reset. Power-cycle back into QDL before retrying.

Run the native source and full-flow tests with:

```sh
node --test test/manifest-flash.test.mjs
```
