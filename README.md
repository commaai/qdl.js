# qdl.js

## Development

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

## Linux instructions

On Linux systems, the Qualcomm device in QDL mode is automatically bound to the kernel's qcserial driver, which needs to
be unbound before we can access the device.

```sh
# List all devices currently bound to qcserial
ls -l /sys/bus/usb/drivers/qcserial/ | grep '^l'
```

```sh
# Unbind any devices from the qcserial driver
for d in /sys/bus/usb/drivers/qcserial/*-*; do [ -e "$d" ] && echo -n "$(basename $d)" | sudo tee /sys/bus/usb/drivers/qcserial/unbind > /dev/null; done
```

After running the unbind command, verify no devices are bound to qcserial by running the first command again.
