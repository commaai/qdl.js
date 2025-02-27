export function toXml(tagName: string, attributes: Record<string, any> = {}) {
  const attrs = Object.entries(attributes).map(([key, value]) => `${key}="${value}"`).join(" ");
  return `<?xml version="1.0" ?><data><${tagName}${attrs ? ` ${attrs}` : ""} /></data>`;
}

export class xmlParser {
  private decoder = new TextDecoder();
  private parser = new DOMParser();

  * #parseXmlDocuments(input: Uint8Array): Iterable<Document> {
    for (const xml of this.decoder.decode(input).split("<?xml")) {
      yield this.parser.parseFromString(`<?xml${xml}`, "text/xml");
    }
  }

  getResponse(input: Uint8Array) {
    const content: Record<string, string> = {};
    for (const doc of this.#parseXmlDocuments(input)) {
      for (const el of doc.querySelectorAll("response")) {
        for (const attr of el.attributes) content[attr.name] = attr.value;
      }
    }
    return content;
  }

  getLog(input: Uint8Array) {
    const data: string[] = [];
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
