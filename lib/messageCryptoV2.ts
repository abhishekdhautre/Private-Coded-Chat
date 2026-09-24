/**
 * Authenticated & Signed E2EE Messaging Service (Phase 4 & Phase 5 Ratchet Integration)
 *
 * Implements V2 & V3 message formats, AES-256-GCM encryption with AAD context binding,
 * HKDF-SHA256 ratcheted per-message key derivation, ECDSA P-256 message signing,
 * sender device bundle verification, out-of-order skipped key consumption, and local replay protection.
 */

import { ref, set } from 'firebase/database';
import { db } from '@/lib/firebase';
import {
  importPublicKey,
  sign,
  verify,
  canonicalize,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  isWebCryptoSupported,
  SignedDeviceIdentityBundle,
} from '@/lib/cryptoV2';
import { getDevice } from '@/lib/deviceService';
import { getEpochKey } from '@/lib/roomKeyService';
import {
  getOrInitRatchetState,
  advanceRatchetChain,
  storeSkippedKey,
  consumeSkippedKey,
  RatchetStateV2,
} from '@/lib/ratchetV2';

export interface MessageDTOV2 {
  messageId: string;
  roomId: string;
  epoch: number;
  senderUid: string;
  senderDeviceId: string;
  ciphertext: string; // Base64 AES-256-GCM ciphertext
  iv: string; // Base64 12-byte IV
  timestamp: number;
  signature: string; // Base64 ECDSA signature over canonical message payload
}

export interface MessageDTOV3 {
  messageId: string;
  roomId: string;
  epoch: number;
  sequenceNumber: number;
  cryptoVersion: 'v3_ratchet';
  senderUid: string;
  senderDeviceId: string;
  ciphertext: string;
  iv: string;
  timestamp: number;
  signature: string;
}

export interface MessagePayloadToSign {
  ciphertext: string;
  epoch: number;
  iv: string;
  messageId: string;
  roomId: string;
  senderDeviceId: string;
  senderUid: string;
  timestamp: number;
}

export interface MessagePayloadToSignV3 {
  ciphertext: string;
  cryptoVersion: string;
  epoch: number;
  iv: string;
  messageId: string;
  roomId: string;
  senderDeviceId: string;
  senderUid: string;
  sequenceNumber: number;
  timestamp: number;
}

// In-memory seen-message ID set for local replay protection
const seenMessageIds = new Set<string>();

export function isReplayMessage(messageId: string): boolean {
  return seenMessageIds.has(messageId);
}

export function recordMessageSeen(messageId: string): void {
  seenMessageIds.add(messageId);
}

export function clearReplayCache(): void {
  seenMessageIds.clear();
}

/**
 * Constructs canonical AAD bytes for V2 messages.
 */
export function constructMessageAAD(params: {
  roomId: string;
  messageId: string;
  epoch: number;
  senderUid: string;
  senderDeviceId: string;
  timestamp: number;
}): Uint8Array {
  const aadObj = {
    epoch: params.epoch,
    messageId: params.messageId,
    roomId: params.roomId,
    senderDeviceId: params.senderDeviceId,
    senderUid: params.senderUid,
    timestamp: params.timestamp,
  };
  return new TextEncoder().encode(canonicalize(aadObj));
}

/**
 * Constructs canonical AAD bytes for V3 ratcheted messages.
 */
export function constructMessageAADV3(params: {
  cryptoVersion: string;
  epoch: number;
  messageId: string;
  roomId: string;
  senderDeviceId: string;
  senderUid: string;
  sequenceNumber: number;
  timestamp: number;
}): Uint8Array {
  const aadObj = {
    cryptoVersion: params.cryptoVersion,
    epoch: params.epoch,
    messageId: params.messageId,
    roomId: params.roomId,
    senderDeviceId: params.senderDeviceId,
    senderUid: params.senderUid,
    sequenceNumber: params.sequenceNumber,
    timestamp: params.timestamp,
  };
  return new TextEncoder().encode(canonicalize(aadObj));
}

/**
 * Signs canonical message payload for V2 messages.
 */
export async function signMessageV2(params: {
  payload: MessagePayloadToSign;
  senderIdentityPrivateKey: CryptoKey;
}): Promise<string> {
  const { payload, senderIdentityPrivateKey } = params;
  const canonicalBytes = new TextEncoder().encode(canonicalize(payload));
  const sigBuffer = await sign(senderIdentityPrivateKey, canonicalBytes);
  return arrayBufferToBase64(sigBuffer);
}

