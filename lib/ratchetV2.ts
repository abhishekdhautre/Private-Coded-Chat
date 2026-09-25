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

// In-memory stores for active sending/receiving ratchets and skipped keys.
//
// EVERY ratchet-state key is ROLE-SUFFIXED:
//   `${roomId}:${epoch}:${senderDeviceId}:${role}`   with role = 'send' | 'recv'
// so this device's send chain and its receive chain for the same peer device
// are two completely independent states — neither can ever be read or mutated
// by the other. The skipped-key store below is written exclusively by the
// receive path, so it stays keyed by the chain it belongs to.
const ratchetStateStore = new Map<string, RatchetStateV2>();
const skippedKeysStore = new Map<string, SkippedMessageKey[]>();

// Per-chain async locks. A single ratchet chain is MUTABLE shared state and
// `advanceRatchetChain` reads `state.sequenceNumber` across await points, so
// two concurrent advances of the same chain could both derive a key for the
// same position and then both increment the counter — leaving the chain ahead
// of its actual key position and permanently rejecting the next message with
// "Sequence number N has already passed for active ratchet chain." Every
// read-modify-write of a chain therefore runs inside withRatchetChainLock.
const ratchetChainLocks = new Map<string, Promise<unknown>>();

/**
 * Serializes work that mutates a single ratchet chain.
 *
 * Locks are keyed by the exact same tuple as the state store
 * (`roomId:epoch:senderDeviceId:role`), so a send chain and a receive chain —
 * and one peer's chain and another's — remain fully parallel. A rejected run
 * always releases its slot and never poisons the next caller's queue.
 *
 * This is pure concurrency control: it changes no protocol, no key schedule
 * and no validation rule.
 */
export async function withRatchetChainLock<T>(
  params: { roomId: string; epoch: number; senderDeviceId: string; role?: 'send' | 'recv' },
  run: () => Promise<T>
): Promise<T> {
  const { roomId, epoch, senderDeviceId, role = 'send' } = params;
  const key = `${roomId}:${epoch}:${senderDeviceId}:${role}`;

  // Queued entries never reject (see `guard`), so `then(run)` is enough.
  const previous = ratchetChainLocks.get(key) ?? Promise.resolve();
  const current = previous.then(run);
  const guard = current.then(
    () => undefined,
    () => undefined
  );
  ratchetChainLocks.set(key, guard);

  try {
    return await current;
  } finally {
    if (ratchetChainLocks.get(key) === guard) ratchetChainLocks.delete(key);
  }
}

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
 * Current position of an in-memory ratchet chain for a single role.
 *
 * Returns `null` when this JS context holds no state for that chain — which is
 * exactly what a full page load, a mobile tab eviction or a crash restore
 * produces: both stores above are module-level and are deliberately NOT
 * persisted anywhere (localStorage / sessionStorage / Firebase).
 */
export function getRatchetPosition(params: {
  roomId: string;
  epoch: number;
  senderDeviceId: string;
  role?: 'send' | 'recv';
}): number | null {
  const { roomId, epoch, senderDeviceId, role = 'send' } = params;
  return ratchetStateStore.get(`${roomId}:${epoch}:${senderDeviceId}:${role}`)?.sequenceNumber ?? null;
}

/**
 * Upper bound on how far a chain may be fast-forwarded in a single resume.
 * The floor is computed from message ROW METADATA (sequence numbers), and rows
 * are written by signed participants, so an absurd value must fail loudly
 * instead of spinning the tab on millions of derivations.
 */
export const MAX_SEQUENCE_FLOOR_ADVANCE = 25_000;

/**
 * Ensures a ratchet chain starts at or above `targetSequenceNumber`.
 *
 * Chain derivation is a pure function of (epochKey, roomId, epoch,
 * senderDeviceId, position), so a chain that was lost together with its JS
 * context can be rebuilt and advanced past every position this device has
 * already used: the intermediate message keys are derived and DISCARDED —
 * exactly like the receive-side gap catch-up — never stored and never reused
 * to encrypt anything.
 *
 * This is what stops a resumed page from minting an already-used sequence
 * number, which every receiver (including this device's own Firebase echo)
 * rejects with "Sequence number N has already passed for active ratchet
 * chain." Sequence validation on the receive path is untouched by this.
 */
export async function ensureRatchetSequenceFloor(params: {
  roomId: string;
  epoch: number;
  senderDeviceId: string;
  epochKey: CryptoKey;
  role?: 'send' | 'recv';
  targetSequenceNumber: number;
}): Promise<{ state: RatchetStateV2; from: number; to: number }> {
  const {
    roomId,
    epoch,
    senderDeviceId,
    epochKey,
    role = 'send',
    targetSequenceNumber,
  } = params;

  const state = await getOrInitRatchetState({ roomId, epoch, senderDeviceId, epochKey, role });
  const from = state.sequenceNumber;
  const target = Number.isFinite(targetSequenceNumber)
    ? Math.max(from, Math.floor(targetSequenceNumber))
    : from;

  const gap = target - from;
  if (gap > MAX_SEQUENCE_FLOOR_ADVANCE) {
    // Safe metadata only — no keys, no plaintext.
    throw new Error(
      `Refusing to resume ratchet chain ${gap} positions ahead (limit ${MAX_SEQUENCE_FLOOR_ADVANCE}).`
    );
  }

  while (state.sequenceNumber < target) {
    await advanceRatchetChain(state, `resume_${roomId}_${epoch}_${state.sequenceNumber}`);
  }

  return { state, from, to: state.sequenceNumber };
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

  // Advance state. The store already holds THIS object under its
  // role-suffixed key, so mutating it in place is all that is needed — there
  // is deliberately no write to a role-less key, which is the one place send
  // and receive chains could otherwise have collided.
  state.sequenceNumber += 1;
  state.chainKey = nextChainKey;

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
