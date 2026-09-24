/**
 * Device Registration Service for End-to-End Encryption (Phase 2)
 *
 * Manages local device identity creation, registration of public device bundles to Firebase,
 * and fetching/verifying device public keys.
 */

import { ref, get, set } from 'firebase/database';
import { db } from '@/lib/firebase';
import {
  createDeviceIdentityBundle,
  verifyDeviceIdentityBundle,
  generateIdentityKeyPair,
  generateExchangeKeyPair,
  SignedDeviceIdentityBundle,
} from '@/lib/cryptoV2';
import {
  loadDeviceKeys,
  saveDeviceKeys,
  DeviceKeysRecord,
} from '@/lib/keyStorage';

export interface RegisteredDeviceDTO {
  deviceId: string;
  createdAt: number;
  publicKeys: {
    identityECDSA: JsonWebKey;
    exchangeECDH: JsonWebKey;
  };
  signature: string;
}

/**
 * Loads existing device identity from IndexedDB or generates a new one.
 * Reuses persistent deviceId and keys across logins/refreshes.
 */
export async function getOrCreateDeviceIdentity(): Promise<{
  record: DeviceKeysRecord;
  bundle: SignedDeviceIdentityBundle;
}> {
  let record = await loadDeviceKeys();

  if (!record) {
    const deviceId =
      typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `device_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const identityKeyPair = await generateIdentityKeyPair();
    const exchangeKeyPair = await generateExchangeKeyPair();
    const createdAt = Date.now();

    record = {
      deviceId,
      identityPrivateKey: identityKeyPair.privateKey,
      identityPublicKey: identityKeyPair.publicKey,
      exchangePrivateKey: exchangeKeyPair.privateKey,
      exchangePublicKey: exchangeKeyPair.publicKey,
      createdAt,
    };

    await saveDeviceKeys(record);
  }

  const bundle = await createDeviceIdentityBundle(
    record.deviceId,
    {
      privateKey: record.identityPrivateKey,
      publicKey: record.identityPublicKey,
    },
    {
      privateKey: record.exchangePrivateKey,
      publicKey: record.exchangePublicKey,
    },
    record.createdAt
  );

  return { record, bundle };
}

/**
 * Registers the current device public bundle at /users/{uid}/devices/{deviceId}.
 * Skips write if the exact device record is already registered in Firebase and has a valid signature.
 */
export async function registerDevice(
  uid: string
): Promise<SignedDeviceIdentityBundle> {
  if (!uid) {
    throw new Error('Cannot register device: User UID is required.');
  }

  const { bundle } = await getOrCreateDeviceIdentity();
  const devicePath = `users/${uid}/devices/${bundle.payload.deviceId}`;
  const deviceRef = ref(db, devicePath);

  // Check if device record already exists in Firebase
  const snapshot = await get(deviceRef);
  if (snapshot.exists()) {
    const existing = snapshot.val() as RegisteredDeviceDTO;
    if (existing) {
      const existingBundle: SignedDeviceIdentityBundle = {
        payload: {
          deviceId: existing.deviceId || bundle.payload.deviceId,
          identityPublicKey: existing.publicKeys.identityECDSA,
          exchangePublicKey: existing.publicKeys.exchangeECDH,
          createdAt: existing.createdAt,
        },
        signature: existing.signature,
      };
      const isExistingValid = await verifyDeviceIdentityBundle(existingBundle).catch(() => false);
      if (isExistingValid && existing.signature === bundle.signature) {
        // Already registered with valid matching signature & keys
        return bundle;
      }
    }
  }

  // Verify the fresh bundle before overwriting the stale record
  const isFreshValid = await verifyDeviceIdentityBundle(bundle);
  if (!isFreshValid) {
    throw new Error("Generated device identity bundle failed self-verification.");
  }

  // Write ONLY public device metadata (NO private keys)
  const payloadToStore: RegisteredDeviceDTO = {
    deviceId: bundle.payload.deviceId,
    createdAt: bundle.payload.createdAt,
    publicKeys: {
      identityECDSA: bundle.payload.identityPublicKey,
      exchangeECDH: bundle.payload.exchangePublicKey,
    },
    signature: bundle.signature,
  };

  await set(deviceRef, payloadToStore);
  return bundle;
}

/**
 * Fetches and verifies a single device's public identity bundle from Firebase.
 * If the current authenticated user's own device fails verification, repairs it using IndexedDB keys.
 * Throws an error if signature verification fails for another user's device or bundle is tampered.
 */
export async function getDevice(
  uid: string,
  deviceId: string
): Promise<SignedDeviceIdentityBundle | null> {
  const deviceRef = ref(db, `users/${uid}/devices/${deviceId}`);
  const snapshot = await get(deviceRef);

  if (!snapshot.exists()) {
    return null;
  }

  const data = snapshot.val() as RegisteredDeviceDTO;
  const bundle: SignedDeviceIdentityBundle = {
    payload: {
      deviceId: data.deviceId,
      identityPublicKey: data.publicKeys.identityECDSA,
      exchangePublicKey: data.publicKeys.exchangeECDH,
      createdAt: data.createdAt,
    },
    signature: data.signature,
  };

  const isValid = await verifyDeviceIdentityBundle(bundle).catch(() => false);
  if (!isValid) {
    // Check if this is the authenticated user's OWN device from IndexedDB
    const localRecord = await loadDeviceKeys().catch(() => null);
    if (localRecord && localRecord.deviceId === deviceId) {
      const repairedBundle = await createDeviceIdentityBundle(
        localRecord.deviceId,
        {
          privateKey: localRecord.identityPrivateKey,
          publicKey: localRecord.identityPublicKey,
        },
        {
          privateKey: localRecord.exchangePrivateKey,
          publicKey: localRecord.exchangePublicKey,
        },
        localRecord.createdAt
      );
      const isRepairedValid = await verifyDeviceIdentityBundle(repairedBundle);
      if (isRepairedValid) {
        const payloadToStore: RegisteredDeviceDTO = {
          deviceId: repairedBundle.payload.deviceId,
          createdAt: repairedBundle.payload.createdAt,
          publicKeys: {
            identityECDSA: repairedBundle.payload.identityPublicKey,
            exchangeECDH: repairedBundle.payload.exchangePublicKey,
          },
          signature: repairedBundle.signature,
        };
        await set(deviceRef, payloadToStore).catch(() => {});
        return repairedBundle;
      }
    }

    throw new Error(
      `Device identity signature verification failed for user ${uid}, device ${deviceId}. Payload may be tampered.`
    );
  }

  return bundle;
}

/**
 * Fetches and verifies all registered public device bundles for a given user.
 * If the authenticated user's own device has a stale signature, repairs it automatically.
 */
export async function getUserDevices(
  uid: string
): Promise<SignedDeviceIdentityBundle[]> {
  const userDevicesRef = ref(db, `users/${uid}/devices`);
  const snapshot = await get(userDevicesRef);

  if (!snapshot.exists()) {
    return [];
  }

  const devicesMap = snapshot.val() as Record<string, RegisteredDeviceDTO>;
  const verifiedBundles: SignedDeviceIdentityBundle[] = [];
  const localRecord = await loadDeviceKeys().catch(() => null);

  for (const [deviceId, data] of Object.entries(devicesMap)) {
    try {
      const bundle: SignedDeviceIdentityBundle = {
        payload: {
          deviceId: data.deviceId || deviceId,
          identityPublicKey: data.publicKeys.identityECDSA,
          exchangePublicKey: data.publicKeys.exchangeECDH,
          createdAt: data.createdAt,
        },
        signature: data.signature,
      };

      const isValid = await verifyDeviceIdentityBundle(bundle).catch(() => false);
      if (isValid) {
        verifiedBundles.push(bundle);
        continue;
      }

      // If the authenticated user's OWN current device fails signature verification, repair it
      if (localRecord && localRecord.deviceId === (data.deviceId || deviceId)) {
        const repairedBundle = await createDeviceIdentityBundle(
          localRecord.deviceId,
          {
            privateKey: localRecord.identityPrivateKey,
            publicKey: localRecord.identityPublicKey,
          },
          {
            privateKey: localRecord.exchangePrivateKey,
            publicKey: localRecord.exchangePublicKey,
          },
          localRecord.createdAt
        );
        const isRepairedValid = await verifyDeviceIdentityBundle(repairedBundle);
        if (isRepairedValid) {
          const payloadToStore: RegisteredDeviceDTO = {
            deviceId: repairedBundle.payload.deviceId,
            createdAt: repairedBundle.payload.createdAt,
            publicKeys: {
              identityECDSA: repairedBundle.payload.identityPublicKey,
              exchangeECDH: repairedBundle.payload.exchangePublicKey,
            },
            signature: repairedBundle.signature,
          };
          await set(ref(db, `users/${uid}/devices/${repairedBundle.payload.deviceId}`), payloadToStore).catch(() => {});
          verifiedBundles.push(repairedBundle);
          continue;
        }
      }

      console.warn(
        `Skipping device ${deviceId} for user ${uid}: signature verification failed.`
      );
    } catch (err) {
      console.warn(`Error processing device ${deviceId} for user ${uid}:`, err);
    }
  }

  return verifiedBundles;
}

/**
 * Helper to verify a device bundle signature directly.
 */
export async function verifyDeviceBundle(
  bundle: SignedDeviceIdentityBundle
): Promise<boolean> {
  return await verifyDeviceIdentityBundle(bundle);
}
