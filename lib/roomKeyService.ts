/**
 * Room Key Service for End-to-End Encryption (Phase 3 & Phase 5A)
 *
 * Implements generation of AES-256-GCM room master keys, key epoch management, key rotation,
 * key envelope wrapping using ECDH + HKDF-SHA256 + AES-GCM with AAD context binding (including epoch),
 * ECDSA signature authentication, unwrapping, verification, and V2 room initialization.
 */

import { ref, update, get } from 'firebase/database';
import { db } from '@/lib/firebase';
import {
  importPublicKey,
  sign,
  verify,
  canonicalize,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  isWebCryptoSupported,
} from '@/lib/cryptoV2';
import {
  getOrCreateDeviceIdentity,
  getDevice,
  getUserDevices,
} from '@/lib/deviceService';

export interface RoomKeyEnvelopeDTO {
  roomId: string;
  epoch: number; // Key rotation epoch
  deviceId: string; // Recipient device ID
  ownerUid: string; // Recipient user ID
  encryptedRoomKey: string; // Base64 ciphertext of exported raw room key
  iv: string; // Base64 AES-GCM IV (12 bytes)
  senderDeviceId: string; // Sender device ID
  senderUid: string; // Sender user ID
  signature: string; // Base64 ECDSA signature over canonical envelope payload
  createdAt: number;
}

export interface EnvelopePayloadToSign {
  createdAt: number;
  deviceId: string;
  encryptedRoomKey: string;
  epoch: number;
  iv: string;
  ownerUid: string;
  roomId: string;
  senderDeviceId: string;
  senderUid: string;
}

export interface TargetDeviceKeyInfo {
  uid: string;
  deviceId: string;
  exchangePublicKey: JsonWebKey | CryptoKey;
}

// In-memory epoch key cache mapping `${roomId}:${epoch}` -> CryptoKey handle
const epochKeyCache = new Map<string, CryptoKey>();

export function setEpochKey(roomId: string, epoch: number, key: CryptoKey): void {
  epochKeyCache.set(`${roomId}:${epoch}`, key);
}

export function getEpochKey(roomId: string, epoch: number): CryptoKey | undefined {
  return epochKeyCache.get(`${roomId}:${epoch}`);
}

export function clearEpochKeyCache(): void {
  epochKeyCache.clear();
}

/**
 * Generates a new random 256-bit AES-GCM room master key using Web Crypto API.
 */
export async function createRoomMasterKey(): Promise<CryptoKey> {
  if (!isWebCryptoSupported()) {
    throw new Error('Web Crypto API is not supported in this environment.');
  }
  return await globalThis.crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true, // extractable during initial creation so raw bytes can be wrapped into envelopes
    ['encrypt', 'decrypt']
  );
}

/**
 * Derives an envelope encryption key using ECDH shared secret + HKDF-SHA256 with epoch context binding.
 */
async function deriveEnvelopeEncryptionKey(
  recipientExchangePublicKey: CryptoKey,
  senderExchangePrivateKey: CryptoKey,
  roomId: string,
  epoch: number,
  recipientDeviceId: string,
  senderDeviceId: string
): Promise<CryptoKey> {
  // 1. Compute ECDH shared secret bits (256 bits)
  const sharedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: recipientExchangePublicKey,
    },
    senderExchangePrivateKey,
    256
  );

  // 2. Import shared bits into HKDF base key
  const hkdfBaseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    sharedBits,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );

  // 3. Info string context binding (incorporates epoch)
  const info = new TextEncoder().encode(
    `room_key_envelope_v2:${roomId}:${epoch}:${recipientDeviceId}:${senderDeviceId}`
  );

  // 4. Derive 256-bit AES-GCM envelope key
  return await globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // 32 zero-bytes salt
      info: info,
    },
    hkdfBaseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Wraps a room master key for a single recipient device using ECDH + HKDF-SHA256 + AES-GCM with AAD context binding (including epoch) and ECDSA signature authentication.
 */
