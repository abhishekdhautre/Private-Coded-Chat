import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockDbStore: Record<string, any> = {};

vi.mock('firebase/database', () => ({
  getDatabase: vi.fn(() => ({})),
  ref: (_db: any, path?: string) => ({ path: path || '' }),
  get: vi.fn(async (refObj: { path: string }) => ({
    exists: () => refObj.path in mockDbStore,
    val: () => mockDbStore[refObj.path] || null,
  })),
  set: vi.fn(async (refObj: { path: string }, value: any) => {
    mockDbStore[refObj.path] = value;
  }),
}));

import {
  encryptMessageV2,
  decryptMessageV2,
  verifyMessageV2,
  receiveMessageV2,
  sendMessageV2,
  clearReplayCache,
  MessageDTOV2,
} from '@/lib/messageCryptoV2';
import { createRoomMasterKey } from '@/lib/roomKeyService';
import {
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  createDeviceIdentityBundle,
  exportPublicKey,
  SignedDeviceIdentityBundle,
} from '@/lib/cryptoV2';

describe('Phase 4 V2 Authenticated & Signed Messaging', () => {
  beforeEach(() => {
    clearReplayCache();
    for (const key of Object.keys(mockDbStore)) {
      delete mockDbStore[key];
    }
  });

  it('encrypts and decrypts a V2 message using AES-256-GCM', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const plaintext = 'Secret zero-knowledge E2EE message V2';
    const roomId = 'room_v2_msg_1';
    const senderUid = 'alice_uid';
    const senderDeviceId = 'alice_phone';

    const message = await encryptMessageV2({
      plaintext,
      roomId,
      senderUid,
      senderDeviceId,
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    expect(message.messageId).toBeTruthy();
    expect(message.roomId).toBe(roomId);
    expect(message.senderUid).toBe(senderUid);
    expect(message.senderDeviceId).toBe(senderDeviceId);
    expect(message.ciphertext).not.toBe(plaintext);
    expect(message.signature).toBeTruthy();

    const decrypted = await decryptMessageV2({
      message,
      roomMasterKey,
    });

    expect(decrypted).toBe(plaintext);
  });

  it('generates a fresh unique IV for every message', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();
    const plaintext = 'Identical plaintext content';

    const msg1 = await encryptMessageV2({
      plaintext,
      roomId: 'room_iv_test',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const msg2 = await encryptMessageV2({
      plaintext,
      roomId: 'room_iv_test',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    expect(msg1.iv).not.toBe(msg2.iv);
    expect(msg1.ciphertext).not.toBe(msg2.ciphertext);
  });

  it('verifies a valid message signature with sender identity key', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();
    const senderIdentityPubJwk = await exportPublicKey(senderIdentity.publicKey);

    const message = await encryptMessageV2({
      plaintext: 'Signed message payload test',
      roomId: 'room_sig_test',
      senderUid: 'bob_uid',
      senderDeviceId: 'bob_laptop',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const isValid = await verifyMessageV2({
      message,
      senderIdentityPublicKey: senderIdentityPubJwk,
    });

    expect(isValid).toBe(true);
  });

  it('verifies that plaintext content never appears in stored message DTO', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const message = await encryptMessageV2({
      plaintext: 'CONFIDENTIAL_TOP_SECRET',
      roomId: 'room_sec_test',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    expect((message as any).plaintext).toBeUndefined();
    expect((message as any).content).toBeUndefined();
    expect((message as any).rawKey).toBeUndefined();
    expect(JSON.stringify(message)).not.toContain('CONFIDENTIAL_TOP_SECRET');
  });

  it('rejects tampered ciphertext during decryption and verification', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const message = await encryptMessageV2({
      plaintext: 'Original content',
      roomId: 'room_tamper_c',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const tamperedMsg: MessageDTOV2 = {
      ...message,
      ciphertext: message.ciphertext.slice(0, -4) + 'AAAA',
    };

    const isSigValid = await verifyMessageV2({
      message: tamperedMsg,
      senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
    });
    expect(isSigValid).toBe(false);

    await expect(
      decryptMessageV2({ message: tamperedMsg, roomMasterKey })
    ).rejects.toThrow();
  });

  it('rejects tampered IV', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const message = await encryptMessageV2({
      plaintext: 'Original content',
      roomId: 'room_tamper_iv',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const tamperedMsg: MessageDTOV2 = {
      ...message,
      iv: message.iv.slice(0, -4) + 'ZZZZ',
    };

    const isSigValid = await verifyMessageV2({
      message: tamperedMsg,
      senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
    });
    expect(isSigValid).toBe(false);

    await expect(
      decryptMessageV2({ message: tamperedMsg, roomMasterKey })
    ).rejects.toThrow();
  });

  it('rejects tampered roomId in message payload', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const message = await encryptMessageV2({
      plaintext: 'Original content',
      roomId: 'room_legit',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const tamperedMsg: MessageDTOV2 = {
      ...message,
      roomId: 'room_stolen',
    };

    const isSigValid = await verifyMessageV2({
      message: tamperedMsg,
      senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
    });
    expect(isSigValid).toBe(false);

    await expect(
      decryptMessageV2({ message: tamperedMsg, roomMasterKey })
    ).rejects.toThrow();
  });

  it('rejects tampered messageId', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const message = await encryptMessageV2({
      plaintext: 'Original content',
      roomId: 'room_mid_test',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const tamperedMsg: MessageDTOV2 = {
      ...message,
      messageId: 'tampered_message_id_999',
    };

    const isSigValid = await verifyMessageV2({
      message: tamperedMsg,
      senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
    });
    expect(isSigValid).toBe(false);

    await expect(
      decryptMessageV2({ message: tamperedMsg, roomMasterKey })
    ).rejects.toThrow();
  });

  it('rejects tampered epoch', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const message = await encryptMessageV2({
      plaintext: 'Original content',
      roomId: 'room_epoch_test',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
      epoch: 1,
    });

    const tamperedMsg: MessageDTOV2 = {
      ...message,
      epoch: 999,
    };

    const isSigValid = await verifyMessageV2({
      message: tamperedMsg,
      senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
    });
    expect(isSigValid).toBe(false);

    await expect(
      decryptMessageV2({ message: tamperedMsg, roomMasterKey })
    ).rejects.toThrow();
  });

  it('rejects tampered senderUid', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const message = await encryptMessageV2({
      plaintext: 'Original content',
      roomId: 'room_suid_test',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const tamperedMsg: MessageDTOV2 = {
      ...message,
      senderUid: 'imposter_uid',
    };

    const isSigValid = await verifyMessageV2({
      message: tamperedMsg,
      senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
    });
    expect(isSigValid).toBe(false);

    await expect(
      decryptMessageV2({ message: tamperedMsg, roomMasterKey })
    ).rejects.toThrow();
  });

  it('rejects tampered senderDeviceId', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const message = await encryptMessageV2({
      plaintext: 'Original content',
      roomId: 'room_sdev_test',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const tamperedMsg: MessageDTOV2 = {
      ...message,
      senderDeviceId: 'hacker_laptop',
    };

    const isSigValid = await verifyMessageV2({
      message: tamperedMsg,
      senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
    });
    expect(isSigValid).toBe(false);

    await expect(
      decryptMessageV2({ message: tamperedMsg, roomMasterKey })
    ).rejects.toThrow();
  });

  it('rejects tampered timestamp', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const message = await encryptMessageV2({
      plaintext: 'Original content',
      roomId: 'room_ts_test',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
      timestamp: 1000,
    });

    const tamperedMsg: MessageDTOV2 = {
      ...message,
      timestamp: 9999999999,
    };

    const isSigValid = await verifyMessageV2({
      message: tamperedMsg,
      senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
    });
    expect(isSigValid).toBe(false);

    await expect(
      decryptMessageV2({ message: tamperedMsg, roomMasterKey })
    ).rejects.toThrow();
  });

  it('rejects tampered signature', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const message = await encryptMessageV2({
      plaintext: 'Original content',
      roomId: 'room_sig_tamp',
      senderUid: 'alice_uid',
      senderDeviceId: 'alice_phone',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const tamperedMsg: MessageDTOV2 = {
      ...message,
      signature: message.signature.slice(0, -4) + 'XXXX',
    };

    const isSigValid = await verifyMessageV2({
      message: tamperedMsg,
      senderIdentityPublicKey: await exportPublicKey(senderIdentity.publicKey),
    });
    expect(isSigValid).toBe(false);
  });

  it('processes incoming V2 message end-to-end with sender device bundle verification', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderUid = 'alice_uid';
    const senderDeviceId = 'alice_phone';

    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();

    const bundle: SignedDeviceIdentityBundle = await createDeviceIdentityBundle(
      senderDeviceId,
      senderIdentity,
      senderExchange
    );

    const message = await encryptMessageV2({
      plaintext: 'End-to-End Receive Message Test',
      roomId: 'room_e2e_receive',
      senderUid,
      senderDeviceId,
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const plaintext = await receiveMessageV2({
      message,
      roomMasterKey,
      senderDeviceBundle: bundle,
    });

    expect(plaintext).toBe('End-to-End Receive Message Test');
  });

  it('rejects unknown or unregistered sender device', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const message = await encryptMessageV2({
      plaintext: 'Unknown device message',
      roomId: 'room_unknown_dev',
      senderUid: 'ghost_user',
      senderDeviceId: 'unknown_device_99',
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    await expect(
      receiveMessageV2({
        message,
        roomMasterKey,
        fetchSenderDevice: async () => null,
      })
    ).rejects.toThrow(/unknown or unregistered device/i);
  });

  it('rejects duplicate messageId (replay attack protection)', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderUid = 'alice_uid';
    const senderDeviceId = 'alice_phone';

    const senderIdentity = await generateIdentityKeyPair();
    const senderExchange = await generateExchangeKeyPair();

    const bundle: SignedDeviceIdentityBundle = await createDeviceIdentityBundle(
      senderDeviceId,
      senderIdentity,
      senderExchange
    );

    const message = await encryptMessageV2({
      plaintext: 'Replay protection message',
      roomId: 'room_replay_test',
      senderUid,
      senderDeviceId,
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    // First processing succeeds
    const firstAttempt = await receiveMessageV2({
      message,
      roomMasterKey,
      senderDeviceBundle: bundle,
    });
    expect(firstAttempt).toBe('Replay protection message');

    // Second processing with exact same messageId throws replay attack error
    await expect(
      receiveMessageV2({
        message,
        roomMasterKey,
        senderDeviceBundle: bundle,
      })
    ).rejects.toThrow(/replay attack detected/i);
  });

  it('sends V2 message and stores DTO in Firebase Realtime Database', async () => {
    const roomMasterKey = await createRoomMasterKey();
    const senderIdentity = await generateIdentityKeyPair();

    const roomId = 'room_send_v2';
    const senderUid = 'alice_uid';
    const senderDeviceId = 'alice_phone';
    const plaintext = 'Sent message V2 content';

    const message = await sendMessageV2({
      plaintext,
      roomId,
      senderUid,
      senderDeviceId,
      roomMasterKey,
      senderIdentityPrivateKey: senderIdentity.privateKey,
    });

    const storedPath = `rooms/${roomId}/messages/${message.messageId}`;
    expect(mockDbStore[storedPath]).toBeDefined();

    const storedMsg: MessageDTOV2 = mockDbStore[storedPath];
    expect(storedMsg.messageId).toBe(message.messageId);
    expect(storedMsg.ciphertext).toBe(message.ciphertext);
    expect(storedMsg.signature).toBe(message.signature);
  });
});
