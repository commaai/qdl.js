import { bytes, custom, string, struct, uint32, uint64 } from "@incognitojam/tiny-struct";


/**
 * @see {@link https://uefi.org/specs/UEFI/2.10/Apx_A_GUID_and_Time_Formats.html#efi-guid-format-apxa-guid-and-time-formats}
 */
export const guid = () => custom(16, (buffer, offset, littleEndian) => {
  const timeLow = buffer.getUint32(offset, littleEndian);
  const timeMid = buffer.getUint16(offset + 4, littleEndian);
  const timeHighAndVersion = buffer.getUint16(offset + 6, littleEndian);
  const clockSeqHighAndReserved = buffer.getUint8(offset + 8);
  const clockSeqLow = buffer.getUint8(offset + 9);
  // Node is always stored in big-endian format regardless of littleEndian flag
  const node = Array.from({ length: 6 }, (_, i) => buffer.getUint8(offset + 10 + i).toString(16).padStart(2, "0")).join("");

  return [
    timeLow.toString(16).padStart(8, "0"),
    timeMid.toString(16).padStart(4, "0"),
    timeHighAndVersion.toString(16).padStart(4, "0"),
    clockSeqHighAndReserved.toString(16).padStart(2, "0") + clockSeqLow.toString(16).padStart(2, "0"),
    node,
  ].join("-");
}, (buffer, offset, value, littleEndian) => {
  const parts = value.split("-");
  if (parts.length !== 5) throw new Error("Invalid GUID format");

  const timeLow = Number.parseInt(parts[0], 16);
  const timeMid = Number.parseInt(parts[1], 16);
  const timeHighAndVersion = Number.parseInt(parts[2], 16);
  const clockSeq = Number.parseInt(parts[3], 16);
  const clockSeqHighAndReserved = (clockSeq >> 8) & 0xFF;
  const clockSeqLow = clockSeq & 0xFF;

  buffer.setUint32(offset, timeLow, littleEndian);
  buffer.setUint16(offset + 4, timeMid, littleEndian);
  buffer.setUint16(offset + 6, timeHighAndVersion, littleEndian);
  buffer.setUint8(offset + 8, clockSeqHighAndReserved);
  buffer.setUint8(offset + 9, clockSeqLow);

  const nodeHex = parts[4];
  for (let i = 0; i < 6; i++) {
    buffer.setUint8(offset + 10 + i, Number.parseInt(nodeHex.substring(i * 2, i * 2 + 2), 16));
  }
});


export const utf16cstring = (maxLength) => custom(maxLength * 2, (buffer, offset, littleEndian) => {
  const charCodes = [];
  for (let i = 0; i < maxLength; i++) {
    const charCode = buffer.getUint16(offset + i * 2, littleEndian);
    if (charCode === 0) break;
    charCodes.push(charCode);
  }
  return String.fromCharCode(...charCodes);
}, (buffer, offset, value, littleEndian) => {
  const length = Math.min(value.length, maxLength - 1);
  for (let i = 0; i < length; i++) {
    buffer.setUint16(offset + i * 2, value.charCodeAt(i), littleEndian);
  }
  buffer.setUint16(offset + length * 2, 0, littleEndian);
});
