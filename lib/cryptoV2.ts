/**
 * Web Crypto V2 Primitives for End-to-End Encryption (Phase 1)
 *
 * Implements native ECDSA (P-256) identity signing keys and ECDH (P-256) key-exchange keys.
 * All private keys are generated as non-extractable.
 */

export interface DeviceIdentityPayload {
  deviceId: string;
  identityPublicKey: JsonWebKey;
  exchangePublicKey: JsonWebKey;
  createdAt: number;
}

export interface SignedDeviceIdentityBundle {
  payload: DeviceIdentityPayload;
  signature: string; // Base64 encoded ECDSA signature
}

/**
 * Checks if the Web Crypto API is supported in the current environment.
 */
export function isWebCryptoSupported(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.subtle !== 'undefined'
  );
}

/**
 * Generates an ECDSA P-256 identity key pair for digital signatures.
 * Private key is generated as non-extractable.
 */
export async function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  if (!isWebCryptoSupported()) {
    throw new Error('Web Crypto API is not supported in this environment.');
  }
  return await globalThis.crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    false, // non-extractable private key
    ['sign', 'verify']
  );
}

/**
 * Generates an ECDH P-256 key-exchange pair for secret derivation.
 * Private key is generated as non-extractable.
 */
export async function generateExchangeKeyPair(): Promise<CryptoKeyPair> {
  if (!isWebCryptoSupported()) {
    throw new Error('Web Crypto API is not supported in this environment.');
  }
  return await globalThis.crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false, // non-extractable private key
    ['deriveKey', 'deriveBits']
  );
}

/**
 * Exports a public CryptoKey to JSON Web Key (JWK) format.
 */
export async function exportPublicKey(key: CryptoKey): Promise<JsonWebKey> {
  if (!isWebCryptoSupported()) {
    throw new Error('Web Crypto API is not supported in this environment.');
  }
  if (key.type !== 'public') {
    throw new Error('Only public keys can be exported.');
  }
  return await globalThis.crypto.subtle.exportKey('jwk', key);
}

/**
 * Imports a JWK formatted public key back to a CryptoKey.
 */
export async function importPublicKey(
  jwk: JsonWebKey,
  type: 'ECDSA' | 'ECDH'
): Promise<CryptoKey> {
  if (!isWebCryptoSupported()) {
    throw new Error('Web Crypto API is not supported in this environment.');
  }
  if (type === 'ECDSA') {
    return await globalThis.crypto.subtle.importKey(
      'jwk',
      jwk,
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      true,
      ['verify']
    );
  } else {
    return await globalThis.crypto.subtle.importKey(
      'jwk',
      jwk,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true,
      []
    );
  }
}

/**
 * Signs data using an ECDSA P-256 private key and SHA-256 hashing.
 */
export async function sign(
  privateKey: CryptoKey,
  data: Uint8Array
): Promise<ArrayBuffer> {
  if (!isWebCryptoSupported()) {
    throw new Error('Web Crypto API is not supported in this environment.');
  }
  return await globalThis.crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: 'SHA-256',
    },
    privateKey,
    data as unknown as BufferSource
  );
}

/**
 * Verifies an ECDSA signature over data using an ECDSA P-256 public key.
 */
export async function verify(
  publicKey: CryptoKey,
  signature: ArrayBuffer | Uint8Array,
  data: Uint8Array
): Promise<boolean> {
  if (!isWebCryptoSupported()) {
    throw new Error('Web Crypto API is not supported in this environment.');
  }
  return await globalThis.crypto.subtle.verify(
    {
      name: 'ECDSA',
      hash: 'SHA-256',
    },
    publicKey,
    signature as unknown as BufferSource,
    data as unknown as BufferSource
  );
}

/**
 * Recursively canonicalizes an object into a deterministic JSON string with sorted keys.
 */
export function canonicalize(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const sortedPairs = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`
  );
  return '{' + sortedPairs.join(',') + '}';
}

/**
 * Serializes a DeviceIdentityPayload deterministically to UTF-8 encoded Uint8Array.
 */
export function canonicalSerialize(payload: DeviceIdentityPayload): Uint8Array {
  const jsonString = canonicalize(payload);
  return new TextEncoder().encode(jsonString);
}

/**
 * Helper to convert ArrayBuffer to Base64 string.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}

/**
 * Helper to convert Base64 string to ArrayBuffer.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = globalThis.atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Normalizes a JWK to a canonical form containing only essential fields.
 * Web Crypto's exportKey('jwk') can include optional fields (alg, key_ops, ext)
 * that vary between exports, breaking deterministic canonicalization.
 * For EC P-256 keys, only kty, crv, x, y are required for import/verification.
 */
export function normalizeJwk(jwk: JsonWebKey): JsonWebKey {
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
    return {
      kty: 'EC',
      crv: 'P-256',
      x: jwk.x,
      y: jwk.y,
    };
  }
  // For other key types, return as-is (shouldn't occur in our codebase)
  return jwk;
}

/**
 * Constructs a signed device identity bundle binding ECDH exchange public key to ECDSA identity key.
 */
export async function createDeviceIdentityBundle(
  deviceId: string,
  identityKeyPair: CryptoKeyPair,
  exchangeKeyPair: CryptoKeyPair,
  createdAt: number = Date.now()
): Promise<SignedDeviceIdentityBundle> {
  const identityPubKeyJwk = normalizeJwk(await exportPublicKey(identityKeyPair.publicKey));
  const exchangePubKeyJwk = normalizeJwk(await exportPublicKey(exchangeKeyPair.publicKey));

  const payload: DeviceIdentityPayload = {
    deviceId,
    identityPublicKey: identityPubKeyJwk,
    exchangePublicKey: exchangePubKeyJwk,
    createdAt,
  };

  const canonicalBytes = canonicalSerialize(payload);
  const sigBuffer = await sign(identityKeyPair.privateKey, canonicalBytes);
  const signature = arrayBufferToBase64(sigBuffer);

  return {
    payload,
    signature,
  };
}

/**
 * Verifies a device identity bundle's signature using the embedded identity public key.
 */
export async function verifyDeviceIdentityBundle(
  bundle: SignedDeviceIdentityBundle
): Promise<boolean> {
  const identityPubKey = await importPublicKey(
    bundle.payload.identityPublicKey,
    'ECDSA'
  );
  const canonicalBytes = canonicalSerialize(bundle.payload);
  const sigBuffer = base64ToArrayBuffer(bundle.signature);
  return await verify(identityPubKey, sigBuffer, canonicalBytes);
}
