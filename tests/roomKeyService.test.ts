import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockDbStore: Record<string, any> = {};

vi.mock('firebase/database', () => ({
  getDatabase: vi.fn(() => ({})),
  ref: (_db: any, path?: string) => ({ path: path || '' }),
  get: vi.fn(async (refObj: { path: string }) => ({
    exists: () => refObj.path in mockDbStore,
    val: () => mockDbStore[refObj.path] || null,
  })),
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
  getRoomKeyEnvelope,
  RoomKeyEnvelopeDTO,
} from '@/lib/roomKeyService';
import {
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  exportPublicKey,
} from '@/lib/cryptoV2';

describe('Phase 3 Room Key Envelope Infrastructure', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockDbStore)) {
      delete mockDbStore[key];
    }
  });

  it('generates a random 256-bit AES-GCM room master key', async () => {
    const key = await createRoomMasterKey();
    expect(key.algorithm.name).toBe('AES-GCM');
    expect((key.algorithm as AesKeyAlgorithm).length).toBe(256);
    expect(key.type).toBe('secret');
  });

  it('wraps, signs, and unwraps room master key for a device', async () => {
    const roomId = 'room_v2_test_100';
    const senderUid = 'user_sender_1';
    const senderDeviceId = 'device_sender_1';
    const recipientUid = 'user_recipient_1';
    const recipientDeviceId = 'device_recipient_1';

    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();
    const recipientExchange = await generateExchangeKeyPair();

    const senderIdentityPubJwk = await exportPublicKey(senderIdentity.publicKey);
    const senderExchangePubJwk = await exportPublicKey(senderExchange.publicKey);
    const recipientExchangePubJwk = await exportPublicKey(recipientExchange.publicKey);

    const roomMasterKey = await createRoomMasterKey();

    // Wrap room key
    const envelope = await wrapRoomKeyForDevice({
      roomId,
      roomMasterKey,
      recipientUid,
      recipientDeviceId,
      recipientExchangePublicKey: recipientExchangePubJwk,
      senderUid,
      senderDeviceId,
      senderExchangePrivateKey: senderExchange.privateKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    expect(envelope.roomId).toBe(roomId);
    expect(envelope.deviceId).toBe(recipientDeviceId);
    expect(envelope.ownerUid).toBe(recipientUid);
    expect(envelope.senderDeviceId).toBe(senderDeviceId);
    expect(envelope.senderUid).toBe(senderUid);
    expect(envelope.encryptedRoomKey).toBeTruthy();
    expect(envelope.iv).toBeTruthy();
    expect(envelope.signature).toBeTruthy();

    // Verify envelope signature
    const isSigValid = await verifyRoomKeyEnvelope(envelope, senderIdentityPubJwk);
    expect(isSigValid).toBe(true);

    // Unwrap room key
    const unwrappedKey = await unwrapRoomKey({
      envelope,
      expectedDeviceId: recipientDeviceId,
      recipientExchangePrivateKey: recipientExchange.privateKey,
      senderIdentityPublicKey: senderIdentityPubJwk,
      senderExchangePublicKey: senderExchangePubJwk,
    });

    expect(unwrappedKey).toBeDefined();
    expect(unwrappedKey.algorithm.name).toBe('AES-GCM');
    // Exportable so the V3 ratchet can seed its HKDF chain from the raw epoch key
    // (matches createRoomMasterKey; non-extractable here broke V3 send/recv).
    expect(unwrappedKey.extractable).toBe(true);
  });

  it('verifies that the raw room master key is never serialized plaintext into the envelope', async () => {
    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();
    const recipientExchange = await generateExchangeKeyPair();
    const roomMasterKey = await createRoomMasterKey();

    const envelope = await wrapRoomKeyForDevice({
      roomId: 'room_sec_test',
      roomMasterKey,
      recipientUid: 'rec_uid',
      recipientDeviceId: 'rec_dev',
      recipientExchangePublicKey: await exportPublicKey(recipientExchange.publicKey),
      senderUid: 'send_uid',
      senderDeviceId: 'send_dev',
      senderExchangePrivateKey: senderExchange.privateKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    expect((envelope as any).rawKey).toBeUndefined();
    expect((envelope as any).roomMasterKey).toBeUndefined();
    expect((envelope as any).key).toBeUndefined();
    expect(envelope.encryptedRoomKey).not.toContain('AES');
  });

  it('rejects tampered ciphertext during unwrapping', async () => {
    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();
    const recipientExchange = await generateExchangeKeyPair();
    const roomMasterKey = await createRoomMasterKey();

    const envelope = await wrapRoomKeyForDevice({
      roomId: 'room_tamper_1',
      roomMasterKey,
      recipientUid: 'rec_uid',
      recipientDeviceId: 'rec_dev',
      recipientExchangePublicKey: await exportPublicKey(recipientExchange.publicKey),
      senderUid: 'send_uid',
      senderDeviceId: 'send_dev',
      senderExchangePrivateKey: senderExchange.privateKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    // Tamper ciphertext
    const tamperedEnvelope: RoomKeyEnvelopeDTO = {
      ...envelope,
      encryptedRoomKey: envelope.encryptedRoomKey.slice(0, -4) + 'AAAA',
    };

    await expect(
      unwrapRoomKey({
        envelope: tamperedEnvelope,
        expectedDeviceId: 'rec_dev',
        recipientExchangePrivateKey: recipientExchange.privateKey,
        senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
        senderExchangePublicKey: await exportPublicKey(senderExchange.publicKey),
      })
    ).rejects.toThrow();
  });

  it('rejects tampered signature during verification and unwrapping', async () => {
    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();
    const recipientExchange = await generateExchangeKeyPair();
    const roomMasterKey = await createRoomMasterKey();

    const envelope = await wrapRoomKeyForDevice({
      roomId: 'room_tamper_sig',
      roomMasterKey,
      recipientUid: 'rec_uid',
      recipientDeviceId: 'rec_dev',
      recipientExchangePublicKey: await exportPublicKey(recipientExchange.publicKey),
      senderUid: 'send_uid',
      senderDeviceId: 'send_dev',
      senderExchangePrivateKey: senderExchange.privateKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    // Corrupt signature
    const badSigEnvelope: RoomKeyEnvelopeDTO = {
      ...envelope,
      signature: envelope.signature.slice(0, -4) + 'ZZZZ',
    };

    const isSigValid = await verifyRoomKeyEnvelope(
      badSigEnvelope,
      await exportPublicKey(senderIdentity.publicKey)
    );
    expect(isSigValid).toBe(false);

    await expect(
      unwrapRoomKey({
        envelope: badSigEnvelope,
        expectedDeviceId: 'rec_dev',
        recipientExchangePrivateKey: recipientExchange.privateKey,
        senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
        senderExchangePublicKey: await exportPublicKey(senderExchange.publicKey),
      })
    ).rejects.toThrow(/signature verification failed/i);
  });

  it('rejects envelope if expected recipient deviceId mismatches', async () => {
    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();
    const recipientExchange = await generateExchangeKeyPair();
    const roomMasterKey = await createRoomMasterKey();

    const envelope = await wrapRoomKeyForDevice({
      roomId: 'room_dev_mismatch',
      roomMasterKey,
      recipientUid: 'rec_uid',
      recipientDeviceId: 'rec_dev_real',
      recipientExchangePublicKey: await exportPublicKey(recipientExchange.publicKey),
      senderUid: 'send_uid',
      senderDeviceId: 'send_dev',
      senderExchangePrivateKey: senderExchange.privateKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    await expect(
      unwrapRoomKey({
        envelope,
        expectedDeviceId: 'wrong_recipient_device_id',
        recipientExchangePrivateKey: recipientExchange.privateKey,
        senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
        senderExchangePublicKey: await exportPublicKey(senderExchange.publicKey),
      })
    ).rejects.toThrow(/recipient deviceId mismatch/i);
  });

  it('rejects unwrapping if wrong roomId context is passed or tampered', async () => {
    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();
    const recipientExchange = await generateExchangeKeyPair();
    const roomMasterKey = await createRoomMasterKey();

    const envelope = await wrapRoomKeyForDevice({
      roomId: 'room_original_123',
      roomMasterKey,
      recipientUid: 'rec_uid',
      recipientDeviceId: 'rec_dev',
      recipientExchangePublicKey: await exportPublicKey(recipientExchange.publicKey),
      senderUid: 'send_uid',
      senderDeviceId: 'send_dev',
      senderExchangePrivateKey: senderExchange.privateKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    // Change envelope roomId
    const wrongRoomEnvelope: RoomKeyEnvelopeDTO = {
      ...envelope,
      roomId: 'room_stolen_456',
    };

    await expect(
      unwrapRoomKey({
        envelope: wrongRoomEnvelope,
        expectedDeviceId: 'rec_dev',
        recipientExchangePrivateKey: recipientExchange.privateKey,
        senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
        senderExchangePublicKey: await exportPublicKey(senderExchange.publicKey),
      })
    ).rejects.toThrow();
  });

  it('rejects envelope if ownerUid is tampered', async () => {
    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();
    const recipientExchange = await generateExchangeKeyPair();
    const roomMasterKey = await createRoomMasterKey();

    const envelope = await wrapRoomKeyForDevice({
      roomId: 'room_uid_test_1',
      roomMasterKey,
      recipientUid: 'original_owner_uid',
      recipientDeviceId: 'rec_dev',
      recipientExchangePublicKey: await exportPublicKey(recipientExchange.publicKey),
      senderUid: 'sender_uid',
      senderDeviceId: 'send_dev',
      senderExchangePrivateKey: senderExchange.privateKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    // Tamper ownerUid
    const tamperedEnvelope: RoomKeyEnvelopeDTO = {
      ...envelope,
      ownerUid: 'imposter_owner_uid',
    };

    const isSigValid = await verifyRoomKeyEnvelope(
      tamperedEnvelope,
      await exportPublicKey(senderIdentity.publicKey)
    );
    expect(isSigValid).toBe(false);

    await expect(
      unwrapRoomKey({
        envelope: tamperedEnvelope,
        expectedDeviceId: 'rec_dev',
        recipientExchangePrivateKey: recipientExchange.privateKey,
        senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
        senderExchangePublicKey: await exportPublicKey(senderExchange.publicKey),
      })
    ).rejects.toThrow(/signature verification failed/i);
  });

  it('rejects envelope if senderUid is tampered', async () => {
    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();
    const recipientExchange = await generateExchangeKeyPair();
    const roomMasterKey = await createRoomMasterKey();

    const envelope = await wrapRoomKeyForDevice({
      roomId: 'room_uid_test_2',
      roomMasterKey,
      recipientUid: 'rec_uid',
      recipientDeviceId: 'rec_dev',
      recipientExchangePublicKey: await exportPublicKey(recipientExchange.publicKey),
      senderUid: 'original_sender_uid',
      senderDeviceId: 'send_dev',
      senderExchangePrivateKey: senderExchange.privateKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    // Tamper senderUid
    const tamperedEnvelope: RoomKeyEnvelopeDTO = {
      ...envelope,
      senderUid: 'imposter_sender_uid',
    };

    const isSigValid = await verifyRoomKeyEnvelope(
      tamperedEnvelope,
      await exportPublicKey(senderIdentity.publicKey)
    );
    expect(isSigValid).toBe(false);

    await expect(
      unwrapRoomKey({
        envelope: tamperedEnvelope,
        expectedDeviceId: 'rec_dev',
        recipientExchangePrivateKey: recipientExchange.privateKey,
        senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
        senderExchangePublicKey: await exportPublicKey(senderExchange.publicKey),
      })
    ).rejects.toThrow(/signature verification failed/i);
  });

  it('supports multi-device envelope distribution (separate envelopes per device)', async () => {
    const roomId = 'room_multidevice_v2';
    const aliceUid = 'alice_uid';
    const bobUid = 'bob_uid';

    // Alice device 1 (sender)
    const aliceDev1Identity = await generateIdentityKeyPair();
    const aliceDev1Exchange = await generateExchangeKeyPair();
    const aliceDev1PubJwk = await exportPublicKey(aliceDev1Exchange.publicKey);
    const aliceDev1IdentityPubJwk = await exportPublicKey(aliceDev1Identity.publicKey);

    // Alice device 2 (laptop)
    const aliceDev2Exchange = await generateExchangeKeyPair();
    const aliceDev2PubJwk = await exportPublicKey(aliceDev2Exchange.publicKey);

    // Bob device 1 (phone)
    const bobDev1Exchange = await generateExchangeKeyPair();
    const bobDev1PubJwk = await exportPublicKey(bobDev1Exchange.publicKey);

    const { roomMasterKey, envelopes } = await createV2Room({
      roomId,
      participants: [aliceUid, bobUid],
      targetDevices: [
        { uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceDev1PubJwk },
        { uid: aliceUid, deviceId: 'alice_laptop', exchangePublicKey: aliceDev2PubJwk },
        { uid: bobUid, deviceId: 'bob_phone', exchangePublicKey: bobDev1PubJwk },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceDev1Identity.privateKey,
        exchangePrivateKey: aliceDev1Exchange.privateKey,
      },
    });

    expect(envelopes).toHaveLength(3);
    expect(mockDbStore[`rooms/${roomId}/meta/version`]).toBe('v2_e2ee');
    expect(mockDbStore[`rooms/${roomId}/keyEnvelopes/1/alice_phone`]).toBeDefined();
    expect(mockDbStore[`rooms/${roomId}/keyEnvelopes/1/alice_laptop`]).toBeDefined();
    expect(mockDbStore[`rooms/${roomId}/keyEnvelopes/1/bob_phone`]).toBeDefined();

    // Verify Bob Phone can unwrap its envelope
    const bobEnv = await getRoomKeyEnvelope(roomId, 'bob_phone', 1);
    expect(bobEnv).not.toBeNull();

    const bobUnwrappedKey = await unwrapRoomKey({
      envelope: bobEnv!,
      expectedDeviceId: 'bob_phone',
      recipientExchangePrivateKey: bobDev1Exchange.privateKey,
      senderIdentityPublicKey: aliceDev1IdentityPubJwk,
      senderExchangePublicKey: aliceDev1PubJwk,
    });

    expect(bobUnwrappedKey).toBeDefined();

    // Verify Alice Laptop can unwrap its envelope
    const aliceLaptopEnv = await getRoomKeyEnvelope(roomId, 'alice_laptop', 1);
    expect(aliceLaptopEnv).not.toBeNull();

    const aliceLaptopUnwrappedKey = await unwrapRoomKey({
      envelope: aliceLaptopEnv!,
      expectedDeviceId: 'alice_laptop',
      recipientExchangePrivateKey: aliceDev2Exchange.privateKey,
      senderIdentityPublicKey: aliceDev1IdentityPubJwk,
      senderExchangePublicKey: aliceDev1PubJwk,
    });

    expect(aliceLaptopUnwrappedKey).toBeDefined();
  });
});
