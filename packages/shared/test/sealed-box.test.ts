import { describe, expect, it } from "vitest";
import { parseMasterKey, SealedBox } from "../src/sealed-box.ts";

const HEX_KEY = "0f".repeat(32);

describe("SealedBox", () => {
  it("round-trips with a fresh nonce per value", () => {
    const box = new SealedBox(HEX_KEY);
    const a = box.seal("value-1", "ws_1:pi:openrouter");
    const b = box.seal("value-1", "ws_1:pi:openrouter");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toContain("value-1");
    expect(box.open(a, "ws_1:pi:openrouter")).toBe("value-1");
  });

  it("rejects another record's additional data, tampering and a different key", () => {
    const box = new SealedBox(HEX_KEY);
    const sealed = box.seal("value-2", "ws_1:multix:GEMINI_API_KEY");
    expect(() => box.open(sealed, "ws_2:multix:GEMINI_API_KEY")).toThrow("failed authentication");
    const bytes = Buffer.from(sealed.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() =>
      box.open({ ...sealed, ciphertext: bytes.toString("base64") }, "ws_1:multix:GEMINI_API_KEY"),
    ).toThrow();
    expect(() => new SealedBox("1e".repeat(32)).open(sealed, "ws_1:multix:GEMINI_API_KEY")).toThrow(
      "different CREDENTIALS_ENCRYPTION_KEY",
    );
  });

  it("accepts 32-byte keys as hex or base64 only", () => {
    expect(parseMasterKey(HEX_KEY)).toHaveLength(32);
    expect(parseMasterKey(Buffer.alloc(32, 7).toString("base64"))).toHaveLength(32);
    expect(() => parseMasterKey("short")).toThrow("32 bytes");
  });
});
