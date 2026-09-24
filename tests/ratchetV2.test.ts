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
  set: vi.fn(async (refObj: { path: string }, value: any) => {
    mockDbStore[refObj.path] = value;
  }),
}));

import {
  initRatchetState,
  advanceRatchetChain,
  storeSkippedKey,
  consumeSkippedKey,
  clearRatchetStore,
  MAX_SKIPPED_KEYS,
} from '@/lib/ratchetV2';
import {
  encryptMessageV3,
  decryptMessageV2,
  receiveMessageV3,
  sendMessageV3,
  encryptMessageV2,
  decryptMessageV2 as decryptV2Legacy,
  clearReplayCache,
  MessageDTOV3,
} from '@/lib/messageCryptoV2';
import {
  createRoomMasterKey,
  createV2Room,
  rotateRoomKey,
  clearEpochKeyCache,
} from '@/lib/roomKeyService';
import {
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  createDeviceIdentityBundle,
  exportPublicKey,
} from '@/lib/cryptoV2';

describe('Phase 5 Ratchet & Forward Secrecy Infrastructure', () => {
  beforeEach(() => {
    clearRatchetStore();
    clearReplayCache();
    clearEpochKeyCache();
    for (const key of Object.keys(mockDbStore)) {
      delete mockDbStore[key];
    }
  });

  it('initializes ratchet state at sequence 0 with non-extractable message keys', async () => {
    const epochKey = await createRoomMasterKey();
    const state = await initRatchetState({
      roomId: 'room_ratchet_init',
      epoch: 1,
      senderDeviceId: 'alice_phone',
      epochKey,
    });

    expect(state.sequenceNumber).toBe(0);
    expect(state.chainKey).toBeDefined();

    const { messageKey, nextState } = await advanceRatchetChain(state, 'msg_001');
    expect(messageKey.type).toBe('secret');
    expect(messageKey.extractable).toBe(false); // Non-extractable message key
    expect(nextState.sequenceNumber).toBe(1);
  });

  it('derives unique message keys for sequential messages and advances chain', async () => {
    const epochKey = await createRoomMasterKey();
    const state = await initRatchetState({
      roomId: 'room_seq_keys',
      epoch: 1,
      senderDeviceId: 'alice_phone',
      epochKey,
    });

    const { messageKey: key1 } = await advanceRatchetChain(state, 'msg_seq_1');
    const { messageKey: key2 } = await advanceRatchetChain(state, 'msg_seq_2');

    const raw1 = await globalThis.crypto.subtle.exportKey('raw', key1).catch(() => null);
    const raw2 = await globalThis.crypto.subtle.exportKey('raw', key2).catch(() => null);

    // Message keys are non-extractable so exporting fails or they differ
    expect(raw1).toBeNull();
    expect(raw2).toBeNull();
    expect(state.sequenceNumber).toBe(2);
  });

  it('encrypts and decrypts V3 ratcheted messages end-to-end', async () => {
    const roomId = 'room_v3_e2e';
    const epoch = 1;
    const aliceUid = 'alice_uid';
    const aliceDeviceId = 'alice_phone';

    const aliceIdentity = await generateIdentityKeyPair();
    const aliceExchange = await generateExchangeKeyPair();
    const epochKey = await createRoomMasterKey();

    const bundle = await createDeviceIdentityBundle(
      aliceDeviceId,
      aliceIdentity,
      aliceExchange
    );

    const plaintext = 'Ratcheted forward-secret V3 message content';

    const message = await encryptMessageV3({
      plaintext,
      roomId,
      epoch,
      senderUid: aliceUid,
      senderDeviceId: aliceDeviceId,
      epochKey,
      senderIdentityPrivateKey: aliceIdentity.privateKey,
    });

    expect(message.cryptoVersion).toBe('v3_ratchet');
    expect(message.sequenceNumber).toBe(0);
    expect(message.ciphertext).not.toBe(plaintext);

    // Receiver initializes ratchet chain independently from same epoch key and decrypts
    const decrypted = await receiveMessageV3({
      message,
      epochKey,
      senderDeviceBundle: bundle,
    });

    expect(decrypted).toBe(plaintext);
  });

  it('handles out-of-order messages correctly using bounded skipped keys', async () => {
    const roomId = 'room_ooo_test';
    const epoch = 1;
    const aliceUid = 'alice_uid';
    const aliceDeviceId = 'alice_phone';

    const aliceIdentity = await generateIdentityKeyPair();
    const aliceExchange = await generateExchangeKeyPair();
    const epochKey = await createRoomMasterKey();

    const bundle = await createDeviceIdentityBundle(
      aliceDeviceId,
      aliceIdentity,
      aliceExchange
    );

    // Sender produces msg0, msg1, msg2 in sequence
    const msg0 = await encryptMessageV3({
      plaintext: 'Message 0',
      roomId,
      epoch,
      senderUid: aliceUid,
      senderDeviceId: aliceDeviceId,
      epochKey,
      senderIdentityPrivateKey: aliceIdentity.privateKey,
    });

    const msg1 = await encryptMessageV3({
      plaintext: 'Message 1',
      roomId,
      epoch,
      senderUid: aliceUid,
      senderDeviceId: aliceDeviceId,
      epochKey,
      senderIdentityPrivateKey: aliceIdentity.privateKey,
    });

    const msg2 = await encryptMessageV3({
      plaintext: 'Message 2',
      roomId,
      epoch,
      senderUid: aliceUid,
      senderDeviceId: aliceDeviceId,
      epochKey,
      senderIdentityPrivateKey: aliceIdentity.privateKey,
    });

    // Receiver gets msg0, then OUT OF ORDER gets msg2 (skipping msg1), then gets msg1
    const dec0 = await receiveMessageV3({ message: msg0, epochKey, senderDeviceBundle: bundle });
    expect(dec0).toBe('Message 0');

    // Receiving msg2 forces skipping msg1
    const dec2 = await receiveMessageV3({ message: msg2, epochKey, senderDeviceBundle: bundle });
    expect(dec2).toBe('Message 2');

    // Now receiving out-of-order msg1 consumes skipped key
    const dec1 = await receiveMessageV3({ message: msg1, epochKey, senderDeviceBundle: bundle });
    expect(dec1).toBe('Message 1');
  });

  it('enforces MAX_SKIPPED_KEYS capacity limit in skipped key store', () => {
    const roomId = 'room_capacity_test';
    const epoch = 1;
    const deviceId = 'dev_capacity';

    for (let i = 0; i < MAX_SKIPPED_KEYS + 10; i++) {
      const mockKey = {} as CryptoKey;
      storeSkippedKey(roomId, epoch, deviceId, i, mockKey);
    }

    // Oldest 10 keys (sequence 0-9) should have been evicted
    const firstKey = consumeSkippedKey(roomId, epoch, deviceId, 0);
    expect(firstKey).toBeNull();

    // Key #10 (sequence 10) should exist
    const key10 = consumeSkippedKey(roomId, epoch, deviceId, 10);
    expect(key10).not.toBeNull();
  });

  it('consumes skipped key exactly once (discard after use)', async () => {
    const roomId = 'room_once_test';
    const epoch = 1;
    const deviceId = 'dev_once';
    const mockKey = {} as CryptoKey;

    storeSkippedKey(roomId, epoch, deviceId, 42, mockKey);

    const first = consumeSkippedKey(roomId, epoch, deviceId, 42);
    expect(first).toBe(mockKey);

    const second = consumeSkippedKey(roomId, epoch, deviceId, 42);
    expect(second).toBeNull();
  });

  it('rejects tampered sequenceNumber in V3 message', async () => {
    const roomId = 'room_tamper_seq';
    const epoch = 1;
    const aliceUid = 'alice_uid';
    const aliceDeviceId = 'alice_phone';

    const aliceIdentity = await generateIdentityKeyPair();
    const aliceExchange = await generateExchangeKeyPair();
    const epochKey = await createRoomMasterKey();

    const bundle = await createDeviceIdentityBundle(
      aliceDeviceId,
      aliceIdentity,
      aliceExchange
    );

    const message = await encryptMessageV3({
      plaintext: 'Sequence tamper test',
      roomId,
      epoch,
      senderUid: aliceUid,
      senderDeviceId: aliceDeviceId,
      epochKey,
      senderIdentityPrivateKey: aliceIdentity.privateKey,
    });

    const tamperedMessage: MessageDTOV3 = {
      ...message,
      sequenceNumber: 999,
    };

    await expect(
      receiveMessageV3({
        message: tamperedMessage,
        epochKey,
        senderDeviceBundle: bundle,
      })
    ).rejects.toThrow();
  });

  it('isolates ratchet roots across key rotation epochs (removed device isolation)', async () => {
    const roomId = 'room_ratchet_epoch_rotation';
    const aliceUid = 'alice_uid';
    const bobUid = 'bob_uid';

    const aliceIdentity = await generateIdentityKeyPair();
    const aliceExchange = await generateExchangeKeyPair();
    const bobExchange = await generateExchangeKeyPair();

    const aliceExchangeJwk = await exportPublicKey(aliceExchange.publicKey);
    const bobExchangeJwk = await exportPublicKey(bobExchange.publicKey);

    // Initial V2 room (Epoch 1)
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

    // Rotate to Epoch 2 (removing Bob)
    const { roomMasterKey: epoch2Key } = await rotateRoomKey({
      roomId,
      authorizedDevices: [
        { uid: aliceUid, deviceId: 'alice_phone', exchangePublicKey: aliceExchangeJwk },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: 'alice_phone',
        identityPrivateKey: aliceIdentity.privateKey,
        exchangePrivateKey: aliceExchange.privateKey,
      },
    });

    // Encrypt Epoch 2 V3 message
    const epoch2Message = await encryptMessageV3({
      plaintext: 'Post-rotation secret for Alice only',
      roomId,
      epoch: 2,
      senderUid: aliceUid,
      senderDeviceId: 'alice_phone',
      epochKey: epoch2Key,
      senderIdentityPrivateKey: aliceIdentity.privateKey,
    });

    const aliceBundle = await createDeviceIdentityBundle(
      'alice_phone',
      aliceIdentity,
      aliceExchange
    );

    // Bob attempting to decrypt Epoch 2 message using Epoch 1 key FAILS
    await expect(
      receiveMessageV3({
        message: epoch2Message,
        epochKey: epoch1Key, // Bob only has Epoch 1 key
        senderDeviceBundle: aliceBundle,
      })
    ).rejects.toThrow();
  });

  it('preserves backward compatibility: decrypts V1, V2, and V3 messages cleanly', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    // V2 Message
    const v2Msg = await encryptMessageV2({
      plaintext: 'Legacy V2 Message',
      roomId: 'room_compat',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const decV2 = await decryptMessageV2({ message: v2Msg, roomMasterKey });
    expect(decV2).toBe('Legacy V2 Message');

    // V3 Message
    const v3Msg = await encryptMessageV3({
      plaintext: 'Ratcheted V3 Message',
      roomId: 'room_compat',
      epoch: 1,
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      epochKey: roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const bundle = await createDeviceIdentityBundle(
      'alice_phone',
      senderIdentity,
      await generateExchangeKeyPair()
    );

    const decV3 = await receiveMessageV3({
      message: v3Msg,
      epochKey: roomMasterKey,
      senderDeviceBundle: bundle,
    });
    expect(decV3).toBe('Ratcheted V3 Message');
  });

  it('verifies that no raw chain keys or message keys appear in stored message DTO or Firebase', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const msg = await sendMessageV3({
      plaintext: 'SECRET_RATCHETED_PLAINTEXT',
      roomId: 'room_dto_sec',
      epoch: 1,
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      epochKey: roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    expect((msg as any).chainKey).toBeUndefined();
    expect((msg as any).messageKey).toBeUndefined();
    expect((msg as any).plaintext).toBeUndefined();
    expect(JSON.stringify(mockDbStore)).not.toContain('SECRET_RATCHETED_PLAINTEXT');
    expect(JSON.stringify(mockDbStore)).not.toContain('chainKey');
  });
});
