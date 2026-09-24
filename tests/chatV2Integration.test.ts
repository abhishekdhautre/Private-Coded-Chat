import { describe, it, expect, beforeEach, vi } from 'vitest';

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
        // Handle direct subkey
        const topKey = subKey.split('/')[0];
        if (!(topKey in parentObj)) {
          if (subKey === topKey) {
            parentObj[topKey] = mockDbStore[key];
          } else {
            // nested child
            parentObj[topKey] = { ...parentObj[topKey], [subKey.slice(topKey.length + 1)]: mockDbStore[key] };
          }
        }
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
  set: vi.fn(async (refObj: { path: string }, val: any) => {
    mockDbStore[refObj.path] = val;
  }),
  update: vi.fn(async (_refObj: any, updates: Record<string, any>) => {
    for (const [key, value] of Object.entries(updates)) {
      mockDbStore[key] = value;
    }
  }),
}));

import {
  isV2Room,
  acquireV2RoomKey,
  createV2Room,
  setEpochKey,
} from '@/lib/roomKeyService';
import {
  encryptMessageV3,
  receiveMessageV3,
  MessageDTOV3,
} from '@/lib/messageCryptoV2';
import {
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  createDeviceIdentityBundle,
  exportPublicKey,
} from '@/lib/cryptoV2';
import { saveDeviceKeys } from '@/lib/keyStorage';
import { set, ref } from 'firebase/database';
import { db } from '@/lib/firebase';

