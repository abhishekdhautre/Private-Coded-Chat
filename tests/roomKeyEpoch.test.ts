import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockDbStore: Record<string, any> = {};

vi.mock('firebase/database', () => ({
  getDatabase: vi.fn(() => ({})),
  ref: (_db: any, path?: string) => ({ path: path || '' }),
  get: vi.fn(async (refObj: { path: string }) => {
    if (refObj.path in mockDbStore) {
      return {
        exists: () => true,
        val: () => mockDbStore[refObj.path],
      };
    }
    const prefix = refObj.path.endsWith('/') ? refObj.path : refObj.path + '/';
    const childKeys = Object.keys(mockDbStore).filter((k) => k.startsWith(prefix));
    if (childKeys.length > 0) {
      const parentObj: Record<string, any> = {};
      for (const key of childKeys) {
        const subKey = key.slice(prefix.length);
        parentObj[subKey] = mockDbStore[key];
      }
      return {
        exists: () => true,
        val: () => parentObj,
      };
    }
    return {
      exists: () => false,
      val: () => null,
    };
  }),
  update: vi.fn(async (_refObj: any, updates: Record<string, any>) => {
    for (const [key, value] of Object.entries(updates)) {
      mockDbStore[key] = value;
    }
  }),
}));

import {
  createRoomMasterKey,
  wrapRoomKeyForDevice,
  unwrapRoomKey,
  verifyRoomKeyEnvelope,
  createV2Room,
  rotateRoomKey,
  getRoomKeyEnvelope,
  clearEpochKeyCache,
  getEpochKey,
  RoomKeyEnvelopeDTO,
} from '@/lib/roomKeyService';
import {
  encryptMessageV2,
  decryptMessageV2,
  clearReplayCache,
} from '@/lib/messageCryptoV2';
import {
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  exportPublicKey,
} from '@/lib/cryptoV2';

