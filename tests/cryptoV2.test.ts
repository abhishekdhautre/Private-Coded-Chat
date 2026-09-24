import { describe, expect, it, beforeEach } from 'vitest';
import {
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  exportPublicKey,
  importPublicKey,
  sign,
  verify,
  canonicalize,
  canonicalSerialize,
  createDeviceIdentityBundle,
  verifyDeviceIdentityBundle,
  isWebCryptoSupported,
} from '@/lib/cryptoV2';
import {
  saveDeviceKeys,
  loadDeviceKeys,
  clearDeviceKeys,
  isIndexedDBSupported,
  DeviceKeysRecord,
} from '@/lib/keyStorage';

describe('Web Crypto V2 & Key Storage (Phase 1)', () => {
  beforeEach(async () => {
    await clearDeviceKeys();
  });

  it('detects Web Crypto API support', () => {
    expect(isWebCryptoSupported()).toBe(true);
  });

  it('generates non-extractable identity keypair (ECDSA P-256)', async () => {
    const keyPair = await generateIdentityKeyPair();
    expect(keyPair.privateKey.type).toBe('private');
    expect(keyPair.publicKey.type).toBe('public');
    expect(keyPair.privateKey.algorithm.name).toBe('ECDSA');
    expect((keyPair.privateKey.algorithm as EcKeyAlgorithm).namedCurve).toBe('P-256');
    expect(keyPair.privateKey.extractable).toBe(false);
  });

  it('generates non-extractable exchange keypair (ECDH P-256)', async () => {
    const keyPair = await generateExchangeKeyPair();
    expect(keyPair.privateKey.type).toBe('private');
    expect(keyPair.publicKey.type).toBe('public');
    expect(keyPair.privateKey.algorithm.name).toBe('ECDH');
    expect((keyPair.privateKey.algorithm as EcKeyAlgorithm).namedCurve).toBe('P-256');
    expect(keyPair.privateKey.extractable).toBe(false);
  });

  it('exports and imports public keys correctly', async () => {
    const identityKeyPair = await generateIdentityKeyPair();
    const exportedJwk = await exportPublicKey(identityKeyPair.publicKey);
    expect(exportedJwk.kty).toBe('EC');
    expect(exportedJwk.crv).toBe('P-256');

    const importedKey = await importPublicKey(exportedJwk, 'ECDSA');
    expect(importedKey.type).toBe('public');
    expect(importedKey.algorithm.name).toBe('ECDSA');
  });

  it('signs data and verifies valid signatures', async () => {
    const identityKeyPair = await generateIdentityKeyPair();
    const data = new TextEncoder().encode('Hello E2EE Phase 1');

    const signature = await sign(identityKeyPair.privateKey, data);
    expect(signature.byteLength).toBeGreaterThan(0);

    const isValid = await verify(identityKeyPair.publicKey, signature, data);
    expect(isValid).toBe(true);
  });

  it('rejects invalid or tampered signatures', async () => {
    const identityKeyPair = await generateIdentityKeyPair();
    const data = new TextEncoder().encode('Original Data');
    const signature = await sign(identityKeyPair.privateKey, data);

    // Test tampered data
    const tamperedData = new TextEncoder().encode('Tampered Data');
    const isTamperedValid = await verify(
      identityKeyPair.publicKey,
      signature,
      tamperedData
    );
    expect(isTamperedValid).toBe(false);

    // Test wrong public key
    const anotherKeyPair = await generateIdentityKeyPair();
    const isWrongKeyValid = await verify(
      anotherKeyPair.publicKey,
      signature,
      data
    );
    expect(isWrongKeyValid).toBe(false);
  });

  it('creates and verifies a signed device identity bundle', async () => {
    const deviceId = 'test-device-uuid-1234';
    const identityKeyPair = await generateIdentityKeyPair();
    const exchangeKeyPair = await generateExchangeKeyPair();

    const bundle = await createDeviceIdentityBundle(
      deviceId,
      identityKeyPair,
      exchangeKeyPair,
      1758720000000
    );

    expect(bundle.payload.deviceId).toBe(deviceId);
    expect(bundle.payload.identityPublicKey.kty).toBe('EC');
    expect(bundle.payload.exchangePublicKey.kty).toBe('EC');
    expect(bundle.signature).toBeTruthy();

    const isValidBundle = await verifyDeviceIdentityBundle(bundle);
    expect(isValidBundle).toBe(true);
  });

  it('saves and loads device keys in keyStorage', async () => {
    const deviceId = 'test-storage-device-5678';
    const identityKeyPair = await generateIdentityKeyPair();
    const exchangeKeyPair = await generateExchangeKeyPair();

    const record: DeviceKeysRecord = {
      deviceId,
      identityPrivateKey: identityKeyPair.privateKey,
      identityPublicKey: identityKeyPair.publicKey,
      exchangePrivateKey: exchangeKeyPair.privateKey,
      exchangePublicKey: exchangeKeyPair.publicKey,
      createdAt: 1758720000000,
    };

    await saveDeviceKeys(record);

    const loadedRecord = await loadDeviceKeys();
    expect(loadedRecord).not.toBeNull();
    expect(loadedRecord?.deviceId).toBe(deviceId);
    expect(loadedRecord?.identityPrivateKey.algorithm.name).toBe('ECDSA');
    expect(loadedRecord?.exchangePrivateKey.algorithm.name).toBe('ECDH');
  });

  it('simulates device identity persistence across app reloads', async () => {
    // Session 1: Create and persist keys
    const deviceId = 'persistent-device-9999';
    const identityKeyPair = await generateIdentityKeyPair();
    const exchangeKeyPair = await generateExchangeKeyPair();

    const initialRecord: DeviceKeysRecord = {
      deviceId,
      identityPrivateKey: identityKeyPair.privateKey,
      identityPublicKey: identityKeyPair.publicKey,
      exchangePrivateKey: exchangeKeyPair.privateKey,
      exchangePublicKey: exchangeKeyPair.publicKey,
      createdAt: Date.now(),
    };

    await saveDeviceKeys(initialRecord);

    // Session 2: Reload (simulate app start fetching existing keys)
    const reloadedRecord = await loadDeviceKeys();
    expect(reloadedRecord).not.toBeNull();
    expect(reloadedRecord?.deviceId).toBe(deviceId);

    // Sign message using reloaded private key and verify with reloaded public key
    const testData = new TextEncoder().encode('Persistence test payload');
    const sig = await sign(reloadedRecord!.identityPrivateKey, testData);
    const verified = await verify(reloadedRecord!.identityPublicKey, sig, testData);
    expect(verified).toBe(true);
  });

  it('canonicalizes JSON payloads deterministically regardless of key order', () => {
    const objA = { z: 1, a: { b: 2, a: 1 } };
    const objB = { a: { a: 1, b: 2 }, z: 1 };
    expect(canonicalize(objA)).toBe(canonicalize(objB));
  });
});
