import {
  get, ref, set, update, remove, push, runTransaction, onValue, off,
} from "firebase/database";
import { db } from "@/lib/firebase";
import { encrypt } from "@/lib/crypto";
import {
  acceptFriendRequest as acceptFriendRequestImpl,
  cancelFriendRequest as cancelFriendRequestImpl,
  createFriendRequest,
  declineFriendRequest as declineFriendRequestImpl,
  friendshipId,
} from "@/lib/friendRequestService";
import type { UserProfile, FriendRequest } from "@/types/user";

// ── Username ─────────────────────────────────────────────────────────────────

export function isValidUsername(u: string): boolean {
  return /^[a-z0-9_]{3,20}$/.test(u);
}

/** Atomically claim a username. Returns true on success, false if taken. */
export async function claimUsername(username: string, uid: string): Promise<boolean> {
  const usernameRef = ref(db, `usernames/${username}`);
  let claimed = false;
  await runTransaction(usernameRef, (current) => {
    if (current !== null) return; // abort — already taken
    claimed = true;
    return uid;
  });
  return claimed;
}

/** Release a username (used when changing username). */
export async function releaseUsername(username: string): Promise<void> {
  await remove(ref(db, `usernames/${username}`));
}

/** Check if a username is available (non-atomic — use claimUsername for actual reservation). */
export async function isUsernameAvailable(username: string): Promise<boolean> {
  const snap = await get(ref(db, `usernames/${username}`));
  return !snap.exists();
}

/** Look up a uid by username. */
export async function getUidByUsername(username: string): Promise<string | null> {
  const snap = await get(ref(db, `usernames/${username}`));
  return snap.exists() ? (snap.val() as string) : null;
}

// ── Profile ───────────────────────────────────────────────────────────────────

export async function createProfile(profile: UserProfile): Promise<void> {
  await set(ref(db, `users/${profile.uid}`), profile);
}

export async function updateProfile(uid: string, partial: Partial<UserProfile>): Promise<void> {
  await update(ref(db, `users/${uid}`), { ...partial, updatedAt: Date.now() });
}

export async function getProfile(uid: string): Promise<UserProfile | null> {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.exists() ? (snap.val() as UserProfile) : null;
}

export function subscribeProfile(uid: string, cb: (p: UserProfile | null) => void): () => void {
  const r = ref(db, `users/${uid}`);
  const handler = (snap: { exists(): boolean; val(): unknown }) =>
    cb(snap.exists() ? (snap.val() as UserProfile) : null);
  onValue(r, handler as Parameters<typeof onValue>[1]);
  return () => off(r, "value", handler as Parameters<typeof onValue>[1]);
}

// ── Presence ──────────────────────────────────────────────────────────────────
// Kept for legacy callers; PresenceGuard now uses onDisconnect directly.
export function setOnline(uid: string): void {
  update(ref(db, `users/${uid}`), { online: true, lastSeen: Date.now() }).catch(() => {});
}

export function setOffline(uid: string): void {
  update(ref(db, `users/${uid}`), { online: false, lastSeen: Date.now() }).catch(() => {});
}

// ── Friend Requests ───────────────────────────────────────────────────────────

export async function sendFriendRequest(fromUid: string, toUid: string): Promise<string> {
  try {
    void fromUid;
    return await createFriendRequest(toUid);
  } catch (error) {
    console.error("[FriendRequest] failed:", error);
    throw error;
  }
}

export async function getExistingRequest(
  fromUid: string,
  toUid: string
): Promise<FriendRequest | null> {
  const pairKey = friendshipId(fromUid, toUid);
  const snap = await get(ref(db, `friendRequests/${pairKey}`));
  if (!snap.exists()) return null;
  const req = snap.val() as { fromUid: string; toUid: string; status: FriendRequest["status"]; createdAt: number };
  if (req.status !== "pending") return null;
  return {
    id: pairKey,
    fromUid: req.fromUid,
    toUid: req.toUid,
    status: req.status,
    createdAt: req.createdAt,
  };
}

export async function acceptFriendRequest(requestId: string, _fromUid?: string, _toUid?: string): Promise<void> {
  await acceptFriendRequestImpl(requestId);
}

export async function declineFriendRequest(requestId: string): Promise<void> {
  await declineFriendRequestImpl(requestId);
}

