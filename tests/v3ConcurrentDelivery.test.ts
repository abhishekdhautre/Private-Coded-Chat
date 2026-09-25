/**
 * Regression tests for CONCURRENT V3 delivery / send — the runtime shape behind
 * the intermittent "Unable to decrypt message." on a freshly sent bubble.
 *
 * Two real concurrency bugs were possible against a single ratchet chain:
 *
 *   1. `child_added` racing `child_changed` for the SAME row. The sender's own
 *      echo starts decrypting (one `get()` for the sender bundle) and the peer's
 *      read receipt writes `readBy/{uid}` onto that row while it is still in
 *      flight; the changed handler saw no cached entry and entered the receive
 *      path a second time. Two concurrent receives for one messageId both pass
 *      the early replay check (nothing is recorded yet), both read
 *      `state.sequenceNumber` across await points, derive a key for the SAME
 *      position and BOTH increment the counter — so the chain ends up ahead of
 *      its own key schedule and every later message from that device is rejected
 *      with "Sequence number N has already passed for active ratchet chain."
 *   2. Two overlapping sends (double submit) both minting the same sequence
 *      number, so the second row is rejected by every receiver.
 *
 * Fix under test: every read-modify-write of a chain runs inside
 * withRatchetChainLock(), keyed by (roomId, epoch, senderDeviceId, role) — the
 * exact key of the state it guards. Send and receive chains, and different
 * peers' chains, stay fully parallel. Sequence validation, replay protection,
 * ECDSA verification and AES-GCM are untouched.
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
    const prefix = refObj.path.endsWith('/') ? refObj.path + '/' : refObj.path + '/';
    const childKeys = Object.keys(mockDbStore).filter((k) => k.startsWith(prefix));
    if (childKeys.length > 0) {
      const parentObj: Record<string, any> = {};
      for (const key of childKeys) {
        parentObj[key.slice(prefix.length)] = mockDbStore[key];
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
import {
  encryptMessageV3,
  receiveMessageV3,
  clearReplayCache,
} from '@/lib/messageCryptoV2';
import { clearRatchetStore, getRatchetPosition } from '@/lib/ratchetV2';
import {
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  createDeviceIdentityBundle,
} from '@/lib/cryptoV2';
import { set, ref } from 'firebase/database';
import { db } from '@/lib/firebase';

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

async function setupRoom() {
  const roomId = `conc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const aliceUid = `alice_${Date.now()}`;
  const bobUid = `bob_${Date.now()}`;

  const aliceIdent = await generateIdentityKeyPair();
  const aliceExch = await generateExchangeKeyPair();
  const aliceDeviceId = `aliceDev_${Date.now()}`;
  const aliceBundle = await createDeviceIdentityBundle(aliceDeviceId, aliceIdent, aliceExch);

  const bobIdentity = await generateIdentityKeyPair();
  const bobExch = await generateExchangeKeyPair();
  const bobDeviceId = `bobDev_${Date.now()}`;
  const bobBundle = await createDeviceIdentityBundle(bobDeviceId, bobIdentity, bobExch);

  await registerDeviceInFirebase(aliceUid, aliceDeviceId, aliceBundle);
  await registerDeviceInFirebase(bobUid, bobDeviceId, bobBundle);

  const { roomMasterKey } = await createV2Room({
    roomId,
    participants: [aliceUid, bobUid].sort(),
    targetDevices: [
      { uid: aliceUid, deviceId: aliceDeviceId, exchangePublicKey: aliceBundle.payload.exchangePublicKey },
      { uid: bobUid, deviceId: bobDeviceId, exchangePublicKey: bobBundle.payload.exchangePublicKey },
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
    bobIdentity,
  };
}

type Ctx = Awaited<ReturnType<typeof setupRoom>>;

function sendAs(
  ctx: Ctx,
  who: 'alice' | 'bob',
  plaintext: string
) {
  const senderUid = who === 'alice' ? ctx.aliceUid : ctx.bobUid;
  const senderDeviceId = who === 'alice' ? ctx.aliceDeviceId : ctx.bobDeviceId;
  const identity =
    who === 'alice' ? ctx.aliceIdent.privateKey : ctx.bobIdentity.privateKey;
  return encryptMessageV3({
    roomId: ctx.roomId,
    epoch: 1,
    senderUid,
    senderDeviceId,
    plaintext,
    epochKey: ctx.roomMasterKey,
    senderIdentityPrivateKey: identity,
  });
}

function recv(ctx: Ctx, message: any) {
  return receiveMessageV3({ message, epochKey: ctx.roomMasterKey });
}

function position(ctx: Ctx, who: 'alice' | 'bob', role: 'send' | 'recv') {
  return getRatchetPosition({
    roomId: ctx.roomId,
    epoch: 1,
    senderDeviceId: who === 'alice' ? ctx.aliceDeviceId : ctx.bobDeviceId,
    role,
  });
}

function outcome<T>(results: PromiseSettledResult<T>[]) {
  return {
    fulfilled: results.filter((r) => r.status === 'fulfilled'),
    rejected: results.filter((r) => r.status === 'rejected'),
  };
}

describe('V3 concurrent send/delivery safety', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockDbStore)) delete mockDbStore[k];
    clearRatchetStore();
    clearReplayCache();
  });

  it('REGRESSION: a duplicate delivery of the SAME row cannot advance the receive chain twice', async () => {
    const ctx = await setupRoom();
    const m0 = await sendAs(ctx, 'alice', 'hello');

    // child_added and child_changed for one row, both entering the receive path
    // before either has finished (peer read receipt lands mid-decrypt).
    const results = await Promise.allSettled([recv(ctx, m0), recv(ctx, m0)]);
    const { fulfilled, rejected } = outcome(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser is rejected by replay protection — NOT by sequence validation,
    // which is what the unlocked race produced.
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /Replay attack detected/
    );

    // The chain advanced exactly once, to exactly the expected position.
    expect(position(ctx, 'alice', 'recv')).toBe(1);
    expect(position(ctx, 'alice', 'send')).toBe(1);
  });

  it('REGRESSION: concurrent + out-of-order deliveries on one chain all decrypt and land on the right position', async () => {
    const ctx = await setupRoom();
    const m0 = await sendAs(ctx, 'alice', 'zero');
    const m1 = await sendAs(ctx, 'alice', 'one');
    const m2 = await sendAs(ctx, 'alice', 'two');

    // History replay (listener re-subscription / remount) processes three rows
    // concurrently and in a scrambled order.
    const results = await Promise.allSettled([recv(ctx, m2), recv(ctx, m0), recv(ctx, m1)]);
    const { fulfilled, rejected } = outcome(results);

    expect(rejected).toHaveLength(0);
    expect(
      fulfilled.map((r) => (r as PromiseFulfilledResult<string>).value)
    ).toEqual(['two', 'zero', 'one']);

    // Advanced once per message — never twice, never zero times.
    expect(position(ctx, 'alice', 'recv')).toBe(3);
    expect(position(ctx, 'alice', 'send')).toBe(3);
  });

  it('REGRESSION: an already-processed message is rejected on replay WITHOUT moving the chain', async () => {
    const ctx = await setupRoom();
    const m0 = await sendAs(ctx, 'alice', 'one');
    const m1 = await sendAs(ctx, 'alice', 'two');

    await recv(ctx, m0);
    await recv(ctx, m1);
    const before = position(ctx, 'alice', 'recv');
    expect(before).toBe(2);

    // Listener replay / component remount redelivering history.
    await expect(recv(ctx, m0)).rejects.toThrow(/Replay attack detected/);
    await expect(recv(ctx, m1)).rejects.toThrow(/Replay attack detected/);

    expect(position(ctx, 'alice', 'recv')).toBe(before);
  });

  it('REGRESSION: two concurrent sends mint distinct sequence numbers', async () => {
    const ctx = await setupRoom();

    const [first, second] = await Promise.all([
      sendAs(ctx, 'alice', 'one'),
      sendAs(ctx, 'alice', 'two'),
    ]);

    expect(first.sequenceNumber).toBe(0);
    expect(second.sequenceNumber).toBe(1);
    expect(position(ctx, 'alice', 'send')).toBe(2);

    // Both rows are still readable through the normal receive path.
    expect(await recv(ctx, first)).toBe('one');
    expect(await recv(ctx, second)).toBe('two');
    expect(position(ctx, 'alice', 'recv')).toBe(2);
  });

  it('two-device exchange keeps each device chains independent under concurrency', async () => {
    const ctx = await setupRoom();

    const [a0, a1] = await Promise.all([
      sendAs(ctx, 'alice', 'from alice'),
      sendAs(ctx, 'alice', 'and again'),
    ]);

    // Bob receives Alice's rows (Alice's RECEIVE chain, in Bob's context).
    const bobView = await Promise.allSettled([recv(ctx, a0), recv(ctx, a1)]);
    expect(outcome(bobView).rejected).toHaveLength(0);
    expect(position(ctx, 'alice', 'recv')).toBe(2);

    // Bob replies on his OWN send chain — untouched by anything above.
    const [b0] = await Promise.all([sendAs(ctx, 'bob', 'reply')]);
    expect(b0.sequenceNumber).toBe(0);
    expect(position(ctx, 'bob', 'send')).toBe(1);
    expect(position(ctx, 'alice', 'send')).toBe(2);

    // Alice decrypts Bob's reply through her independent receive chain for Bob.
    expect(await recv(ctx, b0)).toBe('reply');
    expect(position(ctx, 'bob', 'recv')).toBe(1);
    expect(position(ctx, 'alice', 'recv')).toBe(2);
  });

  it("the sender still decrypts its own Firebase echo when no local send result is available", async () => {
    const ctx = await setupRoom();
    const m0 = await sendAs(ctx, 'alice', 'mine');

    // No local-echo entry (fresh context / remount) → normal receive path.
    expect(await recv(ctx, m0)).toBe('mine');
    expect(position(ctx, 'alice', 'recv')).toBe(1);
    // Sending and receiving are separate chains: the echo never rewinds the
    // send chain, and the send chain never consumed the receive position.
    expect(position(ctx, 'alice', 'send')).toBe(1);
  });
});