export async function wrapRoomKeyForDevice(params: {
  roomId: string;
  epoch?: number;
  roomMasterKey: CryptoKey;
  recipientUid: string;
  recipientDeviceId: string;
  recipientExchangePublicKey: JsonWebKey | CryptoKey;
  senderUid: string;
  senderDeviceId: string;
  senderExchangePrivateKey: CryptoKey;
  senderIdentityPrivateKey: CryptoKey;
  createdAt?: number;
}): Promise<RoomKeyEnvelopeDTO> {
  const {
    roomId,
    epoch = 1,
    roomMasterKey,
    recipientUid,
    recipientDeviceId,
    recipientExchangePublicKey,
    senderUid,
    senderDeviceId,
    senderExchangePrivateKey,
    senderIdentityPrivateKey,
    createdAt = Date.now(),
  } = params;

  // Export raw room master key bytes
  const rawRoomKey = await globalThis.crypto.subtle.exportKey('raw', roomMasterKey);

  // Import recipient exchange key if given as JWK
  const recipientExchangeKey =
    recipientExchangePublicKey instanceof CryptoKey
      ? recipientExchangePublicKey
      : await importPublicKey(recipientExchangePublicKey, 'ECDH');

  // Derive envelope key via ECDH + HKDF (including epoch)
  const envelopeKey = await deriveEnvelopeEncryptionKey(
    recipientExchangeKey,
    senderExchangePrivateKey,
    roomId,
    epoch,
    recipientDeviceId,
    senderDeviceId
  );

  // Generate fresh random 12-byte IV for AES-GCM
  const ivBytes = globalThis.crypto.getRandomValues(new Uint8Array(12));

  // Additional Authenticated Data (AAD) binding context (incorporates epoch)
  const aadString = canonicalize({
    epoch,
    recipientDeviceId,
    roomId,
    senderDeviceId,
  });
  const aadBytes = new TextEncoder().encode(aadString);

  // Encrypt raw room master key using AES-GCM with AAD
  const encryptedBuffer = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes,
      additionalData: aadBytes as unknown as BufferSource,
    },
    envelopeKey,
    rawRoomKey
  );

  const encryptedRoomKey = arrayBufferToBase64(encryptedBuffer);
  const iv = arrayBufferToBase64(ivBytes);

  // Construct payload to sign deterministically (incorporates epoch)
  const payloadToSign: EnvelopePayloadToSign = {
    createdAt,
    deviceId: recipientDeviceId,
    encryptedRoomKey,
    epoch,
    iv,
    ownerUid: recipientUid,
    roomId,
    senderDeviceId,
    senderUid,
  };

  const canonicalBytes = new TextEncoder().encode(canonicalize(payloadToSign));
  const sigBuffer = await sign(senderIdentityPrivateKey, canonicalBytes);
  const signature = arrayBufferToBase64(sigBuffer);

  return {
    roomId,
    epoch,
    deviceId: recipientDeviceId,
    ownerUid: recipientUid,
    encryptedRoomKey,
    iv,
    senderDeviceId,
    senderUid,
    signature,
    createdAt,
  };
}

/**
 * Verifies the ECDSA signature on a room key envelope against the sender's identity public key.
 */
export async function verifyRoomKeyEnvelope(
  envelope: RoomKeyEnvelopeDTO,
  senderIdentityPublicKey: JsonWebKey | CryptoKey
): Promise<boolean> {
  const senderIdentityKey =
    senderIdentityPublicKey instanceof CryptoKey
      ? senderIdentityPublicKey
      : await importPublicKey(senderIdentityPublicKey, 'ECDSA');

  const epoch = envelope.epoch || 1;

  const payloadToSign: EnvelopePayloadToSign = {
    createdAt: envelope.createdAt,
    deviceId: envelope.deviceId,
    encryptedRoomKey: envelope.encryptedRoomKey,
    epoch,
    iv: envelope.iv,
    ownerUid: envelope.ownerUid,
    roomId: envelope.roomId,
    senderDeviceId: envelope.senderDeviceId,
    senderUid: envelope.senderUid,
  };

  const canonicalBytes = new TextEncoder().encode(canonicalize(payloadToSign));
  const sigBuffer = base64ToArrayBuffer(envelope.signature);

  return await verify(senderIdentityKey, sigBuffer, canonicalBytes);
}