describe('Phase 5A Room Key Epochs and Key Rotation', () => {
  beforeEach(() => {
    clearEpochKeyCache();
    clearReplayCache();
    for (const key of Object.keys(mockDbStore)) {
      delete mockDbStore[key];
    }
  });

  it('initializes V2 room with currentEpoch = 1', async () => {
    const roomId = 'room_epoch_init_1';
    const aliceUid = 'alice_uid';
    const bobUid = 'bob_uid';

    const aliceIdentity = await generateIdentityKeyPair();
    const aliceExchange = await generateExchangeKeyPair();
    const bobExchange = await generateExchangeKeyPair();

    const aliceExchangeJwk = await exportPublicKey(aliceExchange.publicKey);
    const bobExchangeJwk = await exportPublicKey(bobExchange.publicKey);

    const { roomMasterKey, envelopes } = await createV2Room({
      roomId,
      participants: [aliceUid, bobUid],
      targetDevices: [
        { uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceExchangeJwk },
        { uid: bobUid, deviceId: 'bob_phone', exchangePublicKey: bobExchangeJwk },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceIdentity.privateKey,
        exchangePrivateKey: aliceExchange.privateKey,
      },
    });

    expect(roomMasterKey).toBeDefined();
    expect(envelopes).toHaveLength(2);
    expect(mockDbStore[`rooms/${roomId}/meta/currentEpoch`]).toBe(1);
    expect(mockDbStore[`rooms/${roomId}/meta/version`]).toBe('v2_e2ee');
    expect(envelopes[0].epoch).toBe(1);
    expect(getEpochKey(roomId, 1)).toBeDefined();
  });

  it('rotates room key and advances currentEpoch to 2 with a new random key', async () => {
    const roomId = 'room_rotate_test_1';
    const aliceUid = 'alice_uid';
    const bobUid = 'bob_uid';

    const aliceIdentity = await generateIdentityKeyPair();
    const aliceExchange = await generateExchangeKeyPair();
    const bobExchange = await generateExchangeKeyPair();

    const aliceExchangeJwk = await exportPublicKey(aliceExchange.publicKey);
    const bobExchangeJwk = await exportPublicKey(bobExchange.publicKey);

    // Initial creation (Epoch 1)
    const { roomMasterKey: epoch1Key } = await createV2Room({
      roomId,
      participants: [aliceUid, bobUid],
      targetDevices: [
        { uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceExchangeJwk },
        { uid: bobUid, deviceId: 'bob_phone', exchangePublicKey: bobExchangeJwk },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceIdentity.privateKey,
        exchangePrivateKey: aliceExchange.privateKey,
      },
    });

    // Rotation (Epoch 2)
    const { nextEpoch, roomMasterKey: epoch2Key, envelopes: epoch2Envelopes } = await rotateRoomKey({
      roomId,
      authorizedDevices: [
        { uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceExchangeJwk },
        { uid: bobUid, deviceId: 'bob_phone', exchangePublicKey: bobExchangeJwk },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceIdentity.privateKey,
        exchangePrivateKey: aliceExchange.privateKey,
      },
    });

    expect(nextEpoch).toBe(2);
    expect(mockDbStore[`rooms/${roomId}/meta/currentEpoch`]).toBe(2);
    expect(epoch2Envelopes[0].epoch).toBe(2);
    expect(mockDbStore[`rooms/${roomId}/keyEnvelopes/2/alice_phone`]).toBeDefined();
    expect(mockDbStore[`rooms/${roomId}/keyEnvelopes/2/bob_phone`]).toBeDefined();

    // Export raw bytes to prove Epoch 1 and Epoch 2 keys are different
    const rawEpoch1 = await globalThis.crypto.subtle.exportKey('raw', epoch1Key);
    const rawEpoch2 = await globalThis.crypto.subtle.exportKey('raw', epoch2Key);
    expect(new Uint8Array(rawEpoch1)).not.toEqual(new Uint8Array(rawEpoch2));
  });

  it('includes epoch in envelope signature and rejects tampered epoch', async () => {
    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();
    const recipientExchange = await generateExchangeKeyPair();
    const roomMasterKey = await createRoomMasterKey();

    const envelope = await wrapRoomKeyForDevice({
      roomId: 'room_tamper_epoch',
      epoch: 2,
      roomMasterKey,
      recipientUid: 'bob_uid',
      recipientDeviceId: 'bob_phone',
      recipientExchangePublicKey: await exportPublicKey(recipientExchange.publicKey),
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      senderExchangePrivateKey: senderExchange.privateKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    expect(envelope.epoch).toBe(2);

    // Verify valid envelope signature
    const isValid = await verifyRoomKeyEnvelope(
      envelope,
      await exportPublicKey(senderIdentity.publicKey)
    );
    expect(isValid).toBe(true);

    // Tamper epoch in envelope DTO
    const tamperedEnvelope: RoomKeyEnvelopeDTO = {
      ...envelope,
      epoch: 3,
    };

    const isTamperedValid = await verifyRoomKeyEnvelope(
      tamperedEnvelope,
      await exportPublicKey(senderIdentity.publicKey)
    );
    expect(isTamperedValid).toBe(false);

    await expect(
      unwrapRoomKey({
        envelope: tamperedEnvelope,
        expectedDeviceId: 'bob_phone',
        expectedEpoch: 3,
        recipientExchangePrivateKey: recipientExchange.privateKey,
        senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
        senderExchangePublicKey: await exportPublicKey(senderExchange.publicKey),
      })
    ).rejects.toThrow();
  });

  it('includes epoch in envelope AAD context', async () => {
    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();
    const recipientExchange = await generateExchangeKeyPair();
    const roomMasterKey = await createRoomMasterKey();

    const envelope = await wrapRoomKeyForDevice({
      roomId: 'room_aad_epoch',
      epoch: 2,
      roomMasterKey,
      recipientUid: 'bob_uid',
      recipientDeviceId: 'bob_phone',
      recipientExchangePublicKey: await exportPublicKey(recipientExchange.publicKey),
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      senderExchangePrivateKey: senderExchange.privateKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    // Attempting to unwrap with expectedEpoch mismatch throws error
    await expect(
      unwrapRoomKey({
        envelope,
        expectedDeviceId: 'bob_phone',
        expectedEpoch: 1, // Wrong epoch
        recipientExchangePrivateKey: recipientExchange.privateKey,
        senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
        senderExchangePublicKey: await exportPublicKey(senderExchange.publicKey),
      })
    ).rejects.toThrow(/epoch mismatch/i);
  });

  it('excludes removed devices from receiving new epoch envelopes', async () => {
    const roomId = 'room_revoke_device';
    const aliceUid = 'alice_uid';
    const bobUid = 'bob_uid';

    const aliceIdentity = await generateIdentityKeyPair();
    const aliceExchange = await generateExchangeKeyPair();
    const bobDev1Exchange = await generateExchangeKeyPair();
    const bobDev2Exchange = await generateExchangeKeyPair(); // Bob's compromised second device

    const aliceExchangeJwk = await exportPublicKey(aliceExchange.publicKey);
    const bobDev1Jwk = await exportPublicKey(bobDev1Exchange.publicKey);
    const bobDev2Jwk = await exportPublicKey(bobDev2Exchange.publicKey);

    // Initial Epoch 1 with Bob Dev 1 and Bob Dev 2
    await createV2Room({
      roomId,
      participants: [aliceUid, bobUid],
      targetDevices: [
        { uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceExchangeJwk },
        { uid: bobUid, deviceId: 'bob_phone', exchangePublicKey: bobDev1Jwk },
        { uid: bobUid, deviceId: 'bob_old_laptop', exchangePublicKey: bobDev2Jwk },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceIdentity.privateKey,
        exchangePrivateKey: aliceExchange.privateKey,
      },
    });

    expect(mockDbStore[`rooms/${roomId}/keyEnvelopes/1/bob_old_laptop`]).toBeDefined();

    // Rotate to Epoch 2, removing Bob's old laptop from authorizedDevices
    await rotateRoomKey({
      roomId,
      authorizedDevices: [
        { uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceExchangeJwk },
        { uid: bobUid, deviceId: 'bob_phone', exchangePublicKey: bobDev1Jwk },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceIdentity.privateKey,
        exchangePrivateKey: aliceExchange.privateKey,
      },
    });

    // Epoch 2 envelopes
    expect(mockDbStore[`rooms/${roomId}/keyEnvelopes/2/alice_phone`]).toBeDefined();
    expect(mockDbStore[`rooms/${roomId}/keyEnvelopes/2/bob_phone`]).toBeDefined();

    // Removed device DOES NOT receive Epoch 2 envelope
    expect(mockDbStore[`rooms/${roomId}/keyEnvelopes/2/bob_old_laptop`]).toBeUndefined();

    const bobOldLaptopEpoch2Env = await getRoomKeyEnvelope(roomId, 'bob_old_laptop', 2);
    expect(bobOldLaptopEpoch2Env).toBeNull();
  });

  it('prevents silent overwrite of an existing epoch', async () => {
    const roomId = 'room_no_overwrite';
    const aliceUid = 'alice_uid';

    const aliceIdentity = await generateIdentityKeyPair();
    const aliceExchange = await generateExchangeKeyPair();
    const aliceExchangeJwk = await exportPublicKey(aliceExchange.publicKey);

    await createV2Room({
      roomId,
      participants: [aliceUid],
      targetDevices: [{ uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceExchangeJwk }],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceIdentity.privateKey,
        exchangePrivateKey: aliceExchange.privateKey,
      },
    });

    // First rotation to Epoch 2
    await rotateRoomKey({
      roomId,
      authorizedDevices: [{ uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceExchangeJwk }],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceIdentity.privateKey,
        exchangePrivateKey: aliceExchange.privateKey,
      },
    });

    expect(mockDbStore[`rooms/${roomId}/meta/currentEpoch`]).toBe(2);

    // Manually setting currentEpoch back to 1 and attempting rotation to Epoch 2 again fails
    mockDbStore[`rooms/${roomId}/meta/currentEpoch`] = 1;

    await expect(
      rotateRoomKey({
        roomId,
        authorizedDevices: [{ uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceExchangeJwk }],
        senderInfo: {
          uid: aliceUid,
          deviceId: 'alice_phone',
          identityPrivateKey: aliceIdentity.privateKey,
          exchangePrivateKey: aliceExchange.privateKey,
        },
      })
    ).rejects.toThrow(/existing epoch 2/i);
  });

  it('keeps old epoch key usable for old messages while new epoch key is required for new messages', async () => {
    const roomId = 'room_msg_epoch_compat';
    const aliceUid = 'alice_uid';
    const bobUid = 'bob_uid';

    const aliceIdentity = await generateIdentityKeyPair();
    const aliceExchange = await generateExchangeKeyPair();
    const bobExchange = await generateExchangeKeyPair();

    const aliceExchangeJwk = await exportPublicKey(aliceExchange.publicKey);
    const bobExchangeJwk = await exportPublicKey(bobExchange.publicKey);

    // Epoch 1 Creation
    const { roomMasterKey: epoch1Key } = await createV2Room({
      roomId,
      participants: [aliceUid, bobUid],
      targetDevices: [
        { uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceExchangeJwk },
        { uid: bobUid, deviceId: 'bob_phone', exchangePublicKey: bobExchangeJwk },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceIdentity.privateKey,
        exchangePrivateKey: aliceExchange.privateKey,
      },
    });

    // Encrypt Message under Epoch 1
    const epoch1Message = await encryptMessageV2({
      plaintext: 'Old message encrypted under Epoch 1',
      roomId,
      epoch: 1,
      senderUid: aliceUid,
      senderDeviceId: 'alice_phone',
      roomMasterKey: epoch1Key,
      senderIdentityPrivateKey: aliceIdentity.privateKey,
    });

    // Rotate to Epoch 2
    const { roomMasterKey: epoch2Key } = await rotateRoomKey({
      roomId,
      authorizedDevices: [
        { uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceExchangeJwk },
        { uid: bobUid, deviceId: 'bob_phone', exchangePublicKey: bobExchangeJwk },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceIdentity.privateKey,
        exchangePrivateKey: aliceExchange.privateKey,
      },
    });

    // Encrypt Message under Epoch 2
    const epoch2Message = await encryptMessageV2({
      plaintext: 'New message encrypted under Epoch 2',
      roomId,
      epoch: 2,
      senderUid: aliceUid,
      senderDeviceId: 'alice_phone',
      roomMasterKey: epoch2Key,
      senderIdentityPrivateKey: aliceIdentity.privateKey,
    });

    // 1. Old message decrypts using Epoch 1 key
    const decryptedOld = await decryptMessageV2({
      message: epoch1Message,
      roomMasterKey: epoch1Key,
    });
    expect(decryptedOld).toBe('Old message encrypted under Epoch 1');

    // 2. New message decrypts using Epoch 2 key
    const decryptedNew = await decryptMessageV2({
      message: epoch2Message,
      roomMasterKey: epoch2Key,
    });
    expect(decryptedNew).toBe('New message encrypted under Epoch 2');

    // 3. Attempting to decrypt Epoch 2 message with Epoch 1 key FAILS
    await expect(
      decryptMessageV2({
        message: epoch2Message,
        roomMasterKey: epoch1Key,
      })
    ).rejects.toThrow();
  });

  it('verifies that no raw room key appears in stored epoch envelopes or room metadata', async () => {
    const roomId = 'room_raw_check';
    const aliceUid = 'alice_uid';

    const aliceIdentity = await generateIdentityKeyPair();
    const aliceExchange = await generateExchangeKeyPair();

    const { envelopes } = await createV2Room({
      roomId,
      participants: [aliceUid],
      targetDevices: [
        { uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: await exportPublicKey(aliceExchange.publicKey) },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceIdentity.privateKey,
        exchangePrivateKey: aliceExchange.privateKey,
      },
    });

    const env = envelopes[0];
    expect((env as any).rawKey).toBeUndefined();
    expect((env as any).roomMasterKey).toBeUndefined();
    expect((env as any).privateKey).toBeUndefined();
    expect(JSON.stringify(mockDbStore)).not.toContain('rawKey');
  });
});
