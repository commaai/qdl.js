export const sleep = ms => new Promise(r => setTimeout(r, ms));


export class structHelper_io {
  /**
   * @param {Uint8Array} data
   * @param {number} pos
   */
  constructor(data, pos=0) {
    this.pos = pos
    this.data = data;
  }

  /**
   * @param {boolean} littleEndian
   * @returns {number}
   */
  dword(littleEndian=true) {
    let view = new DataView(this.data.slice(this.pos, this.pos+4).buffer, 0);
    this.pos += 4;
    return view.getUint32(0, littleEndian);
  }

  /**
   * @param {boolean} littleEndian
   * @returns {bigint}
   */
  qword(littleEndian=true) {
    let view = new DataView(this.data.slice(this.pos, this.pos+8).buffer, 0);
    this.pos += 8;
    return view.getBigUint64(0, littleEndian);
  }
}


/**
 * @param {number[]} elements
 * @param {boolean} littleEndian
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function packGenerator(elements, littleEndian=true) {
  let n = elements.length;
  const buffer = new ArrayBuffer(n*4);
  const view = new DataView(buffer);
  for (let i = 0; i < n; i++) {
    view.setUint32(i*4, elements[i], littleEndian);
  }
  return new Uint8Array(view.buffer);
}


/**
 * @param {Uint8Array[]} arrays
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function concatUint8Array(arrays) {
  const length = arrays.filter(Boolean).reduce((sum, arr) => sum + arr.length, 0);
  let concatArray = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    if (!array) continue;
    concatArray.set(array, offset);
    offset += array.length;
  }
  return concatArray;
}


/**
 * @param {string} subString
 * @param {Uint8Array} array
 * @returns {boolean}
 */
export function containsBytes(subString, array) {
  let tArray = new TextDecoder().decode(array);
  return tArray.includes(subString);
}


/**
 * @param {string} compareString
 * @param {Uint8Array} array
 * @returns {boolean}
 */
export function compareStringToBytes(compareString, array) {
  let tArray = new TextDecoder().decode(array);
  return compareString === tArray;
}


/**
 * @param {Blob} blob
 * @returns {Promise<ArrayBuffer>}
 */
export function readBlobAsBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}


/**
 * @param {Uint8Array} array
 * @returns {bigint|number}
 */
export function bytes2Number(array) {
  let view = new DataView(array.buffer, 0);
  if (array.length !== 8 && array.length !== 4) {
    throw "Only convert to 64 and 32 bit Number";
  }
  return (array.length === 8) ? view.getBigUint64(0, true) : view.getUint32(0, true);
}


export function runWithTimeout(promise, timeout) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let tid = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Timed out while trying to connect ${timeout}`));
    }, timeout);
    promise
      .then((val) => {
        if (!timedOut)
          resolve(val);
      })
      .catch((err) => {
        if (!timedOut)
          reject(err);
      })
      .finally(() => {
        if (!timedOut)
          clearTimeout(tid);
      });
  });
}
