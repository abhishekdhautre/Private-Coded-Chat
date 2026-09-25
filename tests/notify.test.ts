/**
 * Regression tests for the notification policy (lib/notify.ts).
 *
 * Policy under test — a sound / browser alert fires ONLY for a NEW,
 * successfully decrypted, remote message that is not historical, not a
 * duplicate, not muted and not arriving while the user is sending:
 *
 * - own messages never notify (even when everything else passes)
 * - historical rows (room-open replay) never notify
 * - duplicate deliveries never notify twice
 * - failed decryptions never notify
 * - muted preference suppresses the sound path
 * - an in-flight send / unsent composer text suppresses
 * - local preference round-trips through guarded storage
 * - browser-notification + audio helpers degrade silently without browser APIs
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  shouldNotifyMessage,
  loadNotifyMuted,
  saveNotifyMuted,
  loadBrowserNotifyEnabled,
  saveBrowserNotifyEnabled,
  canUseBrowserNotifications,
  browserNotificationPermission,
  requestBrowserNotificationPermission,
  showChatNotification,
  playNotifyTone,
  type NotifySignal,
} from '@/lib/notify';

function signal(overrides?: Partial<NotifySignal>): NotifySignal {
  return {
    isOwnMessage: false,
    decryptOk: true,
    isDuplicateDelivery: false,
    isHistorical: false,
    muted: false,
    isSending: false,
    alreadyNotified: false,
    ...overrides,
  };
}

describe('shouldNotifyMessage', () => {
  it('notifies for a new successfully decrypted remote message', () => {
    expect(shouldNotifyMessage(signal())).toEqual({
      notify: true,
      reason: 'new-message',
    });
  });

  it('own messages do not trigger a notification', () => {
    expect(shouldNotifyMessage(signal({ isOwnMessage: true }))).toEqual({
      notify: false,
      reason: 'own-message',
    });
  });

  it('historical messages (room-open replay) do not trigger a notification', () => {
    expect(shouldNotifyMessage(signal({ isHistorical: true }))).toEqual({
      notify: false,
      reason: 'historical',
    });
  });

  it('duplicate realtime deliveries do not notify twice', () => {
    expect(
      shouldNotifyMessage(signal({ isDuplicateDelivery: true }))
    ).toEqual({ notify: false, reason: 'duplicate' });
    expect(shouldNotifyMessage(signal({ alreadyNotified: true }))).toEqual({
      notify: false,
      reason: 'already-notified',
    });
  });

  it('failed decryption does not trigger a notification', () => {
    expect(shouldNotifyMessage(signal({ decryptOk: false }))).toEqual({
      notify: false,
      reason: 'decrypt-failed',
    });
  });

  it('mute preference suppresses the notification', () => {
    expect(shouldNotifyMessage(signal({ muted: true }))).toEqual({
      notify: false,
      reason: 'muted',
    });
  });

  it('an in-flight send / active composer suppresses the notification', () => {
    expect(shouldNotifyMessage(signal({ isSending: true }))).toEqual({
      notify: false,
      reason: 'sending',
    });
  });

  it('safety checks run before preference checks (own/failed win over muted)', () => {
    expect(
      shouldNotifyMessage(signal({ isOwnMessage: true, muted: true }))
    ).toEqual({ notify: false, reason: 'own-message' });
    expect(
      shouldNotifyMessage(signal({ decryptOk: false, muted: true }))
    ).toEqual({ notify: false, reason: 'decrypt-failed' });
  });
});

describe('notification preferences (local only)', () => {
  const store = new Map<string, string>();
  const storageStub = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };

  beforeEach(() => {
    store.clear();
    (globalThis as any).localStorage = storageStub;
  });

  afterEach(() => {
    delete (globalThis as any).localStorage;
  });

  it('mute preference round-trips and defaults to unmuted', () => {
    expect(loadNotifyMuted()).toBe(false);
    saveNotifyMuted(true);
    expect(loadNotifyMuted()).toBe(true);
    saveNotifyMuted(false);
    expect(loadNotifyMuted()).toBe(false);
  });

  it('browser-notify opt-in round-trips and defaults to off', () => {
    expect(loadBrowserNotifyEnabled()).toBe(false);
    saveBrowserNotifyEnabled(true);
    expect(loadBrowserNotifyEnabled()).toBe(true);
  });

  it('missing storage degrades to defaults without throwing', () => {
    delete (globalThis as any).localStorage;
    expect(loadNotifyMuted()).toBe(false);
    expect(loadBrowserNotifyEnabled()).toBe(false);
    expect(() => saveNotifyMuted(true)).not.toThrow();
    expect(() => saveBrowserNotifyEnabled(true)).not.toThrow();
  });
});

describe('browser/audio degradation without browser APIs', () => {
  it('helpers report unsupported instead of throwing in node', () => {
    expect(canUseBrowserNotifications()).toBe(false);
    expect(browserNotificationPermission()).toBe('unsupported');
    expect(showChatNotification({ roomId: 'r1', onOpen: () => {} })).toBe(false);
    expect(playNotifyTone()).toBe(false);
  });

  it('permission request resolves unsupported without throwing', async () => {
    await expect(requestBrowserNotificationPermission()).resolves.toBe(
      'unsupported'
    );
  });
});
