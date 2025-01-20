export class xmlParser {
  decoder = new TextDecoder();
  parser = new DOMParser();

  /**
   * @param {Uint8Array} input
   * @returns {Document}
   */
  #parseXmlDocument(input) {
    return this.parser.parseFromString(this.decoder.decode(input), "text/xml");
  }

  /**
   * @param {Uint8Array} input
   * @returns {Record<string, string>}
   */
  getResponse(input) {
    const doc = this.#parseXmlDocument(input);
    const content = {};
    doc.querySelectorAll("response").forEach((el) => {
      for (const attr of el.attributes) content[attr.name] = attr.value;
    });
    return content;
  }

  /**
   * @param {Uint8Array} input
   * @returns {string[]}
   */
  getLog(input) {
    const doc = this.#parseXmlDocument(input);
    const data = [];
    doc.querySelectorAll("log").forEach((el) => {
      for (const attr of el.attributes) {
        if (attr.name !== "value") continue;
        data.push(attr.value);
        break;
      }
    });
    return data;
  }
}