export async function cancelFriendRequest(requestId: string): Promise<void> {
  await cancelFriendRequestImpl(requestId);
}

export async function removeFriend(myUid: string, theirUid: string): Promise<void> {
  const updates: Record<string, null> = {};
  updates[`friends/${myUid}/${theirUid}`] = null;
  updates[`friends/${theirUid}/${myUid}`] = null;
  updates[`friendships/${friendshipId(myUid, theirUid)}`] = null;
  await update(ref(db), updates);
}

export async function isFriend(myUid: string, theirUid: string): Promise<boolean> {
  const snap = await get(ref(db, `friends/${myUid}/${theirUid}`));
  return snap.exists();
}

export function subscribeFriends(uid: string, cb: (uids: string[]) => void): () => void {
  const r = ref(db, `friends/${uid}`);
  const handler = (snap: { exists(): boolean; val(): unknown }) => {
    cb(snap.exists() ? Object.keys(snap.val() as Record<string, unknown>) : []);
  };
  onValue(r, handler as Parameters<typeof onValue>[1]);
  return () => off(r, "value", handler as Parameters<typeof onValue>[1]);
}

export function subscribeIncomingRequests(
  uid: string,
  cb: (reqs: FriendRequest[]) => void
): () => void {
  const r = ref(db, `friendRequestIndex/${uid}`);
  const handler = (snap: { exists(): boolean; val(): unknown }) => {
    if (!snap.exists()) { cb([]); return; }
    const all = snap.val() as Record<string, { direction: "incoming" | "outgoing"; otherUid: string; status: FriendRequest["status"]; createdAt: number }>;
    cb(
      Object.entries(all)
        .filter(([, v]) => v.direction === "incoming" && v.status === "pending")
        .map(([id, v]) => ({ id, fromUid: v.otherUid, toUid: uid, status: v.status, createdAt: v.createdAt }))
    );
  };
  onValue(r, handler as Parameters<typeof onValue>[1]);
  return () => off(r, "value", handler as Parameters<typeof onValue>[1]);
}

export function subscribeOutgoingRequests(
  uid: string,
  cb: (reqs: FriendRequest[]) => void
): () => void {
  const r = ref(db, `friendRequestIndex/${uid}`);
  const handler = (snap: { exists(): boolean; val(): unknown }) => {
    if (!snap.exists()) { cb([]); return; }
    const all = snap.val() as Record<string, { direction: "incoming" | "outgoing"; otherUid: string; status: FriendRequest["status"]; createdAt: number }>;
    cb(
      Object.entries(all)
        .filter(([, v]) => v.direction === "outgoing" && v.status === "pending")
        .map(([id, v]) => ({ id, fromUid: uid, toUid: v.otherUid, status: v.status, createdAt: v.createdAt }))
    );
  };
  onValue(r, handler as Parameters<typeof onValue>[1]);
  return () => off(r, "value", handler as Parameters<typeof onValue>[1]);
}

// ── Deterministic private room ID ─────────────────────────────────────────────
// Always the same for two users regardless of who initiates.

export function privateRoomId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join("__");
}

// ── Ensure private room exists ────────────────────────────────────────────────
// Creates rooms/{roomId}/meta + chatMeta/{roomId} if they don't exist yet.
// Safe to call multiple times — exits immediately if room already exists.

export async function ensurePrivateRoom(
  myUid: string,
  theirUid: string,
  key: CryptoKey
): Promise<string> {
  const roomId = privateRoomId(myUid, theirUid);
  const metaSnap = await get(ref(db, `rooms/${roomId}/meta`));
  if (!metaSnap.exists()) {
    const keyCheck = await encrypt("keycheck", key);
    const [p0, p1] = [myUid, theirUid].sort();
    await set(ref(db, `rooms/${roomId}/meta`), {
      participants: { 0: p0, 1: p1 },
      keyCheck,
    });
    // Bootstrap chatMeta so the chat list can find this conversation
    await set(ref(db, `chatMeta/${roomId}`), {
      roomId,
      participants: { 0: p0, 1: p1 },
      lastMessage: "🔐 New private message",
      lastMessageAt: Date.now(),
    });
    // Bootstrap userChats index for both participants
    const now = Date.now();
    await update(ref(db), {
      [`userChats/${myUid}/${roomId}/roomId`]: roomId,
      [`userChats/${myUid}/${roomId}/otherUid`]: theirUid,
      [`userChats/${myUid}/${roomId}/lastMessageAt`]: now,
      [`userChats/${myUid}/${roomId}/unread`]: 0,
      [`userChats/${theirUid}/${roomId}/roomId`]: roomId,
      [`userChats/${theirUid}/${roomId}/otherUid`]: myUid,
      [`userChats/${theirUid}/${roomId}/lastMessageAt`]: now,
      [`userChats/${theirUid}/${roomId}/unread`]: 0,
    });
  }
  return roomId;
}

