import {
  get, ref, set, update, remove, push, runTransaction, onValue, off, query, orderByChild, equalTo,
} from "firebase/database";
import { db } from "@/lib/firebase";
import { encrypt } from "@/lib/crypto";
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

export function setOnline(uid: string): void {
  update(ref(db, `users/${uid}`), { online: true, lastSeen: Date.now() }).catch(() => {});
}

export function setOffline(uid: string): void {
  update(ref(db, `users/${uid}`), { online: false, lastSeen: Date.now() }).catch(() => {});
}

// ── Friend Requests ───────────────────────────────────────────────────────────

export async function sendFriendRequest(fromUid: string, toUid: string): Promise<void> {
  const existing = await getExistingRequest(fromUid, toUid);
  if (existing) return;
  const r = push(ref(db, "friendRequests"));
  await set(r, {
    fromUid,
    toUid,
    status: "pending",
    createdAt: Date.now(),
  });
}

export async function getExistingRequest(
  fromUid: string,
  toUid: string
): Promise<FriendRequest | null> {
  // Check A→B direction using index
  const q1 = query(ref(db, "friendRequests"), orderByChild("fromUid"), equalTo(fromUid));
  const snap1 = await get(q1);
  if (snap1.exists()) {
    const all = snap1.val() as Record<string, Omit<FriendRequest, "id">>;
    for (const [id, req] of Object.entries(all)) {
      if (req.toUid === toUid && req.status === "pending") return { ...req, id };
    }
  }
  // Check B→A direction
  const q2 = query(ref(db, "friendRequests"), orderByChild("fromUid"), equalTo(toUid));
  const snap2 = await get(q2);
  if (snap2.exists()) {
    const all = snap2.val() as Record<string, Omit<FriendRequest, "id">>;
    for (const [id, req] of Object.entries(all)) {
      if (req.toUid === fromUid && req.status === "pending") return { ...req, id };
    }
  }
  return null;
}

export async function acceptFriendRequest(requestId: string, fromUid: string, toUid: string): Promise<void> {
  await update(ref(db, `friendRequests/${requestId}`), { status: "accepted" });
  const id = friendshipId(fromUid, toUid);
  const since = Date.now();
  await set(ref(db, `friendships/${id}`), { participants: [fromUid, toUid], since });
  await update(ref(db), {
    [`friends/${fromUid}/${toUid}`]: { uid: toUid, since },
    [`friends/${toUid}/${fromUid}`]: { uid: fromUid, since },
  });
}

export async function declineFriendRequest(requestId: string): Promise<void> {
  await update(ref(db, `friendRequests/${requestId}`), { status: "declined" });
}

export async function cancelFriendRequest(requestId: string): Promise<void> {
  await remove(ref(db, `friendRequests/${requestId}`));
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
  const r = query(ref(db, "friendRequests"), orderByChild("toUid"), equalTo(uid));
  const handler = (snap: { exists(): boolean; val(): unknown }) => {
    if (!snap.exists()) { cb([]); return; }
    const all = snap.val() as Record<string, Omit<FriendRequest, "id">>;
    cb(
      Object.entries(all)
        .filter(([, v]) => v.status === "pending")
        .map(([id, v]) => ({ ...v, id }))
    );
  };
  onValue(r, handler as Parameters<typeof onValue>[1]);
  return () => off(r, "value", handler as Parameters<typeof onValue>[1]);
}

export function subscribeOutgoingRequests(
  uid: string,
  cb: (reqs: FriendRequest[]) => void
): () => void {
  const r = query(ref(db, "friendRequests"), orderByChild("fromUid"), equalTo(uid));
  const handler = (snap: { exists(): boolean; val(): unknown }) => {
    if (!snap.exists()) { cb([]); return; }
    const all = snap.val() as Record<string, Omit<FriendRequest, "id">>;
    cb(
      Object.entries(all)
        .filter(([, v]) => v.status === "pending")
        .map(([id, v]) => ({ ...v, id }))
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

export function friendshipId(uidA: string, uidB: string): string {
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
  cb: (items: Array<{ roomId: string; otherUid: string; lastMessageAt: number; unread: number }>) => void
): () => void {
  const r = ref(db, `userChats/${uid}`);
  const handler = (snap: { exists(): boolean; val(): unknown }) => {
    if (!snap.exists()) { cb([]); return; }
    const all = snap.val() as Record<string, {
      roomId: string;
      otherUid: string;
      lastMessageAt: number;
      unread?: number;
    }>;
    const items = Object.values(all)
      .filter((c) => c.roomId && c.otherUid)
      .map((c) => ({
        roomId: c.roomId,
        otherUid: c.otherUid,
        lastMessageAt: c.lastMessageAt ?? 0,
        unread: c.unread ?? 0,
      }))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    cb(items);
  };
  onValue(r, handler as Parameters<typeof onValue>[1]);
  return () => off(r, "value", handler as Parameters<typeof onValue>[1]);
}
