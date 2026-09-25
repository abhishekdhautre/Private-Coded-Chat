/**
 * Phase 6 regression tests: envelope self-repair and V3 text+media lifecycle.
 *
 * 1. Own-device repair: after a device rotation the caller's own new device has
 *    no envelope. ensureRoomKeyEnvelopesForMembers() must provision it on the
 *    canonical keyEnvelopes/{epoch}/{deviceId} path (never the legacy path),
 *    after which acquireV2RoomKey() succeeds for that device.
 * 2. V3 text+media lifecycle: mirrors exactly what the chat send() handler now
 *    builds for V2 rooms (encryptMessageV3 for text + encryptBytes with the
 *    room key for media), then receives via the PRODUCTION call shape
 *    (receiveMessageV3 WITHOUT senderDeviceBundle, forcing the real getDevice
 *    fetch + verification) and decryptBytes for media — in both directions.
 * 3. Rules-shape: the V3+media record carries every required V3 child and none
 *    of the banned children, so the Firebase validate branch accepts it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockDbStore: Record<string, any> = {};

vi.mock('firebase/database', () => ({
  getDatabase: vi.fn(() => ({})),
  ref: (_db: any, path?: string) => ({ path: path || '' }),
  get: vi.fn(async (refObj: { path: string }) => {
    if (refObj.path in mockDbStore) {
      return { exists: () => true, val: () => mockDbStore[refObj.path] };
    }
    const prefix = refObj.path.endsWith('/') ? refObj.path : refObj.path + '/';
    const childKeys = Object.keys(mockDbStore).filter((k) => k.startsWith(prefix));
    if (childKeys.length > 0) {
      const parentObj: Record<string, any> = {};
      for (const key of childKeys) {
        const subKey = key.slice(prefix.length);
        const topKey = subKey.split('/')[0];
        if (!(topKey in parentObj)) {
          parentObj[topKey] =
            subKey === topKey
              ? mockDbStore[key]
              : { ...parentObj[topKey], [subKey.slice(topKey.length + 1)]: mockDbStore[key] };
        }
      }
      return { exists: () => true, val: () => parentObj };
    }
    return { exists: () => false, val: () => null };
  }),
  set: vi.fn(async (refObj: { path: string }, val: any) => {
    mockDbStore[refObj.path] = val;
  }),
  update: vi.fn(async (_refObj: any, updates: Record<string, any>) => {
    for (const [key, value] of Object.entries(updates)) mockDbStore[key] = value;
  }),
}));

import {
  acquireV2RoomKey,
  createV2Room,
  ensureRoomKeyEnvelopesForMembers,
  clearEpochKeyCache,
} from '@/lib/roomKeyService';
import {
  encryptMessageV3,
  receiveMessageV3,
  clearReplayCache,
  type MessageDTOV3,
} from '@/lib/messageCryptoV2';
import { clearRatchetStore } from '@/lib/ratchetV2';
import {
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  createDeviceIdentityBundle,
} from '@/lib/cryptoV2';
import { encryptBytes, decryptBytes } from '@/lib/crypto';
import { saveDeviceKeys } from '@/lib/keyStorage';
import { set, ref } from 'firebase/database';
import { db } from '@/lib/firebase';

async function registerDeviceRecord(uid: string, deviceId: string, bundle: { payload: any; signature: string }) {
  await set(ref(db, `users/${uid}/devices/${deviceId}`), {
    deviceId: bundle.payload.deviceId,
    createdAt: bundle.payload.createdAt,
    publicKeys: {
      identityECDSA: bundle.payload.identityPublicKey,
      exchangeECDH: bundle.payload.exchangePublicKey,
    },
    signature: bundle.signature,
  });
}

async function saveLocalKeys(deviceId: string) {
  const ident = await generateIdentityKeyPair();
  const exch = await generateExchangeKeyPair();
  const bundle = await createDeviceIdentityBundle(deviceId, ident, exch);
  await saveDeviceKeys({
    deviceId,
    identityPrivateKey: ident.privateKey,
    identityPublicKey: ident.publicKey,
    exchangePrivateKey: exch.privateKey,
    exchangePublicKey: exch.publicKey,
    createdAt: Date.now(),
  });
  return { ident, exch, bundle };
}

describe('Phase 6: envelope self-repair + V3 text/media lifecycle', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockDbStore)) delete mockDbStore[k];
    clearRatchetStore();
    clearReplayCache();
    clearEpochKeyCache();
  });

  it('provisions an envelope for the caller\'s own rotated device on the canonical path', async () => {
    const roomId = `phase6repair_${Date.now()}`;
    const aliceUid = `alice_${Date.now()}`;
    const bobUid = `bob_${Date.now()}`;
    const aliceDev1 = `aliceDev1_${Date.now()}`;
    const bobDev = `bobDev_${Date.now()}`;

    const a1 = await saveLocalKeys(aliceDev1);
    const b = await saveLocalKeys(bobDev);
    await registerDeviceRecord(aliceUid, aliceDev1, a1.bundle);
    await registerDeviceRecord(bobUid, bobDev, b.bundle);

    const { roomMasterKey } = await createV2Room({
      roomId,
      participants: [aliceUid, bobUid].sort(),
      targetDevices: [
        { uid: aliceUid, deviceId: aliceDev1, exchangePublicKey: a1.bundle.payload.exchangePublicKey },
        { uid: bobUid, deviceId: bobDev, exchangePublicKey: b.bundle.payload.exchangePublicKey },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: aliceDev1,
        identityPrivateKey: a1.ident.privateKey,
        exchangePrivateKey: a1.exch.privateKey,
      },
    });

    // Alice rotates to a brand-new device (fresh IndexedDB identity).
    const aliceDev2 = `aliceDev2_${Date.now()}`;
    const a2 = await saveLocalKeys(aliceDev2);
    await registerDeviceRecord(aliceUid, aliceDev2, a2.bundle);

    // The new device has no envelope yet.
    expect(mockDbStore[`rooms/${roomId}/keyEnvelopes/1/${aliceDev2}`]).toBeUndefined();

    // Alice (possessing the epoch-1 key) opens the chat → repair runs.
    // Re-save device-1's ORIGINAL keys: the repair must wrap with the keys
    // whose public halves are registered in Firebase.
    await saveDeviceKeys({
      deviceId: aliceDev1,
      identityPrivateKey: a1.ident.privateKey,
      identityPublicKey: a1.ident.publicKey,
      exchangePrivateKey: a1.exch.privateKey,
      exchangePublicKey: a1.exch.publicKey,
      createdAt: Date.now(),
    });
    await ensureRoomKeyEnvelopesForMembers({
      roomId,
      roomMasterKey,
      currentEpoch: 1,
      myUid: aliceUid,
      otherUid: bobUid,
    });

    // Canonical epoch path written…
    const env = mockDbStore[`rooms/${roomId}/keyEnvelopes/1/${aliceDev2}`];
    expect(env).toBeDefined();
    expect(env.deviceId).toBe(aliceDev2);
    expect(env.epoch).toBe(1);
    // …and the removed legacy path is never written.
    expect(mockDbStore[`rooms/${roomId}/keyEnvelopes/${aliceDev2}`]).toBeUndefined();

    // The rotated device can now acquire + unlock.
    clearRatchetStore();
    await saveDeviceKeys({
      deviceId: aliceDev2,
      identityPrivateKey: a2.ident.privateKey,
      identityPublicKey: a2.ident.publicKey,
      exchangePrivateKey: a2.exch.privateKey,
      exchangePublicKey: a2.exch.publicKey,
      createdAt: Date.now(),
    });
    const acquired = await acquireV2RoomKey(roomId, 1);
    expect(acquired.deviceId).toBe(aliceDev2);
    expect(acquired.epoch).toBe(1);
    expect(acquired.roomMasterKey).toBeDefined();
  });

  it('full two-way V3 text + encrypted-media lifecycle via the production receive path', async () => {
    const roomId = `phase6media_${Date.now()}`;
    const aliceUid = `aliceM_${Date.now()}`;
    const bobUid = `bobM_${Date.now()}`;
    const aliceDev = `aliceMDev_${Date.now()}`;
    const bobDev = `bobMDev_${Date.now()}`;

    const a = await saveLocalKeys(aliceDev);
    const b = await saveLocalKeys(bobDev);
    await registerDeviceRecord(aliceUid, aliceDev, a.bundle);
    await registerDeviceRecord(bobUid, bobDev, b.bundle);

    const { roomMasterKey } = await createV2Room({
      roomId,
      participants: [aliceUid, bobUid].sort(),
      targetDevices: [
        { uid: aliceUid, deviceId: aliceDev, exchangePublicKey: a.bundle.payload.exchangePublicKey },
        { uid: bobUid, deviceId: bobDev, exchangePublicKey: b.bundle.payload.exchangePublicKey },
      ],
      senderInfo: {
        uid: aliceUid,
        deviceId: aliceDev,
        identityPrivateKey: a.ident.privateKey,
        exchangePrivateKey: a.exch.privateKey,
      },
    });

    // ---- A → B: build exactly what chat send() now writes for V2 rooms ----
    const fakeImageBytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5]);
    const dto: MessageDTOV3 = await encryptMessageV3({
      roomId,
      epoch: 1,
      senderUid: aliceUid,
      senderDeviceId: aliceDev,
      plaintext: 'hello with photo',
      epochKey: roomMasterKey,
      senderIdentityPrivateKey: a.ident.privateKey,
    });
    const media = await encryptBytes(fakeImageBytes, roomMasterKey);
    const record: Record<string, unknown> = {
      ...dto,
      senderId: aliceUid,
      msgType: 'image',
      mediaData: media.data,
      mediaIv: media.iv,
      mediaType: 'image',
      viewOnce: false,
    };

    // Rules-shape check: every required V3 child present, no banned child.
    for (const f of ['messageId', 'roomId', 'epoch', 'senderUid', 'senderDeviceId', 'ciphertext', 'iv', 'timestamp', 'signature']) {
      expect(record[f]).toBeDefined();
    }
    expect(record['messageId']).toBe(dto.messageId);
    expect(record['roomId']).toBe(roomId);
    for (const banned of ['plaintext', 'content', 'rawKey', 'chainKey', 'messageKey', 'roomMasterKey', 'privateKey']) {
      expect(banned in record).toBe(false);
    }

    // ---- B receives via the PRODUCTION path (no senderDeviceBundle) ----
    clearRatchetStore();
    const textB = await receiveMessageV3({ message: dto, epochKey: roomMasterKey });
    expect(textB).toBe('hello with photo');
    const bytesB = await decryptBytes(record['mediaData'] as string, record['mediaIv'] as string, roomMasterKey);
    expect(Array.from(bytesB)).toEqual(Array.from(fakeImageBytes));

    // ---- B → A (reply, text only) via the production path ----
    clearRatchetStore();
    const back = await encryptMessageV3({
      roomId,
      epoch: 1,
      senderUid: bobUid,
      senderDeviceId: bobDev,
      plaintext: 'hello back',
      epochKey: roomMasterKey,
      senderIdentityPrivateKey: b.ident.privateKey,
    });
    const textA = await receiveMessageV3({ message: back, epochKey: roomMasterKey });
    expect(textA).toBe('hello back');
  });
});
