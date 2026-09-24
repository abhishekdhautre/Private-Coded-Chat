function shiftFor(keyword: string, index: number): number {
  const ch = keyword[index % keyword.length].toLowerCase();
  return ch >= "a" && ch <= "z" ? ch.charCodeAt(0) - 97 : 0;
}

function transform(text: string, keyword: string, direction: 1 | -1): string {
  if (!keyword) return text;
  let letterIndex = 0;
  return [...text].map((ch) => {
    const code = ch.charCodeAt(0);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isUpper && !isLower) return ch;
    const base = isUpper ? 65 : 97;
    const shifted = (code - base + direction * shiftFor(keyword, letterIndex)) % 26;
    letterIndex++;
    return String.fromCharCode(base + (shifted + 26) % 26);
  }).join("");
}

export function encodeText(plain: string, keyword: string): string { return transform(plain, keyword, 1); }
export function decodeText(coded: string, keyword: string): string { return transform(coded, keyword, -1); }

/**
 * Resolves the keyword fed into the cosmetic display cipher.
 *
 * V1 rooms get a real passphrase keyword from `unlock()`. V2 rooms have no
 * passphrase — `unlockV2()` deliberately sets an empty keyword — and
 * `transform()` returns the text untouched for an empty keyword, so "Coded"
 * mode would render the decrypted plaintext verbatim.
 *
 * For V2 rooms we therefore derive a stable display keyword from the roomId.
 * The roomId is identical on both participants' devices, so both sides render
 * the same coded text, and it stays constant across reloads — meaning the
 * Coded/Revealed toggle re-renders already-loaded messages with no re-fetch,
 * no re-decryption and no re-encryption.
 *
 * This is display-only. It never participates in cryptographic decryption and
 * never alters stored ciphertext or Firebase data.
 */
export function resolveDisplayKeyword(keyword: string, isV2: boolean, roomId: string): string {
  if (keyword) return keyword;
  return isV2 ? roomId : "";
}
