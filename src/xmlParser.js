export class xmlParser {
  decoder = new TextDecoder();
  parser = new DOMParser();

  /**
   * @param {Uint8Array} input
   * @yields {Document[]}
   */
  * #parseXmlDocuments(input) {
    for (const xml of this.decoder.decode(input).split("<?xml")) {
      yield this.parser.parseFromString(`<?xml${xml}`, "text/xml");
    }
  }

  /**
   * @param {Uint8Array} input
   * @returns {Record<string, string>}
   */
  getResponse(input) {
    const content = {};
    for (const doc of this.#parseXmlDocuments(input)) {
      for (const el of doc.querySelectorAll("response")) {
        for (const attr of el.attributes) content[attr.name] = attr.value;
      }
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
      for (const el of doc.querySelectorAll("log")) {
        for (const attr of el.attributes) {
          if (attr.name !== "value") continue;
          data.push(attr.value);
          break;
        }
      }
    }
    return data;
  }
}