/**
 * Verifies a V2 message's ECDSA signature.
 */
export async function verifyMessageV2(params: {
  message: MessageDTOV2;
  senderIdentityPublicKey: JsonWebKey | CryptoKey;
}): Promise<boolean> {
  const { message, senderIdentityPublicKey } = params;

  const senderIdentityKey =
    senderIdentityPublicKey instanceof CryptoKey
      ? senderIdentityPublicKey
      : await importPublicKey(senderIdentityPublicKey, 'ECDSA');

  const payloadToSign: MessagePayloadToSign = {
    ciphertext: message.ciphertext,
    epoch: message.epoch,
    iv: message.iv,
    messageId: message.messageId,
    roomId: message.roomId,
    senderDeviceId: message.senderDeviceId,
    senderUid: message.senderUid,
    timestamp: message.timestamp,
  };

  const canonicalBytes = new TextEncoder().encode(canonicalize(payloadToSign));
  const sigBuffer = base64ToArrayBuffer(message.signature);

  return await verify(senderIdentityKey, sigBuffer, canonicalBytes);
}

/**
 * Verifies a V3 ratcheted message's ECDSA signature.
 */
export async function verifyMessageV3(params: {
  message: MessageDTOV3;
  senderIdentityPublicKey: JsonWebKey | CryptoKey;
}): Promise<boolean> {
  const { message, senderIdentityPublicKey } = params;

  const senderIdentityKey =
    senderIdentityPublicKey instanceof CryptoKey
      ? senderIdentityPublicKey
      : await importPublicKey(senderIdentityPublicKey, 'ECDSA');

  const payloadToSign: MessagePayloadToSignV3 = {
    ciphertext: message.ciphertext,
    cryptoVersion: message.cryptoVersion,
    epoch: message.epoch,
    iv: message.iv,
    messageId: message.messageId,
    roomId: message.roomId,
    senderDeviceId: message.senderDeviceId,
    senderUid: message.senderUid,
    sequenceNumber: message.sequenceNumber,
    timestamp: message.timestamp,
  };

  const canonicalBytes = new TextEncoder().encode(canonicalize(payloadToSign));
  const sigBuffer = base64ToArrayBuffer(message.signature);

  return await verify(senderIdentityKey, sigBuffer, canonicalBytes);
}

/**
 * Encrypts and signs a V2 message using the room master CryptoKey.
 */
export async function encryptMessageV2(params: {
  plaintext: string;
  roomId: string;
  senderUid: string;
  senderDeviceId: string;
  roomMasterKey: CryptoKey;
  senderIdentityPrivateKey: CryptoKey;
  messageId?: string;
  epoch?: number;
  timestamp?: number;
}): Promise<MessageDTOV2> {
  if (!isWebCryptoSupported()) {
    throw new Error('Web Crypto API is not supported in this environment.');
  }

  const {
    plaintext,
    roomId,
    senderUid,
    senderDeviceId,
    roomMasterKey,
    senderIdentityPrivateKey,
    messageId = typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    epoch = 1,
    timestamp = Date.now(),
  } = params;

  const ivBytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aadBytes = constructMessageAAD({
    roomId,
    messageId,
    epoch,
    senderUid,
    senderDeviceId,
    timestamp,
  });

  const plaintextBytes = new TextEncoder().encode(plaintext);
  const encryptedBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes,
      additionalData: aadBytes as unknown as BufferSource,
    },
    roomMasterKey,
    plaintextBytes
  );

  const ciphertext = arrayBufferToBase64(encryptedBuffer);
  const iv = arrayBufferToBase64(ivBytes);

  const payloadToSign: MessagePayloadToSign = {
    ciphertext,
    epoch,
    iv,
    messageId,
    roomId,
    senderDeviceId,
    senderUid,
    timestamp,
  };

  const signature = await signMessageV2({
    payload: payloadToSign,
    senderIdentityPrivateKey,
  });

  return {
    messageId,
    roomId,
    epoch,
    senderUid,
    senderDeviceId,
    ciphertext,
    iv,
    timestamp,
    signature,
  };
}

