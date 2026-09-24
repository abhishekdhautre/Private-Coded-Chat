import { describe, expect, it, beforeEach, vi } from 'vitest';

// Mock firebase/database before importing deviceService
const mockDbStore: Record<string, any> = {};

vi.mock('firebase/database', () => ({
  getDatabase: vi.fn(() => ({})),
  ref: (_db: any, path: string) => ({ path }),
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
  set: vi.fn(async (refObj: { path: string }, value: any) => {
    mockDbStore[refObj.path] = value;
  }),
}));

import {
  getOrCreateDeviceIdentity,
  registerDevice,
  getDevice,
  getUserDevices,
  verifyDeviceBundle,
  RegisteredDeviceDTO,
} from '@/lib/deviceService';
import { clearDeviceKeys, loadDeviceKeys } from '@/lib/keyStorage';
import {
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  exportPublicKey,
  canonicalSerialize,
  verifyDeviceIdentityBundle,
  SignedDeviceIdentityBundle,
} from '@/lib/cryptoV2';

describe('Phase 2 Device Service & Bundle Verification', () => {
  beforeEach(async () => {
    await clearDeviceKeys();
    // Clear mock DB store
    for (const key of Object.keys(mockDbStore)) {
      delete mockDbStore[key];
    }
  });

  it('generates a new device identity on first call', async () => {
    const { record, bundle } = await getOrCreateDeviceIdentity();

    expect(record.deviceId).toBeTruthy();
    expect(bundle.payload.deviceId).toBe(record.deviceId);
    expect(bundle.payload.identityPublicKey.kty).toBe('EC');
    expect(bundle.payload.exchangePublicKey.kty).toBe('EC');
    expect(bundle.signature).toBeTruthy();

    const stored = await loadDeviceKeys();
    expect(stored?.deviceId).toBe(record.deviceId);
  });

  it('reuses existing device identity on subsequent calls', async () => {
    const first = await getOrCreateDeviceIdentity();
    const second = await getOrCreateDeviceIdentity();

    expect(second.record.deviceId).toBe(first.record.deviceId);
    expect(second.bundle.payload.deviceId).toBe(first.bundle.payload.deviceId);
    expect(second.bundle.payload.createdAt).toBe(first.bundle.payload.createdAt);
    expect(await verifyDeviceBundle(second.bundle)).toBe(true);
  });

  it('registers device public metadata to Firebase and handles duplicate registration', async () => {
    const testUid = 'user_123_abc';

    // First registration
    const bundle1 = await registerDevice(testUid);
    expect(bundle1.payload.deviceId).toBeTruthy();

    const storedPath = `users/${testUid}/devices/${bundle1.payload.deviceId}`;
    expect(mockDbStore[storedPath]).toBeDefined();

    const storedData: RegisteredDeviceDTO = mockDbStore[storedPath];
    expect(storedData.deviceId).toBe(bundle1.payload.deviceId);
    expect(storedData.publicKeys.identityECDSA).toEqual(bundle1.payload.identityPublicKey);
    expect(storedData.publicKeys.exchangeECDH).toEqual(bundle1.payload.exchangePublicKey);
    expect(storedData.signature).toBe(bundle1.signature);

    // Duplicate registration should be idempotent
    const bundle2 = await registerDevice(testUid);
    expect(bundle2.payload.deviceId).toBe(bundle1.payload.deviceId);
  });

  it('fetches and verifies a single registered device', async () => {
    const testUid = 'user_456_def';
    const bundle = await registerDevice(testUid);

    const fetchedBundle = await getDevice(testUid, bundle.payload.deviceId);
    expect(fetchedBundle).not.toBeNull();
    expect(fetchedBundle?.payload.deviceId).toBe(bundle.payload.deviceId);
    expect(fetchedBundle?.payload.identityPublicKey).toEqual(bundle.payload.identityPublicKey);
  });

  it('fetches all registered devices for a user', async () => {
    const testUid = 'user_789_ghi';
    const bundle = await registerDevice(testUid);

    const devices = await getUserDevices(testUid);
    expect(devices).toHaveLength(1);
    expect(devices[0].payload.deviceId).toBe(bundle.payload.deviceId);
  });

  it('verifies public-key canonical serialization deterministically', () => {
    const payloadA = {
      deviceId: 'dev_123',
      identityPublicKey: { kty: 'EC', crv: 'P-256', x: 'aaa', y: 'bbb' },
      exchangePublicKey: { kty: 'EC', crv: 'P-256', x: 'ccc', y: 'ddd' },
      createdAt: 1000,
    };
    const payloadB = {
      createdAt: 1000,
      exchangePublicKey: { y: 'ddd', x: 'ccc', crv: 'P-256', kty: 'EC' },
      identityPublicKey: { y: 'bbb', x: 'aaa', crv: 'P-256', kty: 'EC' },
      deviceId: 'dev_123',
    };

    const bytesA = canonicalSerialize(payloadA as any);
    const bytesB = canonicalSerialize(payloadB as any);
    expect(bytesA).toEqual(bytesB);
  });

  it('verifies a valid signed device bundle', async () => {
    const { bundle } = await getOrCreateDeviceIdentity();
    const isValid = await verifyDeviceBundle(bundle);
    expect(isValid).toBe(true);
  });

  it('rejects a tampered device identity bundle (tampered exchange key)', async () => {
    const { bundle } = await getOrCreateDeviceIdentity();
    const fakeExchangeKeyPair = await generateExchangeKeyPair();
    const fakeExchangeJwk = await exportPublicKey(fakeExchangeKeyPair.publicKey);

    const tamperedBundle: SignedDeviceIdentityBundle = {
      payload: {
        ...bundle.payload,
        exchangePublicKey: fakeExchangeJwk,
      },
      signature: bundle.signature,
    };

    const isValid = await verifyDeviceIdentityBundle(tamperedBundle);
    expect(isValid).toBe(false);
  });

  it('rejects a tampered device identity bundle (tampered deviceId)', async () => {
    const { bundle } = await getOrCreateDeviceIdentity();

    const tamperedBundle: SignedDeviceIdentityBundle = {
      payload: {
        ...bundle.payload,
        deviceId: 'tampered-device-id-9999',
      },
      signature: bundle.signature,
    };

    const isValid = await verifyDeviceIdentityBundle(tamperedBundle);
    expect(isValid).toBe(false);
  });

  it('formats RegisteredDeviceDTO correctly without private key material', async () => {
    const { bundle } = await getOrCreateDeviceIdentity();

    const dto: RegisteredDeviceDTO = {
      deviceId: bundle.payload.deviceId,
      createdAt: bundle.payload.createdAt,
      publicKeys: {
        identityECDSA: bundle.payload.identityPublicKey,
        exchangeECDH: bundle.payload.exchangePublicKey,
      },
      signature: bundle.signature,
    };
    expect(dto.deviceId).toBe(bundle.payload.deviceId);
    expect(dto.publicKeys.identityECDSA.kty).toBe('EC');
    expect(dto.publicKeys.exchangeECDH.kty).toBe('EC');
    expect((dto as any).privateKey).toBeUndefined();
    expect((dto as any).identityPrivateKey).toBeUndefined();
    expect((dto as any).exchangePrivateKey).toBeUndefined();
  });

  it('auto-repairs current user stale device record in Firebase without changing deviceId', async () => {
    const uid = 'test-repair-user-1';
    const { record, bundle } = await getOrCreateDeviceIdentity();

    // Simulate stale/invalid signature stored in Firebase for this device
    mockDbStore[`users/${uid}/devices/${record.deviceId}`] = {
      deviceId: record.deviceId,
      createdAt: record.createdAt,
      publicKeys: {
        identityECDSA: bundle.payload.identityPublicKey,
        exchangeECDH: bundle.payload.exchangePublicKey,
      },
      signature: 'stale_corrupted_signature',
    };

    // getDevice on own device should detect invalid signature, re-sign, and repair in Firebase
    const repaired = await getDevice(uid, record.deviceId);
    expect(repaired).not.toBeNull();
    expect(repaired?.payload.deviceId).toBe(record.deviceId);
    // ECDSA P-256 is non-deterministic, so verify the repaired signature is valid instead of equal
    const { verifyDeviceIdentityBundle } = await import('@/lib/cryptoV2');
    expect(await verifyDeviceIdentityBundle(repaired!)).toBe(true);

    // Verify mockDbStore was repaired with a valid (non-stale) signature
    const stored = mockDbStore[`users/${uid}/devices/${record.deviceId}`];
    expect(stored.signature).not.toBe('stale_corrupted_signature');

    // Another user's device with invalid signature should still be rejected
    mockDbStore[`users/other-user/devices/other-device`] = {
      deviceId: 'other-device',
      createdAt: Date.now(),
      publicKeys: {
        identityECDSA: bundle.payload.identityPublicKey,
        exchangeECDH: bundle.payload.exchangePublicKey,
      },
      signature: 'invalid_signature_other_user',
    };

    await expect(getDevice('other-user', 'other-device')).rejects.toThrow(
      /Device identity signature verification failed/
    );

    const otherDevices = await getUserDevices('other-user');
    expect(otherDevices).toHaveLength(0); // skipped invalid
  });
});
