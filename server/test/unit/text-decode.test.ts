import { describe, expect, it } from "vitest";
import { decodeTextMaterial } from "../../src/services/aiService.js";

// #134: the decode policy for .txt/.md material bytes. Strict UTF-8 first, so
// a valid UTF-8 file round-trips byte-identically; only bytes that are NOT
// valid UTF-8 fall back to Windows-1252 (every byte maps, nothing is ever
// replaced). The old lenient utf-8 read turned each legacy-encoded byte into
// U+FFFD and shipped the � straight into the prompt.

describe("decodeTextMaterial", () => {
  it("round-trips UTF-8 byte-identically — em-dash, umlauts, math symbols", () => {
    const text = "Prüfung — Kapitel 3: ≥ 90 %, λ ≈ 0,5 · Übung „quoted“";
    expect(decodeTextMaterial(Buffer.from(text, "utf-8"))).toBe(text);
  });

  it("plain ASCII decodes unchanged under either encoding", () => {
    expect(decodeTextMaterial(Buffer.from("chapter 3, exercise 7b"))).toBe(
      "chapter 3, exercise 7b",
    );
  });

  it("decodes Windows-1252 bytes to the intended characters, not U+FFFD", () => {
    // "Prüfung — Kapitel 3" in cp1252: ü=0xFC, em-dash=0x97.
    const cp1252 = Buffer.from([
      0x50, 0x72, 0xfc, 0x66, 0x75, 0x6e, 0x67, 0x20, 0x97, 0x20, 0x4b, 0x61, 0x70, 0x69,
      0x74, 0x65, 0x6c, 0x20, 0x33,
    ]);
    const decoded = decodeTextMaterial(cp1252);
    expect(decoded).toBe("Prüfung — Kapitel 3");
    expect(decoded).not.toContain("�");
  });

  it("maps the cp1252 0x80–0x9F range (where latin1 has only control chars)", () => {
    // 0x84 „  0x93 “  0x96 –  0x97 —  0x9C œ  0x80 €
    const bytes = Buffer.from([0x84, 0x93, 0x96, 0x97, 0x9c, 0x80]);
    expect(decodeTextMaterial(bytes)).toBe("„“–—œ€");
  });
});
