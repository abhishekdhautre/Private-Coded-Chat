import { describe, expect, it } from "vitest";
import { decodeText, encodeText } from "@/lib/cipher";

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
