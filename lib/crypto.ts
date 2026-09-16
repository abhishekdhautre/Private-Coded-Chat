const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function deriveKey(passphrase: string, roomId: string): Promise<CryptoKey> {
  if (!passphrase) throw new Error("Passphrase is required");
  if (!roomId) throw new Error("Room ID is required");
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode(roomId), iterations: 100_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encrypt(plaintext: string, key: CryptoKey, aad?: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const algorithm: AesGcmParams = {
    name: "AES-GCM",
    iv: toArrayBuffer(iv),
  };
  if (aad) algorithm.additionalData = toArrayBuffer(encoder.encode(aad));
  const ciphertext = await crypto.subtle.encrypt(
    algorithm,
    key,
    toArrayBuffer(encoder.encode(plaintext))
  );
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

export async function decrypt(ciphertext: string, iv: string, key: CryptoKey, aad?: string): Promise<string> {
  const algorithm: AesGcmParams = {
    name: "AES-GCM",
    iv: toArrayBuffer(base64ToBytes(iv)),
  };
  if (aad) algorithm.additionalData = toArrayBuffer(encoder.encode(aad));
  const plaintext = await crypto.subtle.decrypt(
    algorithm,
    key,
    toArrayBuffer(base64ToBytes(ciphertext))
  );
  return decoder.decode(plaintext);
}

export async function createKeyCheck(key: CryptoKey): Promise<{ ciphertext: string; iv: string }> {
  const verifier = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  return encrypt(verifier, key);
}