/**
 * Unwraps a room master key envelope for the recipient device.
 * Validates recipient deviceId, epoch, signature, AAD context, and returns a non-extractable room master CryptoKey.
 */
export async function unwrapRoomKey(params: {
  envelope: RoomKeyEnvelopeDTO;
  expectedDeviceId: string;
  expectedEpoch?: number;
  recipientExchangePrivateKey: CryptoKey;
  senderIdentityPublicKey: JsonWebKey | CryptoKey;
  senderExchangePublicKey: JsonWebKey | CryptoKey;
}): Promise<CryptoKey> {
  const {
    envelope,
    expectedDeviceId,
    expectedEpoch,
    recipientExchangePrivateKey,
    senderIdentityPublicKey,
    senderExchangePublicKey,
  } = params;

  const epoch = envelope.epoch || 1;

  // 1. Verify recipient deviceId matches expecting device
  if (envelope.deviceId !== expectedDeviceId) {
    throw new Error(
      `Envelope recipient deviceId mismatch: expected '${expectedDeviceId}', got '${envelope.deviceId}'.`
    );
  }

  // 2. Verify epoch matches expecting epoch if specified
  if (expectedEpoch !== undefined && epoch !== expectedEpoch) {
    throw new Error(
      `Envelope epoch mismatch: expected '${expectedEpoch}', got '${epoch}'.`
    );
  }

  // 3. Verify signature using sender's identity public key
  const isSignatureValid = await verifyRoomKeyEnvelope(envelope, senderIdentityPublicKey);
  if (!isSignatureValid) {
    throw new Error('Room key envelope signature verification failed. Envelope payload or epoch may be tampered.');
  }

  // 4. Import sender's exchange public key
  const senderExchangeKey =
    senderExchangePublicKey instanceof CryptoKey
      ? senderExchangePublicKey
      : await importPublicKey(senderExchangePublicKey, 'ECDH');

  // 5. Derive envelope key via ECDH + HKDF (including epoch)
  const envelopeKey = await deriveEnvelopeEncryptionKey(
    senderExchangeKey,
    recipientExchangePrivateKey,
    envelope.roomId,
    epoch,
    envelope.deviceId,
    envelope.senderDeviceId
  );

  // 6. Construct AAD for decryption (including epoch)
  const aadString = canonicalize({
    epoch,
    recipientDeviceId: envelope.deviceId,
    roomId: envelope.roomId,
    senderDeviceId: envelope.senderDeviceId,
  });
  const aadBytes = new TextEncoder().encode(aadString);
  const ivBytes = base64ToArrayBuffer(envelope.iv);
  const encryptedBytes = base64ToArrayBuffer(envelope.encryptedRoomKey);

  // 7. Decrypt raw room key bytes (AES-GCM checks authentication tag and AAD)
  let rawRoomKeyBuffer: ArrayBuffer;
  try {
    rawRoomKeyBuffer = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
        additionalData: aadBytes as unknown as BufferSource,
      },
      envelopeKey,
      encryptedBytes
    );
  } catch (err) {
    throw new Error('Failed to decrypt room key envelope. Ciphertext, IV, epoch, or AAD context may be invalid or tampered.');
  }

  // 8. Import raw room key bytes into non-extractable AES-256-GCM CryptoKey
  const roomMasterKey = await globalThis.crypto.subtle.importKey(
    'raw',
    rawRoomKeyBuffer,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable once unwrapped
    ['encrypt', 'decrypt']
  );

  // Cache unwrapped key in local epochKeyCache
  setEpochKey(envelope.roomId, epoch, roomMasterKey);

  return roomMasterKey;
}

