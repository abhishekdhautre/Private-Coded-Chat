/**
 * Regression tests for the V3 send-sequence RESUME path.
 *
 * Root cause under test: the Phase 5 ratchet chain is deliberately in-memory
 * only, so a full page load / mobile tab eviction / crash restore wipes it
 * while the room's message rows (and every receiver's receive chain) stay put.
 * The send chain then restarted at sequence 0 and re-minted an already-used
 * sequence number, which receiveMessageV3 rejects with
 * "Sequence number N has already passed for active ratchet chain." — surfacing
 * in the UI as "Unable to decrypt message." on the sender's OWN bubble (the
 * Firebase echo runs through the same receive path).
 *
 * These tests cover:
 *   - normal V3 send/receive (unchanged behaviour)
 *   - self-message (own Firebase echo) handling
 *   - recreated/remounted chat state resuming instead of reusing sequences
 *   - ratchet sequence continuity across that resume
 *   - duplicate delivery (replay protection still authoritative)
 *   - out-of-order delivery (skipped-key catch-up still works)
 *   - proof that receive-side sequence validation was NOT relaxed
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
        const subKey = key.slice(prefix.length);
        parentObj[subKey] = mockDbStore[key];
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
import {
  clearRatchetStore,
  getRatchetPosition,
  ensureRatchetSequenceFloor,
  MAX_SEQUENCE_FLOOR_ADVANCE,
} from '@/lib/ratchetV2';
import {
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  createDeviceIdentityBundle,
  sign,
  canonicalize,
  arrayBufferToBase64,
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

async function setupRoom() {
  const roomId = `resume_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

function sendFrom(ctx: Ctx, plaintext: string, minSequenceNumber?: number) {
  return encryptMessageV3({
    roomId: ctx.roomId,
    epoch: 1,
    senderUid: ctx.aliceUid,
    senderDeviceId: ctx.aliceDeviceId,
    plaintext,
    epochKey: ctx.roomMasterKey,
    senderIdentityPrivateKey: ctx.aliceIdent.privateKey,
    minSequenceNumber,
  });
}

/** Wipes the module-level ratchet + replay stores — i.e. a fresh JS context. */
function simulateContextLoss() {
  clearRatchetStore();
  clearReplayCache();
}

