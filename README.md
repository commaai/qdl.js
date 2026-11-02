# qdl.js

## Development

```sh
bun install

# to add scripts like `qdl.js` and `simg2img.js` to your path
bun link
```

**Test**

Run tests in watch mode

```sh
bun test --watch
```

**Lint**

Check for linting problems

```sh
bun lint
```

You can also install the Biome extension for VS Code, Zed and IntelliJ-based editors.

**Build**

Bundles JS and generates type declarations

```sh
bun run build
```

## Flashing images

For a full factory flash, use the [native Node.js manifest CLI](docs/flash-manifest.md).

`device.flashBlob("system_a", image)` writes one partition. The full-manifest CLI selects slot A by default; pass `--slot b` to select slot B.

For downloads verified in chunks, `device.canFlashStream(extentCount)` checks native support. `device.flashStream(name, metadata, stream, onProgress, erase)` accepts a packed sparse payload and metadata containing `sectorSize`, `numPartitionSectors`, `dataSectors`, and `extents`. Verify each source chunk before enqueueing it; `selectSparseRanges` from `@commaai/qdl/sparse-stream` selects the packed payload from a verified sparse file stream. Source errors close USB and require a device power cycle before retrying.

Programmers advertising LZ4 support also accept `device.flashLz4Stream(name, metadata, stream, onProgress, erase)`. Check `device.canFlashLz4Stream(extentCount)` before choosing a compressed companion. Its metadata adds `compressedBytes` and `firstFrameBytes`; its stream contains authenticated LZ4 wire frames, in chunks no larger than 4 MiB. `validateLz4Metadata` from `@commaai/qdl/lz4-stream` validates the index before flashing. Both streaming APIs report progress in logical image bytes and validate the complete source before submitting the final payload.

## Logging

qdl.js includes a configurable logging system that allows you to control the verbosity of log messages. The following log levels are available, in order of increasing verbosity:

- `silent`: No log messages
- `error`: Only error messages
- `warn`: Error and warning messages
- `info`: Error, warning, and informational messages (default)
- `debug`: All messages, including detailed debug information

You can set the log level using the `--log-level` or `-l` flash when running qdl.js, or by setting the `QDL_LOG_LEVEL`
environment variable.

## Linux instructions

### Web

On Linux systems, the Qualcomm device in QDL mode is automatically bound to the kernel's qcserial driver, which needs to
be unbound before the browser can access the device. This doesn't appear to be necessary in other environments like
Node.js and Bun.

```sh
# List all devices currently bound to qcserial
ls -l /sys/bus/usb/drivers/qcserial/ | grep '^l'
```

```sh
# Unbind any devices from the qcserial driver
for d in /sys/bus/usb/drivers/qcserial/*-*; do [ -e "$d" ] && echo -n "$(basename $d)" | sudo tee /sys/bus/usb/drivers/qcserial/unbind > /dev/null; done
```

After running the unbind command, verify no devices are bound to qcserial by running the first command again.

### Desktop

To fix USB permissions, create a file at `/etc/udev/rules.d/99-qualcomm-edl.rules` containing the following udev rules:
```
SUBSYSTEM=="usb", ATTR{idVendor}=="05c6", ATTR{idProduct}=="9008", MODE="0666"
SUBSYSTEM=="usb", ATTR{idVendor}=="3801", ATTR{idProduct}=="9008", MODE="0666"
```

For your udev rule changes to take effect, reboot or run:
```
sudo udevadm trigger --attr-match=subsystem=usb
```