/**
 * Foundation helper for creating a new V2 room with version marker "v2_e2ee", initial currentEpoch = 1, and atomic key envelope distribution to member devices.
 */
export async function createV2Room(params: {
  roomId: string;
  participants: string[];
  targetDevices: TargetDeviceKeyInfo[];
  senderInfo: {
    uid: string;
    deviceId: string;
    identityPrivateKey: CryptoKey;
    exchangePrivateKey: CryptoKey;
  };
}): Promise<{
  roomMasterKey: CryptoKey;
  envelopes: RoomKeyEnvelopeDTO[];
}> {
  const { roomId, participants, targetDevices, senderInfo } = params;

  if (!roomId || !participants.length || !targetDevices.length) {
    throw new Error('Invalid V2 room parameters: roomId, participants, and targetDevices are required.');
  }

  // 1. Generate room master key for epoch 1
  const roomMasterKey = await createRoomMasterKey();

  // 2. Wrap room key envelope for every target device (epoch 1)
  const envelopes: RoomKeyEnvelopeDTO[] = [];
  const now = Date.now();

  for (const device of targetDevices) {
    const envelope = await wrapRoomKeyForDevice({
      roomId,
      epoch: 1,
      roomMasterKey,
      recipientUid: device.uid,
      recipientDeviceId: device.deviceId,
      recipientExchangePublicKey: device.exchangePublicKey,
      senderUid: senderInfo.uid,
      senderDeviceId: senderInfo.deviceId,
      senderExchangePrivateKey: senderInfo.exchangePrivateKey,
      senderIdentityPrivateKey: senderInfo.identityPrivateKey,
      createdAt: now,
    });
    envelopes.push(envelope);
  }

  // 3. Write V2 room metadata and key envelopes atomically to Firebase
  const updates: Record<string, any> = {};
  updates[`rooms/${roomId}/meta/version`] = 'v2_e2ee';
  updates[`rooms/${roomId}/meta/currentEpoch`] = 1;
  updates[`rooms/${roomId}/meta/participants`] = participants;
  updates[`rooms/${roomId}/meta/createdAt`] = now;

  for (const env of envelopes) {
    updates[`rooms/${roomId}/keyEnvelopes/1/${env.deviceId}`] = env;
    // Also write to legacy path for Phase 3 backward compatibility
    updates[`rooms/${roomId}/keyEnvelopes/${env.deviceId}`] = env;
  }

  await update(ref(db), updates);

  // Cache epoch 1 key locally
  setEpochKey(roomId, 1, roomMasterKey);

  return { roomMasterKey, envelopes };
}

/**
 * Rotates the room master key for a V2 room by generating a completely new random AES-256-GCM key for nextEpoch and distributing signed envelopes to currently authorized devices.
 */
