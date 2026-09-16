import { describe, expect, it } from "vitest";
import { decrypt, deriveKey, encrypt } from "@/lib/crypto";

describe("Web Crypto helpers", () => {
  it("encrypts and decrypts with AES-GCM", async () => {
    const key = await deriveKey("CORRECT-SECRET", "room-one");
    const payload = await encrypt("hello this is secret", key);

    await expect(decrypt(payload.ciphertext, payload.iv, key)).resolves.toBe("hello this is secret");
  });

  it("uses a fresh IV and ciphertext for every encryption", async () => {
    const key = await deriveKey("CORRECT-SECRET", "room-one");
    const first = await encrypt("same text", key);
    const second = await encrypt("same text", key);

    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it("rejects a wrong key and tampered authentication data", async () => {
    const key = await deriveKey("CORRECT-SECRET", "room-one");
    const wrongKey = await deriveKey("WRONG-SECRET", "room-one");
    const payload = await encrypt("verifier", key);

    await expect(decrypt(payload.ciphertext, payload.iv, wrongKey)).rejects.toThrow();
    await expect(decrypt(`${payload.ciphertext.slice(0, -2)}AA`, payload.iv, key)).rejects.toThrow();
    await expect(decrypt(payload.ciphertext, `${payload.iv.slice(0, -2)}AA`, key)).rejects.toThrow();
  });
});