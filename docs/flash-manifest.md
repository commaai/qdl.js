# Full comma four flash

Use Node.js 22.23.2 or newer with native zstd support; tested on Linux x86-64 and ARM64 with Node 22.23.2. Install the package dependencies and provide a comma four programmer advertising native sparse writes. Bun's zstd implementation is not used by this command.

```sh
qdl-flash-manifest \
  --manifest /path/to/all-partitions.json \
  --programmer /path/to/programmer.elf \
  --programmer-sha256 EXPECTED_SHA256
```

The manifest and programmer accept local paths or HTTP(S) URLs. Relative archive URLs resolve against the manifest location. The command uses a merged full manifest; each entry may contain a `flash` companion that overrides the original XZ metadata. Every selected image requires `zstd_url`, `archive_size`, `file_size`, `hash`, `chunk_size: 4194304`, and `chunk_hashes`. Partition images also require the sparse `stream` index produced by the flash image packager. XZ-only manifests fail before GPT repair or erase.

The CLI checks the UFS model and capacity, verifies all six GPT images, and validates image destinations before modifying storage. It repairs the GPTs, erases all six LUNs while retaining GPT/MBR and `persist`, writes slot A and shared partitions, activates A, and resets. Pass `--slot b` to write and activate B instead; the other slot is erased but not programmed. The modem image always goes to `modem_a`, because AGNOS mounts that partition for either root slot; exactly one modem copy is written. The API accepts `flashManifest(device, manifest, url, { slot: "b" })`. It selects `userdata_89` or `userdata_90` for supported WDC and Samsung storage. `persist` is never flashed. Blank or corrupt existing GPTs are recovered from the verified manifest before checking the repaired `persist` location and erasing.

Existing DDR calibration is retained only when the validated old and supplied GPTs agree on its fixed LUN3/start64/type and at least the first 1 MiB. An existing partition expanded by GPT repair is accepted within validated usable bounds. The repaired geometry is checked again before erasing. Invalid calibration layout disables preservation; USB read errors stop the flash.

Archives stream through native zstd without an intermediate file or cache. Each decoded 4 MiB chunk must match its SHA-256 before it reaches USB. Ordered chunk hashes and exact lengths verify the whole source; the final chunk waits for EOF. Compressed and decoded lengths are checked. Source queues use byte limits; memory usage does not grow with image size. To reuse downloads, keep the compressed archives locally and reference them from a local manifest.

Optional `zstd_chunked_url`, `zstd_chunked_size`, and `zstd_frame_sizes` select a concatenated archive of independent zstd frames. Each frame corresponds to one decoded chunk and its existing hash. The CLI queues up to eight frames on Node's default four worker threads, preserving output order and limiting each frame's output and decoder window to 4 MiB. This archive may be larger than the solid archive, but avoids serial decompression on slower CPUs. Without these fields, the CLI uses the solid archive. Six small GPT downloads run concurrently; up to four partition sources open ahead of the current write.

An optional `flash.lz4` companion lets a capable programmer decode LZ4 on the device. The companion has its own source hash, lengths, chunk hashes and zstd archive fields, plus a target `stream` index with `compressed_bytes` and `first_frame_bytes`. The CLI requires matching logical size and `hash_raw`, and validates that its target extents cover every raw sparse extent and verifies each encoded wire chunk before USB. If the programmer lacks LZ4 support, it uses the raw sparse companion. The LZ4 path retains the same bounded streaming and failure cleanup. After GPT repair and calibration checks, it uses a 128 MiB prefetch buffer for each of the verified system and userdata wire streams while erase and smaller writes run. Samsung devices prefetch only userdata because their system writes are limited by storage throughput. Decoder and USB queues add bounded overhead. This hides source jitter without allocating a complete image. Pass `--prefetch-mib 0` to disable it, or choose 4–256 MiB per image; the API option is `prefetchBytes`.

Pass `--decode-concurrency 4` to reduce queued frames. To compare more worker threads, set `UV_THREADPOOL_SIZE=8` before starting Node. Four workers with eight queued frames were fastest on the rack stations; more threads can contend with USB processing.

The command writes JSON timings for manifest/programmer fetch, connection, metadata and calibration checks, erase, each write, activation, reset and cleanup. The factory `complete` event includes source cleanup; its named stages plus `host_overhead` sum to that duration. The CLI `command` event also includes fetching, connecting and closing USB. Prefetch runs concurrently with later phases, so its worker CPU time must not be added again to wall time. These timings end after reset; usable Linux boot is a separate measurement. If a download, hash, USB transfer, or signal interrupts the flash, the command closes USB and does not proceed to activation or reset. Power-cycle back into QDL before retrying.

Run the native source and full-flow tests with:

```sh
node --test test/manifest-flash.test.mjs
```
