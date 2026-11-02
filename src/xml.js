import { XMLParser } from "fast-xml-parser";

function copyParsed(value) {
  if (Array.isArray(value)) return value.map(copyParsed);
  if (value && typeof value === "object") {
    const copy = { ...value };
    for (const key of Object.keys(copy)) copy[key] = copyParsed(copy[key]);
    return copy;
  }
  return value;
}

/**
 * @param {string} tagName
 * @param {Record<string, any>} [attributes={}]
 * @returns {string}
 */
export function toXml(tagName, attributes = {}) {
  const attrs = Object.entries(attributes).map(([key, value]) => `${key}="${value}"`).join(" ");
  return `<?xml version="1.0" ?><data><${tagName}${attrs ? ` ${attrs}` : ""} /></data>`;
}

export class xmlParser {
  #lastText;
  #lastParser;
  #lastDocuments;
  decoder = new TextDecoder();
  parser = new XMLParser({
    attributeNamePrefix: "",
    htmlEntities: true,
    ignoreAttributes: false,
    processEntities: true,
    trimValues: false,
  });

  /**
   * @param {Uint8Array} input
   * @yields {Document[]}
   */
  * #parseXmlDocuments(input) {
    // Decode again so reused or mutated USB buffers cannot return stale data.
    const text = this.decoder.decode(input);
    if (text === this.#lastText && this.parser === this.#lastParser) {
      yield* this.#lastDocuments;
      return;
    }
    const documents = [];
    for (const xml of text.split("<?xml")) {
      if (!xml) continue;
      const document = this.parser.parse(`<?xml${xml}`).data;
      documents.push(document);
      yield document;
    }
    // Keep only the latest fully consumed packet. Failed parsing is never cached.
    this.#lastText = text;
    this.#lastParser = this.parser;
    this.#lastDocuments = documents;
  }

  /**
   * @param {Uint8Array} input
   * @returns {Record<string, string>}
   */
  getResponse(input) {
    const content = {};
    for (const doc of this.#parseXmlDocuments(input)) {
      Object.assign(content, copyParsed(doc.response));
    }
    return content;
  }

  /**
   * @param {Uint8Array} input
   * @returns {string[]}
   */
  getLog(input) {
    const data = [];
    for (const doc of this.#parseXmlDocuments(input)) {
      if ("log" in doc) {
        if (Array.isArray(doc.log)) {
          for (const log of doc.log)
            if ("value" in log) data.push(copyParsed(log.value));
        } else if ("value" in doc.log) {
          data.push(copyParsed(doc.log.value));
        }
      }
    }
    return data;
  }
}
