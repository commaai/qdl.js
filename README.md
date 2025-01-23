# qdl.js

## Development

**Test**

Run tests in watch mode

```sh
bun test --watch
```

**Build**

Bundles JS and generates type declarations

```sh
bun run build
```

## Linux instructions

```sh
# List all devices currently bound to qcserial
ls -l /sys/bus/usb/drivers/qcserial/ | grep '^l'
```

```sh
# Unbind any devices from the qcserial driver
for d in /sys/bus/usb/drivers/qcserial/*-*; do [ -e "$d" ] && echo -n "$(basename $d)" | sudo tee /sys/bus/usb/drivers/qcserial/unbind > /dev/null; done
```
