import { qdlDevice } from "@commaai/qdl";

declare global {
  interface Window {
    connectDevice: () => Promise<void>
  }
}

window.connectDevice = async () => {
  const status = document.getElementById("status");
  const output = document.getElementById("output");
  if (!status || !output) throw "missing elements";

  try {
    status.className = "";
    status.textContent = "Connecting...";

    if (!("usb" in navigator)) {
      throw new Error("Browser missing WebUSB support");
    }

    // Initialize QDL device with programmer URL
    const qdl = new qdlDevice("https://raw.githubusercontent.com/commaai/flash/master/src/QDL/programmer.bin");

    // Wait for connection
    qdl.waitForConnect().then(() => {
      console.log("Device connected successfully");
      status.className = "success";
      status.textContent = "Connected! Reading device info...";

      // Get partition information
      return qdl.getDevicePartitionsInfo();
    }).then(([slotCount, partitions]) => {
      console.log("Slot count:", slotCount);
      console.log("Partitions:", partitions);

      output.textContent = "Device Information:\n\n" +
        `Slot Count: ${slotCount}\n` +
        `Serial Number: ${qdl.sahara.serial}\n\n` +
        "Partitions:\n" + JSON.stringify(partitions, null, 2);

      status.textContent = "Successfully read device information!";
    });

    // Start connection process
    await qdl.connect();
  } catch (error) {
    console.error("Error:", error);
    status.className = "error";
    status.textContent = `Error: ${error instanceof Error ? error.message : error}`;
  }
};
