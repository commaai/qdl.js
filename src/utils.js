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
    return this.data.subarray(start, end);
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
  const n = elements.length;
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
  const totalLength = arrays.reduce((sum, arr) => sum + arr.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.byteLength;
  }
  return result;
}


/**
 * @param {string} subString
 * @param {Uint8Array} array
 * @returns {boolean}
 */
export function containsBytes(subString, array) {
  const tArray = new TextDecoder().decode(array);
  return tArray.includes(subString);
}


/**
 * @param {string} compareString
 * @param {Uint8Array} array
 * @returns {boolean}
 */
export function compareStringToBytes(compareString, array) {
  const tArray = new TextDecoder().decode(array);
  return compareString === tArray;
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
    const tid = setTimeout(() => {
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
