import { describe, expect, it } from "vitest";
import { decodeText, encodeText, resolveDisplayKeyword } from "@/lib/cipher";

describe("display cipher", () => {
  it("round trips while preserving punctuation and numbers", () => {
    const plain = "Hello, world! Meet at 9:30.";
    const keyword = "shadow";
    expect(decodeText(encodeText(plain, keyword), keyword)).toBe(plain);
  });
  it("preserves case", () => expect(encodeText("AbC", "b")).toBe("BcD"));
  it("handles empty text and leaves non-English characters unchanged", () => {
    expect(encodeText("", "orbit")).toBe("");
    expect(encodeText("こんにちは 123!", "orbit")).toBe("こんにちは 123!");
  });
  it("returns plaintext unchanged when keyword is empty", () => expect(encodeText("hello", "")).toBe("hello"));
});

describe("display cipher keyword resolution for V2/V3 ratchet messages", () => {
  const V2_ROOM = "aliceUid__bobUid";

  it("keeps the V1 passphrase keyword untouched", () => {
    expect(resolveDisplayKeyword("shadow", false, V2_ROOM)).toBe("shadow");
  });

  it("returns an empty keyword for a V1 room that has no keyword (preserves old behavior)", () => {
    expect(resolveDisplayKeyword("", false, V2_ROOM)).toBe("");
  });

  // Regression: unlockV2() sets keyword to "", and encodeText("", ...) is a no-op,
  // which rendered the decrypted V3 plaintext verbatim while in "Coded" mode.
  it("resolves a stable non-empty keyword for V2 rooms so encodeText actually transforms", () => {
    const kw = resolveDisplayKeyword("", true, V2_ROOM);
    expect(kw).not.toBe("");
    expect(encodeText("hello from A", kw)).not.toBe("hello from A");
  });

  it("is deterministic, so both participants render identical coded text", () => {
    const a = resolveDisplayKeyword("", true, V2_ROOM);
    const b = resolveDisplayKeyword("", true, V2_ROOM);
    expect(a).toBe(b);
    expect(encodeText("hello from A", a)).toBe(encodeText("hello from A", b));
  });

  it("keeps the underlying plaintext intact for Revealed mode", () => {
    const kw = resolveDisplayKeyword("", true, V2_ROOM);
    // "Revealed" renders m.plaintext directly, so the display cipher must be
    // reversible to the exact original text and must not mutate it.
    const plain = "hello from A";
    expect(decodeText(encodeText(plain, kw), kw)).toBe(plain);
  });

  it("applies the same transformation to V1 and V3 messages given the same keyword", () => {
    const v1kw = resolveDisplayKeyword("shadow", false, V2_ROOM);
    const v3kw = resolveDisplayKeyword("", true, V2_ROOM);
    // Same function, same semantics — only the keyword source differs.
    expect(decodeText(encodeText("meet at 9:30", v1kw), v1kw)).toBe("meet at 9:30");
    expect(decodeText(encodeText("meet at 9:30", v3kw), v3kw)).toBe("meet at 9:30");
  });
});
