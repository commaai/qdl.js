import { describe, expect, test } from "bun:test";

import { xmlParser } from "./xmlParser";


describe("xmlParser", () => {
  const parser = new xmlParser();

  describe("getResponse", () => {
    test("parse a simple response", () => {
      const xml = "<?xml version=\"1.0\" ?><data><response value=\"ACK\"/></data>";
      const result = parser.getResponse(new TextEncoder().encode(xml));
      expect(result).toEqual({ value: "ACK" });
    });
  });

  describe("getLog", () => {
    test("parse a simple log", () => {
      const xml = "<?xml version=\"1.0\" ?><data><log value=\"Test message\"/></data>";
      const result = parser.getLog(new TextEncoder().encode(xml));
      expect(result).toEqual(["Test message"]);
    });
  });
});
