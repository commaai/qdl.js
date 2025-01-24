import { qdlDevice } from "@commaai/qdl";

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