// ── Chat metadata ─────────────────────────────────────────────────────────────
// chatMeta/{roomId}  — shared room metadata (participants, last activity)
// userChats/{uid}/{roomId} — per-user index used for subscribeChatList
//
// lastMessage is ALWAYS "🔐 New private message" — never plaintext.
// unreadCounts: { [uid]: number } — incremented on send, reset to 0 on open.

export async function touchChatMeta(
  roomId: string,
  participants: [string, string],
  senderUid: string
): Promise<void> {
  const [firstUid, secondUid] = participants;
  const otherUid = firstUid === senderUid ? secondUid : firstUid;
  const now = Date.now();

  // Update shared chatMeta (read by Firebase rules for participants)
  const [p0, p1] = [firstUid, secondUid].sort();
  await update(ref(db, `chatMeta/${roomId}`), {
    roomId,
    lastMessage: "🔐 New private message",
    lastMessageAt: now,
    participants: { 0: p0, 1: p1 },
  });

  // Update per-user chat index for both participants
  await update(ref(db), {
    [`userChats/${senderUid}/${roomId}/roomId`]: roomId,
    [`userChats/${senderUid}/${roomId}/otherUid`]: otherUid,
    [`userChats/${senderUid}/${roomId}/lastMessageAt`]: now,
    [`userChats/${otherUid}/${roomId}/roomId`]: roomId,
    [`userChats/${otherUid}/${roomId}/otherUid`]: senderUid,
    [`userChats/${otherUid}/${roomId}/lastMessageAt`]: now,
  });

  // Increment unread count for the recipient only
  await runTransaction(ref(db, `userChats/${otherUid}/${roomId}/unread`), (value) =>
    typeof value === "number" ? value + 1 : 1
  );

  // Push in-app notification to recipient
  const notifRef = push(ref(db, `notifications/${otherUid}`));
  await set(notifRef, {
    type: "message",
    fromUid: senderUid,
    roomId,
    read: false,
    createdAt: now,
  }).catch(() => {});
}

/** Mark all messages as read for this user — resets their unread count to 0. */
export async function markChatRead(roomId: string, uid: string): Promise<void> {
  // Reset per-user index unread counter
  await update(ref(db, `userChats/${uid}/${roomId}`), { unread: 0 });
  // Also reset shared unreadCounts for legacy compatibility
  await update(ref(db, `chatMeta/${roomId}/unreadCounts`), { [uid]: 0 }).catch(() => {});
}

// ── Chat list subscription (per-user index) ────────────────────────────────
// Reads userChats/{uid} — a narrow, per-user collection.
// No permission issues, no full chatMeta scan.

export function subscribeChatList(
  uid: string,
  cb: (items: Array<{ roomId: string; otherUid: string; lastMessageAt: number; unread: number; pinned?: boolean; muteUntil?: number | null }>) => void
): () => void {
  const r = ref(db, `userChats/${uid}`);
  const handler = (snap: { exists(): boolean; val(): unknown }) => {
    if (!snap.exists()) { cb([]); return; }
    const all = snap.val() as Record<string, {
      roomId: string;
      otherUid: string;
      lastMessageAt: number;
      unread?: number;
      pinned?: boolean;
      muteUntil?: number | null;
    }>;
    const items = Object.values(all)
      .filter((c) => c.roomId && c.otherUid)
      .map((c) => ({
        roomId: c.roomId,
        otherUid: c.otherUid,
        lastMessageAt: c.lastMessageAt ?? 0,
        unread: c.unread ?? 0,
        pinned: c.pinned ?? false,
        muteUntil: c.muteUntil ?? null,
      }))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    cb(items);
  };
  onValue(r, handler as Parameters<typeof onValue>[1]);
  return () => off(r, "value", handler as Parameters<typeof onValue>[1]);
}

