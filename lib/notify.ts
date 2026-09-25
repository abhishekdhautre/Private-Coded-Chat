/**
 * Incoming-message notification system for the chat page.
 *
 * Two channels, both strictly opt-in-safe:
 *
 * 1. Notification SOUND — a tiny generated Web Audio API tone (no audio
 *    assets, no libraries). The AudioContext is created/resumed only inside a
 *    real user gesture (`unlockNotifyAudio`, wired to pointer/key/touch once),
 *    so browser autoplay policies are respected and no errors are spammed when
 *    playback is unavailable — `playNotifyTone()` just returns false.
 * 2. BROWSER notifications — `Notification` API only. Permission is requested
 *    solely from the in-chat toggle (never on page load), the notification
 *    body never contains message content ("New encrypted message"), and
 *    clicking it focuses/opens the room. Unsupported browsers (incl. iOS
 *    browsers without Web Notification support) degrade to a no-op.
 *
 * `shouldNotifyMessage()` is the single decision point and is pure, so the
 * entire policy (own / historical / duplicate / failed / muted / sending /
 * already-notified) is unit-testable. Only the caller's local preference
 * (muted, browser-notify opt-in) touches localStorage — never message data.
 */

const MUTE_KEY = "private-coded-chat:notify-muted";
const BROWSER_NOTIFY_KEY = "private-coded-chat:browser-notify";

function readFlag(key: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Private mode / blocked storage: the preference simply doesn't persist.
  }
}

/** Persisted locally only: message-sound mute preference. */
export function loadNotifyMuted(): boolean {
  return readFlag(MUTE_KEY);
}

export function saveNotifyMuted(muted: boolean): void {
  writeFlag(MUTE_KEY, muted);
}

/** Persisted locally only: browser-notification opt-in. */
export function loadBrowserNotifyEnabled(): boolean {
  return readFlag(BROWSER_NOTIFY_KEY);
}

export function saveBrowserNotifyEnabled(enabled: boolean): void {
  writeFlag(BROWSER_NOTIFY_KEY, enabled);
}

export interface NotifySignal {
  /** Row was sent by this device/user. */
  isOwnMessage: boolean;
  /** The row decrypted and validated successfully (never notify on failure). */
  decryptOk: boolean;
  /** Same messageId delivered before (replay / re-attach / shared run). */
  isDuplicateDelivery: boolean;
  /** Row predates this subscription (history replay on open). */
  isHistorical: boolean;
  /** User muted message sounds. */
  muted: boolean;
  /** This user has a send in flight or unsent composer text. */
  isSending: boolean;
  /** This messageId already triggered a notification this session. */
  alreadyNotified: boolean;
}

export interface NotifyDecision {
  notify: boolean;
  reason:
    | "new-message"
    | "own-message"
    | "decrypt-failed"
    | "duplicate"
    | "historical"
    | "already-notified"
    | "muted"
    | "sending";
}

/**
 * Single decision point for incoming-message alerts. Sounds and browser
 * notifications share it, so both channels obey the same policy.
 */
export function shouldNotifyMessage(signal: NotifySignal): NotifyDecision {
  if (signal.isOwnMessage) return { notify: false, reason: "own-message" };
  if (!signal.decryptOk) return { notify: false, reason: "decrypt-failed" };
  if (signal.isDuplicateDelivery) return { notify: false, reason: "duplicate" };
  if (signal.isHistorical) return { notify: false, reason: "historical" };
  if (signal.alreadyNotified) return { notify: false, reason: "already-notified" };
  if (signal.muted) return { notify: false, reason: "muted" };
  if (signal.isSending) return { notify: false, reason: "sending" };
  return { notify: true, reason: "new-message" };
}

// ── Notification sound (Web Audio, generated tone, no assets) ───────────────

let audioCtx: AudioContext | null = null;
let audioUnlocked = false;

/**
 * Creates/resumes the shared AudioContext. MUST be called from a real user
 * gesture (the page wires it to pointerdown/keydown/touchstart once) —
 * otherwise the browser keeps the context suspended per autoplay policy.
 * Never throws, never logs: unavailable audio is a silent no-op.
 */
export function unlockNotifyAudio(): void {
  try {
    if (typeof window === "undefined") return;
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    audioUnlocked = true;
  } catch {
    // Audio unavailable — playNotifyTone() will report false.
  }
}

/**
 * Plays a short, subtle two-tone blip (~0.25s). Returns true only when the
 * tone actually started; false (never an exception, never a console error)
 * when audio is locked, suspended or unsupported.
 */
export function playNotifyTone(): boolean {
  try {
    if (!audioUnlocked || !audioCtx || audioCtx.state !== "running") return false;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(659.25, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.26);
    return true;
  } catch {
    return false;
  }
}

// ── Browser notifications (Notification API, content-free) ──────────────────

export type BrowserNotifyPermission =
  | "granted"
  | "denied"
  | "default"
  | "unsupported";

export function canUseBrowserNotifications(): boolean {
  return (
    typeof window !== "undefined" && typeof Notification !== "undefined"
  );
}

export function browserNotificationPermission(): BrowserNotifyPermission {
  if (!canUseBrowserNotifications()) return "unsupported";
  return Notification.permission;
}

/**
 * Requests permission. Call ONLY from an intentional user action (the in-chat
 * toggle) — never on page load. Resolves to the resulting permission state.
 */
export async function requestBrowserNotificationPermission(): Promise<BrowserNotifyPermission> {
  if (!canUseBrowserNotifications()) return "unsupported";
  try {
    return (await Notification.requestPermission()) as BrowserNotifyPermission;
  } catch {
    return "denied";
  }
}

/**
 * Shows a content-free notification ("New encrypted message" — never message
 * text, never media). `tag` coalesces repeat alerts per room. Clicking focuses
 * the window and opens the room via `onOpen`. Returns true only when a
 * notification was actually shown.
 */
export function showChatNotification(params: {
  roomId: string;
  onOpen: (roomId: string) => void;
}): boolean {
  try {
    if (!canUseBrowserNotifications()) return false;
    if (Notification.permission !== "granted") return false;
    const n = new Notification("New encrypted message", {
      tag: `private-coded-chat:${params.roomId}`,
    });
    n.onclick = () => {
      try {
        if (typeof window !== "undefined") window.focus();
        params.onOpen(params.roomId);
      } finally {
        n.close();
      }
    };
    return true;
  } catch {
    return false;
  }
}
