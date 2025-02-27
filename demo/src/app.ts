import { qdlDevice } from "@commaai/qdl";
import { usbClass } from "@commaai/qdl/usblib";

interface PartitionInfo {
  name: string;
  sector: number;
  sectors: number;
  flags: number;
  type: string;
  unique: string;
}

interface GptHeaderInfo {
  crc32: number;
  crc32PartEntries: number;
  firstUsableLba: number;
  lastUsableLba: number;
  currentLba: number;
  backupLba: number;
  partEntryStartLba: number;
  numPartEntries: number;
  partEntrySize: number;
}

interface LunInfo {
  lun: number;
  header: GptHeaderInfo;
  backupHeader: GptHeaderInfo;
  partitions: Record<string, PartitionInfo>;
}

declare global {
  interface Window {
    qdl?: qdlDevice;
    connectDevice: () => Promise<void>
    erasePartition: () => Promise<void>
  }
}

function createCell(textContent: string) {
  const el = document.createElement("td");
  el.textContent = textContent;
  el.style.cssText = 'padding: 8px; border-bottom: 1px solid #ddd;'
  return el;
}

function createObjectTable(element: HTMLElement, data: Record<string, any>) {
  if (!element || !data) return;
  const table = document.createElement("table");
  table.style.cssText = "border-collapse: collapse; width: 100%;";
  for (const [key, value] of Object.entries(data)) {
    const row = document.createElement("tr");
    row.append(createCell(key), createCell(value));
    table.appendChild(row);
  }
  element.innerHTML = "";
  element.appendChild(table);
  return table;
}

