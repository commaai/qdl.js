export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));


export class StructHelper {
  private view: DataView;
  private _pos = 0;

  constructor(private data: Uint8Array) {
    this.view = new DataView(this.data.buffer);
  }

  public get pos(): number {
    return this._pos;
  }

  #advance(size: number): [number, number] {
    const [start, end] = [this._pos, this._pos + size];
    if (end > this.data.length) throw new Error("End of data reached");
    this._pos = end;
    return [start, end];
  }

  bytes(length: number): Uint8Array {
    const [start, end] = this.#advance(length);
    return this.data.slice(start, end);
  }

  dword(littleEndian = true): number {
    const [start] = this.#advance(4);
    return this.view.getUint32(start, littleEndian);
  }

  qword(littleEndian = true): bigint {
    const [start] = this.#advance(8);
    return this.view.getBigUint64(start, littleEndian);
  }
}


export function packGenerator(elements: number[], littleEndian = true): Uint8Array {
  const n = elements.length;
  const buffer = new ArrayBuffer(n * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < n; i++) {
    view.setUint32(i * 4, elements[i], littleEndian);
  }
  return new Uint8Array(view.buffer);
}


export function concatUint8Array(arrays: Uint8Array[]): Uint8Array {
  const length = arrays.filter(Boolean).reduce((sum, arr) => sum + arr.length, 0);
  const concatArray = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    if (!array) continue;
    concatArray.set(array, offset);
    offset += array.length;
  }
  return concatArray;
}


export function containsBytes(subString: string, array: Uint8Array): boolean {
  const tArray = new TextDecoder().decode(array);
  return tArray.includes(subString);
}


export function compareStringToBytes(compareString: string, array: Uint8Array): boolean {
  const tArray = new TextDecoder().decode(array);
  return compareString === tArray;
}


export function bytes2Number(array: Uint8Array): number | bigint {
  const view = new DataView(array.buffer, 0);
  if (array.length !== 8 && array.length !== 4) {
    throw "Only convert to 64 and 32 bit Number";
  }
  return (array.length === 8) ? view.getBigUint64(0, true) : view.getUint32(0, true);
}


export function runWithTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
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


export class BlobBuilder {
  private buffer: Uint8Array;
  private offset = 0;

  constructor(private maxSize: number) {
    this.buffer = new Uint8Array(maxSize);
  }

  async* append(data: Blob): AsyncIterable<Uint8Array> {
    let dataOffset = 0;
    while (dataOffset < data.size) {
      const chunkData = data.slice(dataOffset, this.maxSize - this.offset + dataOffset);
      dataOffset += chunkData.size;
      this.buffer.set(new Uint8Array(await chunkData.arrayBuffer()), this.offset);
      this.offset += chunkData.size;
      if (this.offset === this.maxSize) for (const chunk of this.flush()) {
        yield chunk;
      }
    }
  }

  * flush(): Iterable<Uint8Array> {
    if (this.offset) {
      yield this.buffer.slice(0, this.offset);
      this.buffer = new Uint8Array(this.maxSize);
      this.offset = 0;
    }
  }
}