describe('V2 E2EE Chat Integration for Demo', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockDbStore)) {
      delete mockDbStore[k];
    }
  });

  it('V1 room still chooses V1 unlock (isV2Room returns false)', async () => {
    const v1RoomId = 'test_v1_room_' + Date.now();
    await set(ref(db, `rooms/${v1RoomId}/meta`), {
      participants: { 0: 'userA', 1: 'userB' },
      keyCheck: { ciphertext: 'fake_cipher', iv: 'fake_iv' },
      // no version field (legacy v1)
    });

    const isV2 = await isV2Room(v1RoomId);
    expect(isV2).toBe(false);
  });

  it('V2 room chooses automatic unlock (isV2Room returns true and acquireV2RoomKey succeeds)', async () => {
    const v2RoomId = 'test_v2_room_' + Date.now();
    const aliceUid = 'alice_' + Date.now();
    const bobUid = 'bob_' + Date.now();

    // Setup Alice's device
    const aliceIdent = await generateIdentityKeyPair();
    const aliceExch = await generateExchangeKeyPair();
    const aliceDeviceId = 'alice_dev_' + Date.now();
    const aliceBundle = await createDeviceIdentityBundle(
      aliceDeviceId,
      aliceIdent,
      aliceExch
    );

    // Setup Bob's device
    const bobIdent = await generateIdentityKeyPair();
    const bobExch = await generateExchangeKeyPair();
    const bobDeviceId = 'bob_dev_' + Date.now();
    const bobBundle = await createDeviceIdentityBundle(
      bobDeviceId,
      bobIdent,
      bobExch
    );

    // Register devices in Firebase mock database
    await set(ref(db, `users/${aliceUid}/devices/${aliceDeviceId}`), {
      deviceId: aliceDeviceId,
      createdAt: aliceBundle.payload.createdAt,
      publicKeys: {
        identityECDSA: aliceBundle.payload.identityPublicKey,
        exchangeECDH: aliceBundle.payload.exchangePublicKey,
      },
      signature: aliceBundle.signature,
    });
    await set(ref(db, `users/${bobUid}/devices/${bobDeviceId}`), {
      deviceId: bobDeviceId,
      createdAt: bobBundle.payload.createdAt,
      publicKeys: {
        identityECDSA: bobBundle.payload.identityPublicKey,
        exchangeECDH: bobBundle.payload.exchangePublicKey,
      },
      signature: bobBundle.signature,
    });

    // Save Bob's local keys into IndexedDB so Bob can auto-unlock
    await saveDeviceKeys({
      deviceId: bobDeviceId,
      identityPrivateKey: bobIdent.privateKey,
      identityPublicKey: bobIdent.publicKey,
      exchangePrivateKey: bobExch.privateKey,
      exchangePublicKey: bobExch.publicKey,
      createdAt: Date.now(),
    });

    // Alice creates the V2 room
    const targetDevices = [
      {
        uid: aliceUid,
        deviceId: aliceDeviceId,
        exchangePublicKey: aliceBundle.payload.exchangePublicKey,
      },
      {
        uid: bobUid,
        deviceId: bobDeviceId,
        exchangePublicKey: bobBundle.payload.exchangePublicKey,
      },
    ];

    const { roomMasterKey } = await createV2Room({
      roomId: v2RoomId,
      participants: [aliceUid, bobUid].sort(),
      targetDevices,
      senderInfo: {
        uid: aliceUid,
        deviceId: aliceDeviceId,
        identityPrivateKey: aliceIdent.privateKey,
        exchangePrivateKey: aliceExch.privateKey,
      },
    });

    // Check V2 detection
    const isV2 = await isV2Room(v2RoomId);
    expect(isV2).toBe(true);

    // Bob automatically acquires room key without passphrase
    const acquired = await acquireV2RoomKey(v2RoomId, 1);
    expect(acquired).toBeDefined();
    expect(acquired.roomMasterKey).toBeDefined();
    expect(acquired.epoch).toBe(1);
    expect(acquired.deviceId).toBe(bobDeviceId);
  });

  it('V2 message send uses V3 ratcheted crypto (MessageDTOV3 with sequenceNumber and signature)', async () => {
    const roomId = 'test_v3_send_' + Date.now();
    const aliceUid = 'alice_sender_' + Date.now();
    const aliceDeviceId = 'alice_dev_' + Date.now();
    const ident = await generateIdentityKeyPair();
    const exch = await generateExchangeKeyPair();
    const dummyKey = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    const dto = await encryptMessageV3({
      roomId,
      epoch: 1,
      senderUid: aliceUid,
      senderDeviceId: aliceDeviceId,
      plaintext: 'Hello from A',
      epochKey: dummyKey,
      senderIdentityPrivateKey: ident.privateKey,
    });

    expect(dto.cryptoVersion).toBe('v3_ratchet');
    expect(dto.sequenceNumber).toBe(0);
    expect(dto.roomId).toBe(roomId);
    expect(dto.epoch).toBe(1);
    expect(dto.senderUid).toBe(aliceUid);
    expect(dto.senderDeviceId).toBe(aliceDeviceId);
    expect(dto.ciphertext).toBeDefined();
    expect(dto.iv).toBeDefined();
    expect(dto.signature).toBeDefined();
    expect((dto as any).plaintext).toBeUndefined(); // Plaintext must never be stored in DTO
  });

  it('V2 message receive uses V3 crypto (verifies signature, advances ratchet, decrypts plaintext)', async () => {
    const roomId = 'test_v3_recv_' + Date.now();
    const aliceUid = 'alice_tx_' + Date.now();
    const aliceDeviceId = 'alice_dev_tx_' + Date.now();
    const ident = await generateIdentityKeyPair();
    const exch = await generateExchangeKeyPair();
    const bundle = await createDeviceIdentityBundle(aliceDeviceId, ident, exch);

    const epochKey = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    // Register Alice's bundle in mock db so receiveMessageV3 can verify it
    await set(ref(db, `users/${aliceUid}/devices/${aliceDeviceId}`), {
      deviceId: aliceDeviceId,
      createdAt: Date.now(),
      publicKeys: {
        identityECDSA: bundle.payload.identityPublicKey,
        exchangeECDH: bundle.payload.exchangePublicKey,
      },
      signature: bundle.signature,
    });

    const msg = await encryptMessageV3({
      roomId,
      epoch: 1,
      senderUid: aliceUid,
      senderDeviceId: aliceDeviceId,
      plaintext: 'Hello from Alice to Bob',
      epochKey,
      senderIdentityPrivateKey: ident.privateKey,
    });

    const decrypted = await receiveMessageV3({
      message: msg,
      epochKey,
      senderDeviceBundle: bundle,
    });

    expect(decrypted).toBe('Hello from Alice to Bob');
  });
});