export async function rotateRoomKey(params: {
  roomId: string;
  authorizedDevices: TargetDeviceKeyInfo[];
  senderInfo: {
    uid: string;
    deviceId: string;
    identityPrivateKey: CryptoKey;
    exchangePrivateKey: CryptoKey;
  };
}): Promise<{
  nextEpoch: number;
  roomMasterKey: CryptoKey;
  envelopes: RoomKeyEnvelopeDTO[];
}> {
  const { roomId, authorizedDevices, senderInfo } = params;

  if (!roomId || !authorizedDevices.length) {
    throw new Error('Cannot rotate room key: roomId and authorizedDevices are required.');
  }

  // 1. Read room metadata
  const metaRef = ref(db, `rooms/${roomId}/meta`);
  const metaSnapshot = await get(metaRef);

  if (!metaSnapshot.exists()) {
    throw new Error(`Cannot rotate room key: Room '${roomId}' does not exist.`);
  }

  const metaData = metaSnapshot.val();
  const participants: string[] = metaData.participants || [];

  if (!participants.includes(senderInfo.uid)) {
    throw new Error(`User '${senderInfo.uid}' is not an authorized participant of room '${roomId}'.`);
  }

  const currentEpoch = typeof metaData.currentEpoch === 'number' ? metaData.currentEpoch : 1;
  const nextEpoch = currentEpoch + 1;

  // 2. Check if epoch already exists in Firebase to prevent overwriting
  const epochCheckRef = ref(db, `rooms/${roomId}/keyEnvelopes/${nextEpoch}`);
  const epochCheckSnapshot = await get(epochCheckRef);
  if (epochCheckSnapshot.exists()) {
    throw new Error(`Cannot recreate existing epoch ${nextEpoch} for room '${roomId}'.`);
  }

  // 3. Generate a completely NEW random 256-bit AES-GCM room key for nextEpoch
  const roomMasterKey = await createRoomMasterKey();

  // 4. Wrap envelope for every currently authorized device
  const envelopes: RoomKeyEnvelopeDTO[] = [];
  const now = Date.now();

  for (const device of authorizedDevices) {
    const envelope = await wrapRoomKeyForDevice({
      roomId,
      epoch: nextEpoch,
      roomMasterKey,
      recipientUid: device.uid,
      recipientDeviceId: device.deviceId,
      recipientExchangePublicKey: device.exchangePublicKey,
      senderUid: senderInfo.uid,
      senderDeviceId: senderInfo.deviceId,
      senderExchangePrivateKey: senderInfo.exchangePrivateKey,
      senderIdentityPrivateKey: senderInfo.identityPrivateKey,
      createdAt: now,
    });
    envelopes.push(envelope);
  }

  // 5. Write new epoch metadata and envelopes atomically to Firebase
  const updates: Record<string, any> = {};
  updates[`rooms/${roomId}/meta/currentEpoch`] = nextEpoch;
  for (const env of envelopes) {
    updates[`rooms/${roomId}/keyEnvelopes/${nextEpoch}/${env.deviceId}`] = env;
  }

  await update(ref(db), updates);

  // 6. Cache new epoch key locally
  setEpochKey(roomId, nextEpoch, roomMasterKey);

  return {
    nextEpoch,
    roomMasterKey,
    envelopes,
  };
}

/**
 * Fetches a key envelope for a specific device and epoch from Firebase.
 */
export async function getRoomKeyEnvelope(
  roomId: string,
  deviceId: string,
  epoch?: number
): Promise<RoomKeyEnvelopeDTO | null> {
  if (epoch !== undefined) {
    const envRef = ref(db, `rooms/${roomId}/keyEnvelopes/${epoch}/${deviceId}`);
    const snapshot = await get(envRef);
    if (snapshot.exists()) {
      return snapshot.val() as RoomKeyEnvelopeDTO;
    }
    return null;
  }

  // Fallback to legacy unnested path (epoch 1) when epoch is omitted
  const legacyEnvRef = ref(db, `rooms/${roomId}/keyEnvelopes/${deviceId}`);
  const snapshot = await get(legacyEnvRef);

  if (!snapshot.exists()) {
    return null;
  }

  const dto = snapshot.val() as RoomKeyEnvelopeDTO;
  return {
    ...dto,
    epoch: dto.epoch || 1,
  };
}

export interface AcquiredV2RoomKey {
  roomMasterKey: CryptoKey;
  epoch: number;
  deviceId: string;
  identityPrivateKey: CryptoKey;
}

/**
 * Checks whether a room is configured as a V2 E2EE room.
 */
export async function isV2Room(roomId: string): Promise<boolean> {
  try {
    const snap = await get(ref(db, `rooms/${roomId}/meta/version`));
    return snap.exists() && snap.val() === 'v2_e2ee';
  } catch {
    return false;
  }
}

