import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { qdlDevice } from "../src/qdl.js";

test("native Node Blob streams a sparse image larger than the selector input limit", async () => {
  const size = 8 * 1024 * 1024;
  const encoded = new Uint8Array(40 + size);
  const header = new DataView(encoded.buffer);
  header.setUint32(0, 0xed26ff3a, true);
  for (const [offset, value] of [[4, 1], [8, 28], [10, 12], [28, 0xcac1]]) header.setUint16(offset, value, true);
  for (const [offset, value] of [[12, 4096], [16, size / 4096], [20, 1], [32, size / 4096], [36, size + 12]]) header.setUint32(offset, value, true);
  for (let i = 40; i < encoded.length; i++) encoded[i] = i % 251;
  const expected = createHash("sha256").update(encoded.subarray(40)).digest("hex");
  const device = new qdlDevice(new ArrayBuffer(1));
  Object.defineProperty(device, "firehose", { value: {
    programSparseMaxExtents: 4096,
    cfg: { SECTOR_SIZE_IN_BYTES: 4096, ZLPAwareHost: 0 },
    async cmdProgramSparse(lun, start, plan) {
      assert.equal(lun, 0);
      assert.equal(start, 100n);
      const actual = createHash("sha256");
      let bytes = 0;
      for await (const chunk of plan.parts[0].stream()) {
        assert.ok(chunk.length <= 4 * 1024 * 1024);
        actual.update(chunk);
        bytes += chunk.length;
      }
      assert.equal(bytes, size);
      assert.equal(actual.digest("hex"), expected);
      return true;
    },
  } });
  device.detectPartition = () => Promise.resolve([true, 0, { start: 100n, sectors: BigInt(size / 4096) }, { sectorSize: 4096 }]);
  assert.equal(await device.flashBlob("system_a", new Blob([encoded]), undefined, false), true);
});
