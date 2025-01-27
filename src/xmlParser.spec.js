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

    // TODO: unclear whether this scenario occurs
    test.skip("parse multiple response documents", () => {
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
      const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: Calling handler for getstorageinfo" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: Device Total Logical Blocks: 0xd7d800" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: Device Total Physical Partitions: 0x6" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: Device Manufacturer ID: 0x1ad" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: Device Serial Number: 0xe22af7f8" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: {&quot;storage_info&quot;: {&quot;total_blocks&quot;:14145536, &quot;block_size&quot;:4096, &quot;page_size&quot;:4096, &quot;num_physical&quot;:6, &quot;manufacturer_id&quot;:429, &quot;serial_num&quot;:3794466808, &quot;fw_version&quot;:&quot;205&quot;,&quot;mem_type&quot;:&quot;UFS&quot;,&quot;prod_name&quot;:&quot;H28S7Q302BMR&quot;}}" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: UFS fInitialized: 0x1" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: UFS Current LUN Number: = 0x0" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: UFS Total Active LU: 0x6" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: UFS Boot Partition Enabled: 0x1" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: UFS Raw Device Capacity: = 0x7738000" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: UFS Min Block Size: 0x8" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: UFS Erase Block Size: 0x2000" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: UFS Allocation Unit Size: 0x1" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: UFS RPMB ReadWrite Size: = 0x20" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: UFS Number of Allocation Uint for This LU: 0x35f6" /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<log value="INFO: UFS Inquiry Command Output: SKhynix H28S7Q302BMR    H205 " /></data><?xml version="1.0" encoding="UTF-8" ?>
<data>
<response value="ACK" rawmode="false" /></data>`;
      const response = parser.getResponse(encoder.encode(xml));
      expect(response).toMatchInlineSnapshot(`
{
  "rawmode": "false",
  "value": "ACK",
}
`);
      const logs = parser.getLog(encoder.encode(xml));
      expect(logs).toMatchInlineSnapshot(`
[
  "INFO: Calling handler for getstorageinfo",
  "INFO: Device Total Logical Blocks: 0xd7d800",
  "INFO: Device Total Physical Partitions: 0x6",
  "INFO: Device Manufacturer ID: 0x1ad",
  "INFO: Device Serial Number: 0xe22af7f8",
  "INFO: {"storage_info": {"total_blocks":14145536, "block_size":4096, "page_size":4096, "num_physical":6, "manufacturer_id":429, "serial_num":3794466808, "fw_version":"205","mem_type":"UFS","prod_name":"H28S7Q302BMR"}}",
  "INFO: UFS fInitialized: 0x1",
  "INFO: UFS Current LUN Number: = 0x0",
  "INFO: UFS Total Active LU: 0x6",
  "INFO: UFS Boot Partition Enabled: 0x1",
  "INFO: UFS Raw Device Capacity: = 0x7738000",
  "INFO: UFS Min Block Size: 0x8",
  "INFO: UFS Erase Block Size: 0x2000",
  "INFO: UFS Allocation Unit Size: 0x1",
  "INFO: UFS RPMB ReadWrite Size: = 0x20",
  "INFO: UFS Number of Allocation Uint for This LU: 0x35f6",
  "INFO: UFS Inquiry Command Output: SKhynix H28S7Q302BMR    H205 ",
]
`);
    });
  });
});
