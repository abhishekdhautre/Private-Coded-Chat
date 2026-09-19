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