window.connectDevice = async () => {
  const programmerSelect = document.getElementById("programmer") as HTMLSelectElement;
  const status = document.getElementById("status");
  const deviceDiv = document.getElementById("device");
  const storageDiv = document.getElementById("storage");
  const partitionsDiv = document.getElementById("partitions");
  const eraseControls = document.querySelector(".erase-controls") as HTMLElement;
  const partitionSelect = document.getElementById("partition-select") as HTMLSelectElement;

  if (!programmerSelect || !status || !deviceDiv || !storageDiv || !partitionsDiv ||
    !eraseControls || !partitionSelect) throw "missing elements";

  try {
    if (!programmerSelect.value) {
      throw new Error("Select a device");
    }

    status.className = "";
    status.textContent = "Connecting...";

    if (!("usb" in navigator)) {
      throw new Error("Browser missing WebUSB support");
    }

    // Initialize QDL device with programmer URL
    const qdl = new qdlDevice(programmerSelect.value);
    window.qdl = qdl;

    // Start the connection
    await qdl.connect(new usbClass());
    status.className = "success";
    status.textContent = "Connected! Reading device info...";

    // Device information
    const activeSlot = await qdl.getActiveSlot();
    const storageInfo = await qdl.getStorageInfo();
    createObjectTable(deviceDiv, {
      "Active Slot": activeSlot,
      "SOC Serial Number": qdl.sahara!.serial,
      "UFS Serial Number": "0x"+storageInfo.serial_num.toString(16).padStart(8, "0"),
    });
    createObjectTable(storageDiv, storageInfo);

    // Get GPT info for each LUN
    const lunInfos: LunInfo[] = [];
    const partitionNames = new Set<string>();

    for (const lun of qdl.firehose!.luns) {
      const [guidGpt] = await qdl.getGpt(lun);
      if (guidGpt?.header) {
        const [backupGuidGpt] = await qdl.getGpt(lun, guidGpt.header.backupLba);
        lunInfos.push({
          lun,
          header: {
            crc32: guidGpt.header.crc32,
            crc32PartEntries: guidGpt.header.crc32PartEntries,
            firstUsableLba: guidGpt.header.firstUsableLba,
            lastUsableLba: guidGpt.header.lastUsableLba,
            currentLba: guidGpt.header.currentLba,
            backupLba: guidGpt.header.backupLba,
            partEntryStartLba: guidGpt.header.partEntryStartLba,
            numPartEntries: guidGpt.header.numPartEntries,
            partEntrySize: guidGpt.header.partEntrySize
          },
          backupHeader: backupGuidGpt?.header ? {
            crc32: backupGuidGpt.header.crc32,
            crc32PartEntries: backupGuidGpt.header.crc32PartEntries,
            firstUsableLba: backupGuidGpt.header.firstUsableLba,
            lastUsableLba: backupGuidGpt.header.lastUsableLba,
            currentLba: backupGuidGpt.header.currentLba,
            backupLba: backupGuidGpt.header.backupLba,
            partEntryStartLba: backupGuidGpt.header.partEntryStartLba,
            numPartEntries: backupGuidGpt.header.numPartEntries,
            partEntrySize: backupGuidGpt.header.partEntrySize
          } : null as any,
          partitions: guidGpt.partentries
        });

        // Add partition names to the set
        for (const partName in guidGpt.partentries) {
          partitionNames.add(partName);
        }
      }
    }

    // Partition table
    partitionsDiv.innerHTML = "";
    for (const lunInfo of lunInfos) {
      const lunTitle = document.createElement("h3");
      lunTitle.textContent = `LUN ${lunInfo.lun}`;
      lunTitle.className = "text-xl font-bold mt-4 mb-2";
      partitionsDiv.appendChild(lunTitle);

      const headerInfo = document.createElement("div");
      headerInfo.className = "mb-4 space-y-4";

      const headerTypes: [string, GptHeaderInfo][] = [
        ['Primary', lunInfo.header],
        ['Backup', lunInfo.backupHeader],
      ];

      for (const [type, header] of headerTypes) {
        if (!header) continue;

        const headerTitle = document.createElement("h4");
        headerTitle.textContent = `${type} GPT Header`;
        headerTitle.className = "text-lg font-semibold mt-2";
        headerInfo.appendChild(headerTitle);

        const headerTable = document.createElement("table");
        headerTable.className = "w-full border-collapse text-sm";

        const headerFields = [
          ['Header CRC32', '0x' + header.crc32.toString(16).padStart(8, '0')],
          ['Partition Entries CRC32', '0x' + header.crc32PartEntries.toString(16).padStart(8, '0')],
          ['Current LBA', header.currentLba.toString()],
          ['Backup LBA', header.backupLba.toString()],
          ['First Usable LBA', header.firstUsableLba.toString()],
          ['Last Usable LBA', header.lastUsableLba.toString()],
          ['Partition Entry Start LBA', header.partEntryStartLba.toString()],
          ['Number of Partition Entries', header.numPartEntries.toString()],
          ['Partition Entry Size', header.partEntrySize.toString()]
        ];

        for (const [label, value] of headerFields) {
          const row = headerTable.insertRow();
          row.className = "hover:bg-gray-50 dark:hover:bg-gray-800";

          const labelCell = row.insertCell();
          labelCell.textContent = label;
          labelCell.className = "p-2 border w-1/3 font-medium";

          const valueCell = row.insertCell();
          valueCell.textContent = value;
          valueCell.className = "p-2 border font-mono";
        }

        headerInfo.appendChild(headerTable);
      }

      partitionsDiv.appendChild(headerInfo);

      const table = document.createElement("table");
      table.className = "w-full border-collapse";

      const thead = table.createTHead();
      const headerRow = thead.insertRow();
      const headerCols = ["Partition", "Start Sector", "Size (sectors)", "Type", "Flags", "UUID"];
      for (const text of headerCols) {
        const th = document.createElement("th");
        th.textContent = text;
        th.className = "text-left p-2 border bg-gray-100 dark:bg-gray-700";
        headerRow.appendChild(th);
      }

      const tbody = table.createTBody();
      for (const [name, info] of Object.entries(lunInfo.partitions)) {
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

    // Populate the partition dropdown
    partitionSelect.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "-- Select a partition --";
    partitionSelect.appendChild(defaultOption);

    // Add all partition names to the dropdown
    for (const partName of partitionNames) {
      // Don't add persist to the dropdown
      if (partName === "persist") continue;
      const option = document.createElement("option");
      option.value = partName;
      option.textContent = partName;
      partitionSelect.appendChild(option);
    }

    // Show erase controls
    eraseControls.style.display = "block";

    status.textContent = "Successfully read device information!";
  } catch (error) {
    console.error("Error:", error);
    status.className = "error";
    status.textContent = `Error: ${error instanceof Error ? error.message : error}`;
  }
};

window.erasePartition = async () => {
  const qdl = window.qdl;
  const partitionSelect = document.getElementById("partition-select") as HTMLSelectElement;
  const status = document.getElementById("status");

  if (!partitionSelect || !status) throw "missing elements";
  if (!qdl) throw "device not connected";

  if (!partitionSelect.value) {
    status.className = "error";
    status.textContent = "Error: Please select a partition to erase";
    return;
  }

  try {
    const partitionName = partitionSelect.value;
    status.className = "";
    status.textContent = `Erasing partition ${partitionName}...`;

    const startTime = performance.now();

    await qdl.erase(partitionName);

    const elapsedTime = ((performance.now() - startTime) / 1000).toFixed(2);

    status.className = "success";
    status.textContent = `Successfully erased ${partitionName} (took ${elapsedTime} seconds)`;
  } catch (error) {
    console.error("Erase error:", error);
    status.className = "error";
    status.textContent = `Error while erasing: ${error instanceof Error ? error.message : error}`;
  }
};
