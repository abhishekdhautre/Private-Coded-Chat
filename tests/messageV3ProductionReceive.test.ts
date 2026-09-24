/**
 * Regression tests for the ACTUAL production V3 receive path.
 *
 * These tests deliberately call `receiveMessageV3({ message, epochKey })` WITHOUT
 * `senderDeviceBundle`, which is exactly what the chat listener does. That forces
 * the real `getDevice()` fetch + `verifyDeviceIdentityBundle()` verification to run,
 * so a broken/stale sender device record is caught here instead of silently
 * surfacing as "Unable to decrypt message." in the UI.
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

import { createV2Room } from '@/lib/roomKeyService';
import { encryptMessageV3, receiveMessageV3, clearReplayCache } from '@/lib/messageCryptoV2';
import { clearRatchetStore } from '@/lib/ratchetV2';
import {
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  createDeviceIdentityBundle,
} from '@/lib/cryptoV2';
import { set, ref } from 'firebase/database';
import { db } from '@/lib/firebase';

/** Register a device's public bundle exactly like deviceService.registerDevice does. */
async function registerDeviceInFirebase(
  uid: string,
  deviceId: string,
  bundle: { payload: any; signature: string }
) {
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

async function setupTwoDeviceRoom() {
  const roomId = `v3prod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const aliceUid = `alice_${Date.now()}`;
  const bobUid = `bob_${Date.now()}`;

  const aliceIdent = await generateIdentityKeyPair();
  const aliceExch = await generateExchangeKeyPair();
  const aliceDeviceId = `aliceDev_${Date.now()}`;
  const aliceBundle = await createDeviceIdentityBundle(aliceDeviceId, aliceIdent, aliceExch);

  const bobIdent = await generateIdentityKeyPair();
  const bobExch = await generateExchangeKeyPair();
  const bobDeviceId = `bobDev_${Date.now()}`;
  const bobBundle = await createDeviceIdentityBundle(bobDeviceId, bobIdent, bobExch);

  await registerDeviceInFirebase(aliceUid, aliceDeviceId, aliceBundle);
  await registerDeviceInFirebase(bobUid, bobDeviceId, bobBundle);

  const { roomMasterKey } = await createV2Room({
    roomId,
    participants: [aliceUid, bobUid].sort(),
    targetDevices: [
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
    ],
    senderInfo: {
      uid: aliceUid,
      deviceId: aliceDeviceId,
      identityPrivateKey: aliceIdent.privateKey,
      exchangePrivateKey: aliceExch.privateKey,
    },
  });

  return {
    roomId,
    roomMasterKey,
    aliceUid,
    bobUid,
    aliceDeviceId,
    bobDeviceId,
    aliceIdent,
    bobIdent,
    aliceBundle,
    bobBundle,
  };
}

describe('V3 production receive path (no senderDeviceBundle supplied)', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockDbStore)) delete mockDbStore[k];
    clearRatchetStore();
    clearReplayCache();
  });

  it('A sends "hi"; B decrypts via the production call shape (bundle omitted)', async () => {
    const ctx = await setupTwoDeviceRoom();

    const sent = await encryptMessageV3({
      roomId: ctx.roomId,
      epoch: 1,
      senderUid: ctx.aliceUid,
      senderDeviceId: ctx.aliceDeviceId,
      plaintext: 'hi',
      epochKey: ctx.roomMasterKey,
      senderIdentityPrivateKey: ctx.aliceIdent.privateKey,
    });
    expect(sent.sequenceNumber).toBe(0);

    // EXACT production call shape used by app/chat/[roomId]/page.tsx
    const decrypted = await receiveMessageV3({
      message: sent,
      epochKey: ctx.roomMasterKey,
    });

    expect(decrypted).toBe('hi');
  });

  it('B sends "hello back"; A decrypts via the production call shape (bundle omitted)', async () => {
    const ctx = await setupTwoDeviceRoom();

    const back = await encryptMessageV3({
      roomId: ctx.roomId,
      epoch: 1,
      senderUid: ctx.bobUid,
      senderDeviceId: ctx.bobDeviceId,
      plaintext: 'hello back',
      epochKey: ctx.roomMasterKey,
      senderIdentityPrivateKey: ctx.bobIdent.privateKey,
    });
    expect(back.sequenceNumber).toBe(0);

    const decrypted = await receiveMessageV3({
      message: back,
      epochKey: ctx.roomMasterKey,
    });

    expect(decrypted).toBe('hello back');
  });

  it("sender decrypts its OWN message via the production call shape (bundle omitted)", async () => {
    const ctx = await setupTwoDeviceRoom();

    const sent = await encryptMessageV3({
      roomId: ctx.roomId,
      epoch: 1,
      senderUid: ctx.aliceUid,
      senderDeviceId: ctx.aliceDeviceId,
      plaintext: 'own message',
      epochKey: ctx.roomMasterKey,
      senderIdentityPrivateKey: ctx.aliceIdent.privateKey,
    });

    // The chat listener also runs the sender's own rows through receiveMessageV3.
    const decrypted = await receiveMessageV3({
      message: sent,
      epochKey: ctx.roomMasterKey,
    });

    expect(decrypted).toBe('own message');
  });

  it('advances sequence 0 then 1 across the production receive path', async () => {
    const ctx = await setupTwoDeviceRoom();

    const m0 = await encryptMessageV3({
      roomId: ctx.roomId,
      epoch: 1,
      senderUid: ctx.aliceUid,
      senderDeviceId: ctx.aliceDeviceId,
      plaintext: 'first',
      epochKey: ctx.roomMasterKey,
      senderIdentityPrivateKey: ctx.aliceIdent.privateKey,
    });
    expect(m0.sequenceNumber).toBe(0);

    const m1 = await encryptMessageV3({
      roomId: ctx.roomId,
      epoch: 1,
      senderUid: ctx.aliceUid,
      senderDeviceId: ctx.aliceDeviceId,
      plaintext: 'second',
      epochKey: ctx.roomMasterKey,
      senderIdentityPrivateKey: ctx.aliceIdent.privateKey,
    });
    expect(m1.sequenceNumber).toBe(1);

    const d0 = await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey });
    const d1 = await receiveMessageV3({ message: m1, epochKey: ctx.roomMasterKey });

    expect(d0).toBe('first');
    expect(d1).toBe('second');
  });

  it('surfaces a clear error when the sender device record is missing (production path)', async () => {
    const ctx = await setupTwoDeviceRoom();

    const sent = await encryptMessageV3({
      roomId: ctx.roomId,
      epoch: 1,
      senderUid: ctx.aliceUid,
      senderDeviceId: ctx.aliceDeviceId,
      plaintext: 'hi',
      epochKey: ctx.roomMasterKey,
      senderIdentityPrivateKey: ctx.aliceIdent.privateKey,
    });

    // Remove the sender's device record, simulating an unregistered/stale device.
    delete mockDbStore[`users/${ctx.aliceUid}/devices/${ctx.aliceDeviceId}`];

    await expect(
      receiveMessageV3({ message: sent, epochKey: ctx.roomMasterKey })
    ).rejects.toThrow(/Unknown or unregistered device/);
  });

  it('surfaces a clear error when the sender device signature does not verify (production path)', async () => {
    const ctx = await setupTwoDeviceRoom();

    const sent = await encryptMessageV3({
      roomId: ctx.roomId,
      epoch: 1,
      senderUid: ctx.bobUid,
      senderDeviceId: ctx.bobDeviceId,
      plaintext: 'hi',
      epochKey: ctx.roomMasterKey,
      senderIdentityPrivateKey: ctx.bobIdent.privateKey,
    });

    // Tamper with the stored public key so the device bundle signature no longer verifies.
    // This is exactly the production symptom: stored signature_invalid.
    const path = `users/${ctx.bobUid}/devices/${ctx.bobDeviceId}`;
    const record = mockDbStore[path];
    record.publicKeys.identityECDSA.x = record.publicKeys.identityECDSA.x.replace(/^./, (c: string) =>
      c === 'A' ? 'B' : 'A'
    );
    mockDbStore[path] = record;

    await expect(
      receiveMessageV3({ message: sent, epochKey: ctx.roomMasterKey })
    ).rejects.toThrow(/signature verification failed/i);
  });
});
