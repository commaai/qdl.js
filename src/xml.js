import { XMLParser } from "fast-xml-parser";

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
    for (const xml of this.decoder.decode(input).split("<?xml")) {
      if (!xml) continue;
      yield this.parser.parse(`<?xml${xml}`).data;
    }
  }

  /**
   * @param {Uint8Array} input
   * @returns {Record<string, string>}
   */
  getResponse(input) {
    const content = {};
    for (const doc of this.#parseXmlDocuments(input)) {
      Object.assign(content, doc.response);
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
            if ("value" in log) data.push(log.value);
        } else if ("value" in doc.log) {
          data.push(doc.log.value);
        }
      }
    }
    return data;
  }
}
