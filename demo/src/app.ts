import { qdlDevice } from "@commaai/qdl";

interface PartitionInfo {
  name: string;
  sector: number;
  sectors: number;
  flags: number;
  type: string;
  unique: string;
}

interface LunInfo {
  lun: number;
  partitions: Record<string, PartitionInfo>;
}

declare global {
  interface Window {
    connectDevice: () => Promise<void>
  }
}

window.connectDevice = async () => {
  const status = document.getElementById("status");
  const deviceDiv = document.getElementById("device");
  const partitionsDiv = document.getElementById("partitions");
  if (!status || !deviceDiv || !partitionsDiv) throw "missing elements";

  try {
    status.className = "";
    status.textContent = "Connecting...";

    if (!("usb" in navigator)) {
      throw new Error("Browser missing WebUSB support");
    }

    // Initialize QDL device with programmer URL
    const qdl = new qdlDevice("https://raw.githubusercontent.com/commaai/flash/master/src/QDL/programmer.bin");

    // Wait for connection
    qdl.waitForConnect().then(async () => {
      console.log("Device connected successfully");
      status.className = "success";
      status.textContent = "Connected! Reading device info...";

      // Device information
      const activeSlot = await qdl.getActiveSlot();

      deviceDiv.innerHTML = `Serial Number: <code>${qdl.sahara.serial}</code><br>` +
        `Active Slot: <code>${activeSlot}</code>`;

      // Get GPT info for each LUN
      const lunInfos: LunInfo[] = [];
      for (const lun of qdl.firehose.luns) {
        const [guidGpt] = await qdl.getGpt(lun);
        if (guidGpt) lunInfos.push({
          lun,
          partitions: guidGpt.partentries
        });
      }

      // Partition table
      partitionsDiv.innerHTML = "";
      for (const lunInfo of lunInfos) {
        const lunTitle = document.createElement("h3");
        lunTitle.textContent = `LUN ${lunInfo.lun}`;
        lunTitle.className = "text-xl font-bold mt-4 mb-2";
        partitionsDiv.appendChild(lunTitle);

        const table = document.createElement("table");
        table.className = "w-full border-collapse";

        const thead = table.createTHead();
        const headerRow = thead.insertRow();
        for (const text of ["Partition", "Start Sector", "Size (sectors)", "Type", "Flags", "UUID"]) {
          const th = document.createElement("th");
          th.textContent = text;
          th.className = "text-left p-2 border bg-gray-100 dark:bg-gray-700";
          headerRow.appendChild(th);
        }

        const tbody = table.createTBody();
        for (const [name, info] of lunInfo.partitions) {
          const row = tbody.insertRow();
          row.className = "hover:bg-gray-50 dark:hover:bg-gray-800";

          const nameCell = row.insertCell();
          nameCell.textContent = name;
          nameCell.className = "p-2 border";

          const startCell = row.insertCell();
          startCell.textContent = info.sector.toString();
          startCell.className = "p-2 border font-mono";

          const sizeCell = row.insertCell();
          sizeCell.textContent = info.sectors.toString();
          sizeCell.className = "p-2 border font-mono";

          const typeCell = row.insertCell();
          typeCell.textContent = info.type;
          typeCell.className = "p-2 border";

          const flagsCell = row.insertCell();
          flagsCell.textContent = "0x" + info.flags.toString(16);
          flagsCell.className = "p-2 border font-mono";

          const uuidCell = row.insertCell();
          uuidCell.textContent = info.unique.replace(/\s+/g, '');
          uuidCell.className = "p-2 border font-mono text-sm";
        }
        partitionsDiv.appendChild(table);
      }

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