/**
 * Automatically acquires and unwraps the V2 room key for the current device.
 * Reads room metadata to determine currentEpoch, finds the envelope for this device,
 * verifies sender's device bundle and signature, and unwraps the AES-256-GCM room key.
 * Throws user-friendly error on failure.
 */
export async function acquireV2RoomKey(
  roomId: string,
  expectedEpoch?: number
): Promise<AcquiredV2RoomKey> {
  const { record } = await getOrCreateDeviceIdentity();
  const deviceId = record.deviceId;

  let epoch = expectedEpoch;
  if (epoch === undefined) {
    const metaSnap = await get(ref(db, `rooms/${roomId}/meta`));
    if (!metaSnap.exists()) {
      throw new Error('Unable to unlock this encrypted conversation on this device.');
    }
    const meta = metaSnap.val();
    epoch = typeof meta.currentEpoch === 'number' ? meta.currentEpoch : 1;
  }

  // 1. Look up envelope for this device
  let envelope = await getRoomKeyEnvelope(roomId, deviceId, epoch);
  if (!envelope && epoch === 1) {
    envelope = await getRoomKeyEnvelope(roomId, deviceId);
  }

  if (!envelope) {
    throw new Error('Unable to unlock this encrypted conversation on this device.');
  }

  // 2. Fetch sender device public bundle
  const senderBundle = await getDevice(envelope.senderUid, envelope.senderDeviceId);
  if (!senderBundle) {
    throw new Error('Unable to unlock this encrypted conversation on this device.');
  }

  // 3. Unwrap room key envelope
  const finalEpoch = envelope.epoch || epoch || 1;
  const roomMasterKey = await unwrapRoomKey({
    envelope,
    expectedDeviceId: deviceId,
    recipientExchangePrivateKey: record.exchangePrivateKey,
    senderExchangePublicKey: senderBundle.payload.exchangePublicKey,
    senderIdentityPublicKey: senderBundle.payload.identityPublicKey,
    expectedEpoch: finalEpoch,
  });

  return {
    roomMasterKey,
    epoch: finalEpoch,
    deviceId,
    identityPrivateKey: record.identityPrivateKey,
  };
}

/**
 * Ensures that all registered devices for room participants have valid room key envelopes for currentEpoch.
 * If any participant device is missing an envelope, this wraps and writes the envelope.
 */
export async function ensureRoomKeyEnvelopesForMembers(params: {
  roomId: string;
  roomMasterKey: CryptoKey;
  currentEpoch: number;
  myUid: string;
  otherUid: string;
}): Promise<void> {
  const { roomId, roomMasterKey, currentEpoch, myUid, otherUid } = params;
  try {
    const { record } = await getOrCreateDeviceIdentity();
    const otherDevices = await getUserDevices(otherUid);
    if (!otherDevices || otherDevices.length === 0) return;

    const now = Date.now();
    const updates: Record<string, any> = {};
    let needsUpdate = false;

    for (const dev of otherDevices) {
      const devId = dev.payload.deviceId;
      const existing = await getRoomKeyEnvelope(roomId, devId, currentEpoch);
      if (!existing) {
        const envelope = await wrapRoomKeyForDevice({
          roomId,
          epoch: currentEpoch,
          roomMasterKey,
          recipientUid: otherUid,
          recipientDeviceId: devId,
          recipientExchangePublicKey: dev.payload.exchangePublicKey,
          senderUid: myUid,
          senderDeviceId: record.deviceId,
          senderExchangePrivateKey: record.exchangePrivateKey,
          senderIdentityPrivateKey: record.identityPrivateKey,
          createdAt: now,
        });

        updates[`rooms/${roomId}/keyEnvelopes/${currentEpoch}/${devId}`] = envelope;
        if (currentEpoch === 1) {
          updates[`rooms/${roomId}/keyEnvelopes/${devId}`] = envelope;
        }
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      await update(ref(db), updates);
    }
  } catch (err) {
    console.warn('[ensureRoomKeyEnvelopesForMembers] non-blocking error:', err);
  }
}
