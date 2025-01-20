import { describe, expect, test } from "bun:test";

import { xmlParser } from "./xmlParser";


describe("xmlParser", () => {
  const parser = new xmlParser();
  const encoder = new TextEncoder();

  describe("getResponse", () => {
    test("parse a simple response", () => {
      const xml = "<?xml version=\"1.0\" ?><data><response value=\"ACK\"/></data>";
      const result = parser.getResponse(encoder.encode(xml));
      expect(result).toEqual({ value: "ACK" });
    });

    test("parse configure command response", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8" ?>
        <data>
          <response value="ACK"
                   MemoryName="eMMC"
                   Verbose="0"
                   AlwaysValidate="0"
                   MaxDigestTableSizeInBytes="2048"
                   MaxPayloadSizeToTargetInBytes="1048576"
                   ZLPAwareHost="1"
                   SkipStorageInit="0"
                   SkipWrite="0"/>
        </data>`;
      const result = parser.getResponse(encoder.encode(xml));
      expect(result).toEqual({
        value: "ACK",
        MemoryName: "eMMC",
        Verbose: "0",
        AlwaysValidate: "0",
        MaxDigestTableSizeInBytes: "2048",
        MaxPayloadSizeToTargetInBytes: "1048576",
        ZLPAwareHost: "1",
        SkipStorageInit: "0",
        SkipWrite: "0",
      });
    });

    test("parse program command response", () => {
      const xml = `<?xml version="1.0" ?>
        <data>
          <response value="ACK"
                   SECTOR_SIZE_IN_BYTES="512"
                   num_partition_sectors="1000"
                   physical_partition_number="0"
                   start_sector="0"/>
        </data>`;
      const result = parser.getResponse(encoder.encode(xml));
      expect(result).toEqual({
        value: "ACK",
        SECTOR_SIZE_IN_BYTES: "512",
        num_partition_sectors: "1000",
        physical_partition_number: "0",
        start_sector: "0",
      });
    });

    test("parse multiple response documents", () => {
      const xml = `<?xml version="1.0" ?><data><response value="ACK"/></data>
                  <?xml version="1.0" ?><data><response value="DONE"/></data>`;
      const result = parser.getResponse(encoder.encode(xml));
      expect(result).toEqual({ value: "DONE" }); // Should contain last response
    });

    test("parse error response", () => {
      const xml = `<?xml version="1.0" ?>
        <data>
          <response value="NAK"
                   error_code="0x12"
                   error="Invalid sector size"/>
        </data>`;
      const result = parser.getResponse(encoder.encode(xml));
      expect(result).toEqual({
        value: "NAK",
        error_code: "0x12",
        error: "Invalid sector size",
      });
    });

    test("handle malformed XML", () => {
      const xml = "<?xml version=\"1.0\" ?><data><unclosed>";
      const result = parser.getResponse(encoder.encode(xml));
      expect(result).toEqual({});
    });

    test("handle special byte sequence", () => {
      const xml = Buffer.from("<?xml version=\"1.0\" ?>\xf0\xe9\x88\x14<data><response value=\"ACK\"/></data>", "binary");
      const result = parser.getResponse(xml);
      expect(result).toEqual({ value: "ACK" });
    });
  });

  describe("getLog", () => {
    test("parse a simple log", () => {
      const xml = "<?xml version=\"1.0\" ?><data><log value=\"Test message\"/></data>";
      const result = parser.getLog(encoder.encode(xml));
      expect(result).toEqual(["Test message"]);
    });

    test("parse multiple logs", () => {
      const xml = `<?xml version="1.0" ?>
        <data>
          <log value="Message 1"/>
          <log value="Message 2"/>
          <log value="Message 3"/>
        </data>`;
      const result = parser.getLog(encoder.encode(xml));
      expect(result).toEqual([
        "Message 1",
        "Message 2",
        "Message 3",
      ]);
    });

    test("parse program operation logs", () => {
      const xml = `<?xml version="1.0" ?>
        <data>
          <log value="Writing sector 0x1000"/>
          <log value="CRC check passed"/>
          <response value="ACK"/>
        </data>`;
      const result = parser.getLog(encoder.encode(xml));
      expect(result).toEqual([
        "Writing sector 0x1000",
        "CRC check passed",
      ]);
    });

    test("parse logs with special characters", () => {
      const xml = "<?xml version=\"1.0\" ?><data><log value=\"Test &amp; debug &lt;sample&gt;\"/></data>";
      const result = parser.getLog(encoder.encode(xml));
      expect(result).toEqual(["Test & debug <sample>"]);
    });

    test("handle mixed response and log content", () => {
      const xml = `<?xml version="1.0" ?>
        <data>
          <response value="ACK" status="progress"/>
          <log value="Operation in progress"/>
          <log value="Step 1 complete"/>
        </data>`;
      const logs = parser.getLog(encoder.encode(xml));
      expect(logs).toEqual([
        "Operation in progress",
        "Step 1 complete",
      ]);
    });

    test("handle empty value", () => {
      const xml = "<?xml version=\"1.0\" ?><data><log value=\"\"/></data>";
      const result = parser.getLog(encoder.encode(xml));
      expect(result).toEqual([""]);
    });
  });

  describe("Real world protocol examples", () => {
    test("parse power command response", () => {
      const xml = "<?xml version=\"1.0\" ?><data><response value=\"ACK\" command=\"power\" status=\"reset\"/></data>";
      const result = parser.getResponse(encoder.encode(xml));
      expect(result).toEqual({
        value: "ACK",
        command: "power",
        status: "reset",
      });
    });

    test("parse read command response", () => {
      const xml = `<?xml version="1.0" ?>
        <data>
          <response value="ACK"
                   SECTOR_SIZE_IN_BYTES="512"
                   num_partition_sectors="1000"
                   physical_partition_number="0"
                   start_sector="0"/>
        </data>`;
      const result = parser.getResponse(encoder.encode(xml));
      expect(result).toEqual({
        value: "ACK",
        SECTOR_SIZE_IN_BYTES: "512",
        num_partition_sectors: "1000",
        physical_partition_number: "0",
        start_sector: "0",
      });
    });

    test("parse storage info response", () => {
      const xml = `<?xml version="1.0" ?>
        <data>
          <response value="ACK"/>
          <log value="UFS Inquiry Command Output: Unipro"/>
          <log value="UFS Total Active LU: 0x3"/>
          <log value="UFS Boot Partition Enabled: 0x1"/>
          <log value="UFS Total Active LU: 0x3"/>
        </data>`;
      const logs = parser.getLog(encoder.encode(xml));
      expect(logs).toEqual([
        "UFS Inquiry Command Output: Unipro",
        "UFS Total Active LU: 0x3",
        "UFS Boot Partition Enabled: 0x1",
        "UFS Total Active LU: 0x3",
      ]);
    });
  });
});
