/**
 * V2 Symmetric Ratchet & Forward Secrecy Service (Phase 5)
 *
 * Implements HKDF-SHA256 symmetric chain advancement, domain-separated per-message key derivation,
 * out-of-order skipped message key handling, and forward secrecy for deleted message keys.
 */

import {
  canonicalize,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  isWebCryptoSupported,
} from '@/lib/cryptoV2';

export interface RatchetStateV2 {
  roomId: string;
  epoch: number;
  senderDeviceId: string;
  sequenceNumber: number;
  chainKey: CryptoKey;
}

export interface SkippedMessageKey {
  sequenceNumber: number;
  messageKey: CryptoKey;
  createdAt: number;
}

// Maximum number of skipped message keys allowed per ratchet session
export const MAX_SKIPPED_KEYS = 50;
// Expiration time for skipped message keys (10 minutes in ms)
export const SKIPPED_KEY_TTL_MS = 600000;

// In-memory stores for active sending/receiving ratchets and skipped keys
const ratchetStateStore = new Map<string, RatchetStateV2>(); // key: `${roomId}:${epoch}:${senderDeviceId}`
const skippedKeysStore = new Map<string, SkippedMessageKey[]>(); // key: `${roomId}:${epoch}:${senderDeviceId}`

export function clearRatchetStore(): void {
  ratchetStateStore.clear();
  skippedKeysStore.clear();
}

/**
 * Initializes a new symmetric ratchet state from an epoch room master key.
 */
export async function initRatchetState(params: {
  roomId: string;
  epoch: number;
  senderDeviceId: string;
  epochKey: CryptoKey;
  role?: 'send' | 'recv';
  initialSequenceNumber?: number;
}): Promise<RatchetStateV2> {
  if (!isWebCryptoSupported()) {
    throw new Error('Web Crypto API is not supported in this environment.');
  }

  const {
    roomId,
    epoch,
    senderDeviceId,
    epochKey,
    role = 'send',
    initialSequenceNumber = 0,
  } = params;

  // Export raw epoch key bytes to derive initial chain key
  const rawEpochKey = await globalThis.crypto.subtle.exportKey('raw', epochKey);

  const hkdfBaseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    rawEpochKey,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );

  const info = new TextEncoder().encode(
    'private-coded-chat:v2:ratchet:init:' +
      canonicalize({ epoch, roomId, senderDeviceId })
  );

  const chainKey = await globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info,
    },
    hkdfBaseKey,
    { name: 'AES-GCM', length: 256 },
    true, // extractable internally to allow advancing next chain key
    ['encrypt', 'decrypt']
  );

  const state: RatchetStateV2 = {
    roomId,
    epoch,
    senderDeviceId,
    sequenceNumber: initialSequenceNumber,
    chainKey,
  };

  const key = `${roomId}:${epoch}:${senderDeviceId}:${role}`;
  ratchetStateStore.set(key, state);

  return state;
}

/**
 * Gets or initializes an active ratchet state.
 */
export async function getOrInitRatchetState(params: {
  roomId: string;
  epoch: number;
  senderDeviceId: string;
  epochKey: CryptoKey;
  role?: 'send' | 'recv';
}): Promise<RatchetStateV2> {
  const { roomId, epoch, senderDeviceId, epochKey, role = 'send' } = params;
  const key = `${roomId}:${epoch}:${senderDeviceId}:${role}`;

  let state = ratchetStateStore.get(key);
  if (!state) {
    state = await initRatchetState({
      roomId,
      epoch,
      senderDeviceId,
      epochKey,
      role,
    });
  }

  return state;
}

/**
 * Advances the ratchet chain by one step, returning a non-extractable message key and updating the chain key.
 */
export async function advanceRatchetChain(
  state: RatchetStateV2,
  messageId: string
): Promise<{ messageKey: CryptoKey; nextState: RatchetStateV2 }> {
  const rawChainKey = await globalThis.crypto.subtle.exportKey('raw', state.chainKey);

  const hkdfBaseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    rawChainKey,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );

  // 1. Derive non-extractable per-message AES-256-GCM encryption key
  const msgInfo = new TextEncoder().encode(
    'private-coded-chat:v2:ratchet:message:' +
      canonicalize({
        epoch: state.epoch,
        roomId: state.roomId,
        sequenceNumber: state.sequenceNumber,
        senderDeviceId: state.senderDeviceId,
      })
  );

  const messageKey = await globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: msgInfo,
    },
    hkdfBaseKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable message key
    ['encrypt', 'decrypt']
  );

  // 2. Derive next chain key
  const nextChainInfo = new TextEncoder().encode(
    'private-coded-chat:v2:ratchet:next-chain:' +
      canonicalize({
        epoch: state.epoch,
        roomId: state.roomId,
        sequenceNumber: state.sequenceNumber,
        senderDeviceId: state.senderDeviceId,
      })
  );

  const nextChainKey = await globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: nextChainInfo,
    },
    hkdfBaseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  // Advance state
  state.sequenceNumber += 1;
  state.chainKey = nextChainKey;

  const key = `${state.roomId}:${state.epoch}:${state.senderDeviceId}`;
  ratchetStateStore.set(key, state);

  return { messageKey, nextState: state };
}

/**
 * Stores a skipped message key for out-of-order decryption, enforcing MAX_SKIPPED_KEYS limit and TTL.
 */
export function storeSkippedKey(
  roomId: string,
  epoch: number,
  senderDeviceId: string,
  sequenceNumber: number,
  messageKey: CryptoKey
): void {
  const storeKey = `${roomId}:${epoch}:${senderDeviceId}`;
  let list = skippedKeysStore.get(storeKey) || [];

  // Remove expired keys
  const now = Date.now();
  list = list.filter((k) => now - k.createdAt < SKIPPED_KEY_TTL_MS);

  // Enforce max capacity
  if (list.length >= MAX_SKIPPED_KEYS) {
    list.shift(); // Evict oldest skipped key
  }

  list.push({ sequenceNumber, messageKey, createdAt: now });
  skippedKeysStore.set(storeKey, list);
}

/**
 * Consumes and returns a skipped message key for an out-of-order message, deleting it immediately from store.
 */
export function consumeSkippedKey(
  roomId: string,
  epoch: number,
  senderDeviceId: string,
  sequenceNumber: number
): CryptoKey | null {
  const storeKey = `${roomId}:${epoch}:${senderDeviceId}`;
  const list = skippedKeysStore.get(storeKey);
  if (!list || list.length === 0) {
    return null;
  }

  const index = list.findIndex((item) => item.sequenceNumber === sequenceNumber);
  if (index === -1) {
    return null;
  }

  const [skipped] = list.splice(index, 1);
  skippedKeysStore.set(storeKey, list);

  // Verify non-expiration
  if (Date.now() - skipped.createdAt > SKIPPED_KEY_TTL_MS) {
    return null;
  }

  return skipped.messageKey;
}