// ── Notifications ─────────────────────────────────────────────────────────────

export type AppNotification = {
  id: string;
  type: "friend_request" | "friend_accepted" | "reaction" | "reply" | "message" | "media";
  fromUid: string;
  roomId?: string;
  messageId?: string;
  read: boolean;
  createdAt: number;
};

export async function pushNotification(
  toUid: string,
  n: Omit<AppNotification, "id" | "read">
): Promise<void> {
  const r = push(ref(db, `notifications/${toUid}`));
  await set(r, { ...n, read: false });
}

export function subscribeNotifications(
  uid: string,
  cb: (items: AppNotification[]) => void
): () => void {
  const r = ref(db, `notifications/${uid}`);
  const handler = (snap: { exists(): boolean; val(): unknown }) => {
    if (!snap.exists()) { cb([]); return; }
    const all = snap.val() as Record<string, Omit<AppNotification, "id">>;
    const items = Object.entries(all)
      .map(([id, v]) => ({ ...v, id }))
      .sort((a, b) => b.createdAt - a.createdAt);
    cb(items);
  };
  onValue(r, handler as Parameters<typeof onValue>[1]);
  return () => off(r, "value", handler as Parameters<typeof onValue>[1]);
}

export async function markNotificationRead(uid: string, notifId: string): Promise<void> {
  await update(ref(db, `notifications/${uid}/${notifId}`), { read: true });
}

export async function markAllNotificationsRead(uid: string): Promise<void> {
  const snap = await get(ref(db, `notifications/${uid}`));
  if (!snap.exists()) return;
  const updates: Record<string, boolean> = {};
  for (const id of Object.keys(snap.val() as Record<string, unknown>)) {
    updates[`notifications/${uid}/${id}/read`] = true;
  }
  await update(ref(db), updates);
}

// ── User Settings (notification prefs + privacy) ──────────────────────────────

export type UserSettings = {
  notif_messages: boolean;
  notif_friendRequests: boolean;
  notif_reactions: boolean;
  notif_replies: boolean;
  notif_media: boolean;
  notif_preview: boolean;
  privacy_onlineStatus: "everyone" | "friends" | "nobody";
  privacy_lastSeen: "everyone" | "friends" | "nobody";
  privacy_readReceipts: boolean;
  privacy_typingIndicator: boolean;
};

export const DEFAULT_SETTINGS: UserSettings = {
  notif_messages: true,
  notif_friendRequests: true,
  notif_reactions: true,
  notif_replies: true,
  notif_media: true,
  notif_preview: false,
  privacy_onlineStatus: "everyone",
  privacy_lastSeen: "everyone",
  privacy_readReceipts: true,
  privacy_typingIndicator: true,
};

export async function getUserSettings(uid: string): Promise<UserSettings> {
  const snap = await get(ref(db, `userSettings/${uid}`));
  return snap.exists() ? { ...DEFAULT_SETTINGS, ...(snap.val() as Partial<UserSettings>) } : DEFAULT_SETTINGS;
}

export async function saveUserSettings(uid: string, s: Partial<UserSettings>): Promise<void> {
  await update(ref(db, `userSettings/${uid}`), s);
}

export function subscribeUserSettings(uid: string, cb: (s: UserSettings) => void): () => void {
  const r = ref(db, `userSettings/${uid}`);
  const handler = (snap: { exists(): boolean; val(): unknown }) => {
    cb(snap.exists() ? { ...DEFAULT_SETTINGS, ...(snap.val() as Partial<UserSettings>) } : DEFAULT_SETTINGS);
  };
  onValue(r, handler as Parameters<typeof onValue>[1]);
  return () => off(r, "value", handler as Parameters<typeof onValue>[1]);
}

// ── Pin / Mute chat ───────────────────────────────────────────────────────────

export async function pinChat(uid: string, roomId: string, pinned: boolean): Promise<void> {
  await update(ref(db, `userChats/${uid}/${roomId}`), { pinned });
}

export async function muteChat(uid: string, roomId: string, muteUntil: number | null): Promise<void> {
  await update(ref(db, `userChats/${uid}/${roomId}`), { muteUntil: muteUntil ?? null });
}
