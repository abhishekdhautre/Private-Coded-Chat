/**
 * IndexedDB Key Storage Layer for End-to-End Encryption (Phase 1)
 *
 * Stores non-extractable CryptoKey handles directly using browser IndexedDB structured cloning.
 * NEVER uses localStorage, sessionStorage, cookies, or string/base64 private key exports.
 */

export interface DeviceKeysRecord {
  deviceId: string;
  identityPrivateKey: CryptoKey;
  identityPublicKey: CryptoKey;
  exchangePrivateKey: CryptoKey;
  exchangePublicKey: CryptoKey;
  createdAt: number;
}

const DB_NAME = 'private_coded_chat_e2ee';
const DB_VERSION = 1;
const STORE_NAME = 'device_keys';
const SINGLETON_KEY = 'active_device_id';

// Fallback in-memory store for environments without IndexedDB (e.g. Node test runner)
let inMemoryStore: DeviceKeysRecord | null = null;

/**
 * Checks if browser IndexedDB is supported.
 */
export function isIndexedDBSupported(): boolean {
  return typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDBSupported()) {
      return reject(new Error('IndexedDB is not supported in this environment.'));
    }
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'deviceId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
  });
}

/**
 * Saves a DeviceKeysRecord to IndexedDB (or fallback in-memory store).
 * Native CryptoKey instances are preserved as non-extractable objects.
 */
export async function saveDeviceKeys(record: DeviceKeysRecord): Promise<void> {
  if (!isIndexedDBSupported()) {
    inMemoryStore = { ...record };
    return;
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(record);

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Failed to save device keys to IndexedDB.'));
    };
  });
}

/**
 * Loads the stored DeviceKeysRecord from IndexedDB (or fallback in-memory store).
 */
export async function loadDeviceKeys(): Promise<DeviceKeysRecord | null> {
  if (!isIndexedDBSupported()) {
    return inMemoryStore ? { ...inMemoryStore } : null;
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      db.close();
      const records = request.result as DeviceKeysRecord[];
      if (records && records.length > 0) {
        // Return the most recently created device keys record
        records.sort((a, b) => b.createdAt - a.createdAt);
        resolve(records[0]);
      } else {
        resolve(null);
      }
    };

    request.onerror = () => {
      db.close();
      reject(request.error || new Error('Failed to load device keys from IndexedDB.'));
    };
  });
}

/**
 * Clears stored DeviceKeysRecords from IndexedDB (or fallback in-memory store).
 */
export async function clearDeviceKeys(): Promise<void> {
  if (!isIndexedDBSupported()) {
    inMemoryStore = null;
    return;
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Failed to clear device keys from IndexedDB.'));
    };
  });
}