/**
 * Encrypts and signs a V3 ratcheted message using HKDF-derived per-message key material.
 */
export async function encryptMessageV3(params: {
  plaintext: string;
  roomId: string;
  epoch: number;
  senderUid: string;
  senderDeviceId: string;
  epochKey: CryptoKey;
  senderIdentityPrivateKey: CryptoKey;
  messageId?: string;
  timestamp?: number;
}): Promise<MessageDTOV3> {
  if (!isWebCryptoSupported()) {
    throw new Error('Web Crypto API is not supported in this environment.');
  }

  const {
    plaintext,
    roomId,
    epoch,
    senderUid,
    senderDeviceId,
    epochKey,
    senderIdentityPrivateKey,
    messageId = typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `msg_v3_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    timestamp = Date.now(),
  } = params;

  // 1. Get/init ratchet state and advance chain
  const ratchetState = await getOrInitRatchetState({
    roomId,
    epoch,
    senderDeviceId,
    epochKey,
    role: 'send',
  });

  const seqNum = ratchetState.sequenceNumber;
  const { messageKey } = await advanceRatchetChain(ratchetState, messageId);

  // 2. Generate fresh 12-byte IV
  const ivBytes = globalThis.crypto.getRandomValues(new Uint8Array(12));

  // 3. Construct AAD for V3
  const aadBytes = constructMessageAADV3({
    cryptoVersion: 'v3_ratchet',
    epoch,
    messageId,
    roomId,
    senderDeviceId,
    senderUid,
    sequenceNumber: seqNum,
    timestamp,
  });

  // 4. Encrypt with derived non-extractable per-message key
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const encryptedBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes,
      additionalData: aadBytes as unknown as BufferSource,
    },
    messageKey,
    plaintextBytes
  );

  const ciphertext = arrayBufferToBase64(encryptedBuffer);
  const iv = arrayBufferToBase64(ivBytes);

  // 5. Sign V3 message payload
  const payloadToSign: MessagePayloadToSignV3 = {
    ciphertext,
    cryptoVersion: 'v3_ratchet',
    epoch,
    iv,
    messageId,
    roomId,
    senderDeviceId,
    senderUid,
    sequenceNumber: seqNum,
    timestamp,
  };

  const canonicalBytes = new TextEncoder().encode(canonicalize(payloadToSign));
  const sigBuffer = await sign(senderIdentityPrivateKey, canonicalBytes);
  const signature = arrayBufferToBase64(sigBuffer);

  return {
    messageId,
    roomId,
    epoch,
    sequenceNumber: seqNum,
    cryptoVersion: 'v3_ratchet',
    senderUid,
    senderDeviceId,
    ciphertext,
    iv,
    timestamp,
    signature,
  };
}

/**
 * Decrypts a V2 message using room master key.
 */
export async function decryptMessageV2(params: {
  message: MessageDTOV2;
  roomMasterKey?: CryptoKey;
}): Promise<string> {
  const { message } = params;
  const keyToUse = params.roomMasterKey || getEpochKey(message.roomId, message.epoch);

  if (!keyToUse) {
    throw new Error(
      `No room key available for room '${message.roomId}' and epoch ${message.epoch}.`
    );
  }

  const ivBytes = base64ToArrayBuffer(message.iv);
  const ciphertextBytes = base64ToArrayBuffer(message.ciphertext);

  const aadBytes = constructMessageAAD({
    roomId: message.roomId,
    messageId: message.messageId,
    epoch: message.epoch,
    senderUid: message.senderUid,
    senderDeviceId: message.senderDeviceId,
    timestamp: message.timestamp,
  });

  try {
    const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
        additionalData: aadBytes as unknown as BufferSource,
      },
      keyToUse,
      ciphertextBytes
    );

    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    throw new Error('Failed to decrypt V2 message. Ciphertext, IV, or AAD context mismatch.');
  }
}

/**
 * Validates, authenticates, and decrypts an incoming V2 or V3 message following security flow.
 */
export async function receiveMessageV2(params: {
  message: MessageDTOV2 | MessageDTOV3;
  roomMasterKey?: CryptoKey;
  epochKey?: CryptoKey;
  senderDeviceBundle?: SignedDeviceIdentityBundle;
  fetchSenderDevice?: (uid: string, deviceId: string) => Promise<SignedDeviceIdentityBundle | null>;
}): Promise<string> {
  const { message, roomMasterKey, epochKey, senderDeviceBundle, fetchSenderDevice = getDevice } = params;

  // Handle V3 Ratcheted Message
  if ((message as any).cryptoVersion === 'v3_ratchet') {
    return await receiveMessageV3({
      message: message as MessageDTOV3,
      epochKey: epochKey || roomMasterKey,
      senderDeviceBundle,
      fetchSenderDevice,
    });
  }

  // Handle V2 Message
  const msgV2 = message as MessageDTOV2;

  if (
    !msgV2 ||
    !msgV2.messageId ||
    !msgV2.roomId ||
    typeof msgV2.epoch !== 'number' ||
    !msgV2.senderUid ||
    !msgV2.senderDeviceId ||
    !msgV2.ciphertext ||
    !msgV2.iv ||
    !msgV2.timestamp ||
    !msgV2.signature
  ) {
    throw new Error('Malformed V2 message structure: missing required fields.');
  }

  if (isReplayMessage(msgV2.messageId)) {
    throw new Error(`Replay attack detected: messageId '${msgV2.messageId}' has already been processed.`);
  }

  let deviceBundle = senderDeviceBundle;
  if (!deviceBundle) {
    const fetched = await fetchSenderDevice(msgV2.senderUid, msgV2.senderDeviceId);
    if (!fetched) {
      throw new Error(
        `Unknown or unregistered device '${msgV2.senderDeviceId}' for sender '${msgV2.senderUid}'.`
      );
    }
    deviceBundle = fetched;
  }

  if (deviceBundle.payload.deviceId !== msgV2.senderDeviceId) {
    throw new Error(
      `Sender deviceId mismatch: bundle deviceId '${deviceBundle.payload.deviceId}' vs message deviceId '${msgV2.senderDeviceId}'.`
    );
  }

  const isSigValid = await verifyMessageV2({
    message: msgV2,
    senderIdentityPublicKey: deviceBundle.payload.identityPublicKey,
  });

  if (!isSigValid) {
    throw new Error('V2 message ECDSA signature verification failed. Message may be forged or tampered.');
  }

  const plaintext = await decryptMessageV2({
    message: msgV2,
    roomMasterKey: roomMasterKey || epochKey,
  });

  recordMessageSeen(msgV2.messageId);
  return plaintext;
}

/**
 * Validates, authenticates, advances ratchet, and decrypts an incoming V3 ratcheted message.
 */
export async function receiveMessageV3(params: {
  message: MessageDTOV3;
  epochKey?: CryptoKey;
  senderDeviceBundle?: SignedDeviceIdentityBundle;
  fetchSenderDevice?: (uid: string, deviceId: string) => Promise<SignedDeviceIdentityBundle | null>;
}): Promise<string> {
  const { message, epochKey, senderDeviceBundle, fetchSenderDevice = getDevice } = params;

  if (
    !message ||
    message.cryptoVersion !== 'v3_ratchet' ||
    typeof message.sequenceNumber !== 'number' ||
    !message.messageId ||
    !message.roomId ||
    typeof message.epoch !== 'number' ||
    !message.senderUid ||
    !message.senderDeviceId ||
    !message.ciphertext ||
    !message.iv ||
    !message.timestamp ||
    !message.signature
  ) {
    throw new Error('Malformed V3 message structure: missing required fields.');
  }

  if (isReplayMessage(message.messageId)) {
    throw new Error(`Replay attack detected: messageId '${message.messageId}' has already been processed.`);
  }

  let deviceBundle = senderDeviceBundle;
  if (!deviceBundle) {
    const fetched = await fetchSenderDevice(message.senderUid, message.senderDeviceId);
    if (!fetched) {
      throw new Error(
        `Unknown or unregistered device '${message.senderDeviceId}' for sender '${message.senderUid}'.`
      );
    }
    deviceBundle = fetched;
  }

  if (deviceBundle.payload.deviceId !== message.senderDeviceId) {
    throw new Error(
      `Sender deviceId mismatch: bundle deviceId '${deviceBundle.payload.deviceId}' vs message deviceId '${message.senderDeviceId}'.`
    );
  }

  const isSigValid = await verifyMessageV3({
    message,
    senderIdentityPublicKey: deviceBundle.payload.identityPublicKey,
  });

  if (!isSigValid) {
    throw new Error('V3 message ECDSA signature verification failed. Message may be forged or tampered.');
  }

  // Resolve messageKey (check skipped keys store or advance ratchet chain)
  let msgKey = consumeSkippedKey(
    message.roomId,
    message.epoch,
    message.senderDeviceId,
    message.sequenceNumber
  );

  if (!msgKey) {
    const rootKey = epochKey || getEpochKey(message.roomId, message.epoch);
    if (!rootKey) {
      throw new Error(
        `No epoch key available for room '${message.roomId}' and epoch ${message.epoch}.`
      );
    }

    const state = await getOrInitRatchetState({
      roomId: message.roomId,
      epoch: message.epoch,
      senderDeviceId: message.senderDeviceId,
      epochKey: rootKey,
      role: 'recv',
    });

    if (message.sequenceNumber < state.sequenceNumber) {
      throw new Error(
        `Sequence number ${message.sequenceNumber} has already passed for active ratchet chain.`
      );
    }

    // Catch up out-of-order skipped keys
    while (state.sequenceNumber < message.sequenceNumber) {
      const skippedSeq = state.sequenceNumber;
      const { messageKey: skippedKey } = await advanceRatchetChain(
        state,
        `skipped_${message.roomId}_${message.epoch}_${skippedSeq}`
      );
      storeSkippedKey(
        message.roomId,
        message.epoch,
        message.senderDeviceId,
        skippedSeq,
        skippedKey
      );
    }

    // Derive target messageKey
    const { messageKey: targetKey } = await advanceRatchetChain(state, message.messageId);
    msgKey = targetKey;
  }

  // Decrypt ciphertext using messageKey and V3 AAD
  const ivBytes = base64ToArrayBuffer(message.iv);
  const ciphertextBytes = base64ToArrayBuffer(message.ciphertext);

  const aadBytes = constructMessageAADV3({
    cryptoVersion: 'v3_ratchet',
    epoch: message.epoch,
    messageId: message.messageId,
    roomId: message.roomId,
    senderDeviceId: message.senderDeviceId,
    senderUid: message.senderUid,
    sequenceNumber: message.sequenceNumber,
    timestamp: message.timestamp,
  });

  let plaintext: string;
  try {
    const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
        additionalData: aadBytes as unknown as BufferSource,
      },
      msgKey,
      ciphertextBytes
    );
    plaintext = new TextDecoder().decode(decryptedBuffer);
  } catch {
    throw new Error('Failed to decrypt V3 message. Ciphertext, IV, or AAD context mismatch.');
  }

  recordMessageSeen(message.messageId);
  return plaintext;
}

/**
 * Sends a V2 message by encrypting, signing, and writing to Firebase Realtime Database at /rooms/{roomId}/messages/{messageId}.
 */
export async function sendMessageV2(params: {
  plaintext: string;
  roomId: string;
  senderUid: string;
  senderDeviceId: string;
  roomMasterKey: CryptoKey;
  senderIdentityPrivateKey: CryptoKey;
  epoch?: number;
}): Promise<MessageDTOV2> {
  const {
    plaintext,
    roomId,
    senderUid,
    senderDeviceId,
    roomMasterKey,
    senderIdentityPrivateKey,
    epoch = 1,
  } = params;

  const message = await encryptMessageV2({
    plaintext,
    roomId,
    senderUid,
    senderDeviceId,
    roomMasterKey,
    senderIdentityPrivateKey,
    epoch,
  });

  const msgRef = ref(db, `rooms/${roomId}/messages/${message.messageId}`);
  await set(msgRef, message);

  recordMessageSeen(message.messageId);
  return message;
}

/**
 * Sends a V3 ratcheted message by encrypting, signing, and writing to Firebase Realtime Database at /rooms/{roomId}/messages/{messageId}.
 */
export async function sendMessageV3(params: {
  plaintext: string;
  roomId: string;
  epoch: number;
  senderUid: string;
  senderDeviceId: string;
  epochKey: CryptoKey;
  senderIdentityPrivateKey: CryptoKey;
}): Promise<MessageDTOV3> {
  const message = await encryptMessageV3(params);
  const msgRef = ref(db, `rooms/${params.roomId}/messages/${message.messageId}`);
  await set(msgRef, message);
  recordMessageSeen(message.messageId);
  return message;
}