describe('V3 send sequence resume after in-memory ratchet loss', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockDbStore)) delete mockDbStore[k];
    simulateContextLoss();
  });

  it('normal V3 send/receive still starts at sequence 0 with no floor supplied', async () => {
    const ctx = await setupRoom();
    const m0 = await sendFrom(ctx, 'hello');
    expect(m0.sequenceNumber).toBe(0);
    expect(await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey })).toBe('hello');
  });

  it("sender decrypts its own Firebase echo (self-message) with independent send/recv chains", async () => {
    const ctx = await setupRoom();
    const m0 = await sendFrom(ctx, 'mine');
    const m1 = await sendFrom(ctx, 'mine too');
    expect(m0.sequenceNumber).toBe(0);
    expect(m1.sequenceNumber).toBe(1);

    // The chat listener runs the sender's own rows through the same receive path.
    expect(await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey })).toBe('mine');
    expect(await receiveMessageV3({ message: m1, epochKey: ctx.roomMasterKey })).toBe('mine too');

    // Send chain and receive chain stay logically independent (role-suffixed
    // store keys) and both advanced exactly once per message.
    expect(getRatchetPosition({ roomId: ctx.roomId, epoch: 1, senderDeviceId: ctx.aliceDeviceId, role: 'send' })).toBe(2);
    expect(getRatchetPosition({ roomId: ctx.roomId, epoch: 1, senderDeviceId: ctx.aliceDeviceId, role: 'recv' })).toBe(2);
  });

  it('REGRESSION: after a JS context loss the next send resumes instead of reusing sequence 0', async () => {
    const ctx = await setupRoom();

    // Live session: two sent messages, both echoed/processed locally.
    const m0 = await sendFrom(ctx, 'one');
    const m1 = await sendFrom(ctx, 'two');
    expect(m0.sequenceNumber).toBe(0);
    expect(m1.sequenceNumber).toBe(1);
    await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey });
    await receiveMessageV3({ message: m1, epochKey: ctx.roomMasterKey });

    // iOS tab eviction / full page load: only the in-memory stores die.
    simulateContextLoss();
    expect(getRatchetPosition({ roomId: ctx.roomId, epoch: 1, senderDeviceId: ctx.aliceDeviceId, role: 'send' })).toBeNull();
    expect(getRatchetPosition({ roomId: ctx.roomId, epoch: 1, senderDeviceId: ctx.aliceDeviceId, role: 'recv' })).toBeNull();

    // Listener re-attaches and replays history (rebuilds the receive chain).
    await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey });
    await receiveMessageV3({ message: m1, epochKey: ctx.roomMasterKey });
    expect(getRatchetPosition({ roomId: ctx.roomId, epoch: 1, senderDeviceId: ctx.aliceDeviceId, role: 'recv' })).toBe(2);

    // The chat page observed rows 0 and 1, so it hands the floor 2 to the send.
    const m2 = await sendFrom(ctx, 'three', 2);
    expect(m2.sequenceNumber).toBe(2); // NOT 0 — no sequence reuse

    // Sequence continuity across the resume.
    const m3 = await sendFrom(ctx, 'four', 3);
    expect(m3.sequenceNumber).toBe(3);

    // Sender's own echo decrypts…
    expect(await receiveMessageV3({ message: m2, epochKey: ctx.roomMasterKey })).toBe('three');
    expect(await receiveMessageV3({ message: m3, epochKey: ctx.roomMasterKey })).toBe('four');
  });

  it('REGRESSION: a resumed sender is also readable by the peer (no "already passed")', async () => {
    const ctx = await setupRoom();
    const m0 = await sendFrom(ctx, 'one');
    const m1 = await sendFrom(ctx, 'two');

    // Peer's live context consumed both messages.
    await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey });
    await receiveMessageV3({ message: m1, epochKey: ctx.roomMasterKey });

    // Sender's context is recreated; the peer's is not (it never resets here).
    simulateContextLoss();
    await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey });
    await receiveMessageV3({ message: m1, epochKey: ctx.roomMasterKey });

    const m2 = await sendFrom(ctx, 'three', 2);
    expect(m2.sequenceNumber).toBe(2);
    expect(await receiveMessageV3({ message: m2, epochKey: ctx.roomMasterKey })).toBe('three');
  });

  it('resume floor also comes from the rebuilt receive chain when no row metadata is supplied', async () => {
    const ctx = await setupRoom();
    const m0 = await sendFrom(ctx, 'one');
    const m1 = await sendFrom(ctx, 'two');

    simulateContextLoss();
    // History replay rebuilt only the RECEIVE chain (no UI floor available).
    await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey });
    await receiveMessageV3({ message: m1, epochKey: ctx.roomMasterKey });

    const m2 = await sendFrom(ctx, 'three'); // no minSequenceNumber
    expect(m2.sequenceNumber).toBe(2);
    expect(await receiveMessageV3({ message: m2, epochKey: ctx.roomMasterKey })).toBe('three');
  });

  it('works when rows arrive before history has finished decrypting (receive chain still at 0)', async () => {
    const ctx = await setupRoom();
    const m0 = await sendFrom(ctx, 'one');
    const m1 = await sendFrom(ctx, 'two');

    simulateContextLoss();
    // Listener has seen the rows (floor = 2) but decryption has not run yet.
    const m2 = await sendFrom(ctx, 'three', 2);
    expect(m2.sequenceNumber).toBe(2);

    // A device that then replays everything — including out of order — still
    // decrypts all three messages.
    expect(await receiveMessageV3({ message: m2, epochKey: ctx.roomMasterKey })).toBe('three');
    expect(await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey })).toBe('one');
    expect(await receiveMessageV3({ message: m1, epochKey: ctx.roomMasterKey })).toBe('two');
  });

  it('out-of-order delivery still uses skipped keys (unchanged)', async () => {
    const ctx = await setupRoom();
    const m0 = await sendFrom(ctx, 'zero');
    const m1 = await sendFrom(ctx, 'one');
    const m2 = await sendFrom(ctx, 'two');

    expect(await receiveMessageV3({ message: m2, epochKey: ctx.roomMasterKey })).toBe('two');
    expect(await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey })).toBe('zero');
    expect(await receiveMessageV3({ message: m1, epochKey: ctx.roomMasterKey })).toBe('one');
  });

  it('duplicate delivery of the same messageId is still rejected by replay protection', async () => {
    const ctx = await setupRoom();
    const m0 = await sendFrom(ctx, 'once');

    expect(await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey })).toBe('once');
    await expect(
      receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey })
    ).rejects.toThrow(/Replay attack detected/);
  });

  it('receive-side sequence validation was NOT relaxed: a passed sequence with a fresh messageId is still rejected', async () => {
    const ctx = await setupRoom();
    const m0 = await sendFrom(ctx, 'zero');
    const m1 = await sendFrom(ctx, 'one');

    await receiveMessageV3({ message: m0, epochKey: ctx.roomMasterKey });
    await receiveMessageV3({ message: m1, epochKey: ctx.roomMasterKey });

    // A new messageId at an already-consumed sequence number, correctly signed
    // by the sender's identity key (so signature verification passes) — the
    // ratchet sequence check must still refuse it. This is the guard that
    // makes sequence reuse visible instead of silently decryptable.
    const reissued = { ...m0, messageId: `reissued_${Date.now()}` };
    const payloadToSign = {
      ciphertext: reissued.ciphertext,
      cryptoVersion: reissued.cryptoVersion,
      epoch: reissued.epoch,
      iv: reissued.iv,
      messageId: reissued.messageId,
      roomId: reissued.roomId,
      senderDeviceId: reissued.senderDeviceId,
      senderUid: reissued.senderUid,
      sequenceNumber: reissued.sequenceNumber,
      timestamp: reissued.timestamp,
    };
    const sig = await sign(
      ctx.aliceIdent.privateKey,
      new TextEncoder().encode(canonicalize(payloadToSign))
    );
    reissued.signature = arrayBufferToBase64(sig);

    await expect(
      receiveMessageV3({ message: reissued, epochKey: ctx.roomMasterKey })
    ).rejects.toThrow(/Sequence number 0 has already passed/);
  });

  it('floor helper refuses an absurd floor instead of spinning the tab', async () => {
    const ctx = await setupRoom();
    await expect(
      ensureRatchetSequenceFloor({
        roomId: ctx.roomId,
        epoch: 1,
        senderDeviceId: ctx.aliceDeviceId,
        epochKey: ctx.roomMasterKey,
        role: 'send',
        targetSequenceNumber: MAX_SEQUENCE_FLOOR_ADVANCE + 1,
      })
    ).rejects.toThrow(/Refusing to resume ratchet chain/);
    // Nothing was advanced.
    expect(getRatchetPosition({ roomId: ctx.roomId, epoch: 1, senderDeviceId: ctx.aliceDeviceId, role: 'send' })).toBe(0);
  });

  it('floor is a no-op when the send chain is already ahead (warm context)', async () => {
    const ctx = await setupRoom();
    await sendFrom(ctx, 'one');
    await sendFrom(ctx, 'two');
    // Stale floor below the live position must not rewind or disturb the chain.
    const m2 = await sendFrom(ctx, 'three', 1);
    expect(m2.sequenceNumber).toBe(2);
    expect(await receiveMessageV3({ message: m2, epochKey: ctx.roomMasterKey })).toBe('three');
  });
});
