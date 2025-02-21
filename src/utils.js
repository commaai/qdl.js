export const sleep = ms => new Promise(r => setTimeout(r, ms));


export class StructHelper {
  /**
   * @param {Uint8Array} data
   */
  constructor(data) {
    this.data = data;
    this.length = data.length;
    this.view = new DataView(this.data.buffer);
    this.pos = 0;
  }

  /**
   * @param size
   * @returns {[number, number]}
   * @private
   */
  #advance(size) {
    const [start, end] = [this.pos, this.pos + size];
    if (end > this.length) throw new Error("End of data reached");
    this.pos = end;
    return [start, end];
  }

  /**
   * @param {number} length
   * @returns {Uint8Array}
   */
  bytes(length) {
    const [start, end] = this.#advance(length);
    return this.data.slice(start, end);
  }

  /**
   * @param {boolean} littleEndian
   * @returns {number}
   */
  dword(littleEndian = true) {
    const [start] = this.#advance(4);
    return this.view.getUint32(start, littleEndian);
  }

  /**
   * @param {boolean} littleEndian
   * @returns {bigint}
   */
  qword(littleEndian=true) {
    const [start] = this.#advance(8);
    return this.view.getBigUint64(start, littleEndian);
  }
}


/**
 * @param {number[]} elements
 * @param {boolean} littleEndian
 * @returns {Uint8Array}
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
 * @returns {Uint8Array}
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


/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeout
 * @returns {Promise<T>}
 */
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

Uint8Array.prototype.toHexString = function() {
  return Array.from(this)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join(' ');
};
