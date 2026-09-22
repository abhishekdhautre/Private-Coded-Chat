import { getApps, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { HttpsError, onCall } from "firebase-functions/v2/https";

if (getApps().length === 0) {
  const firebaseConfig = process.env.FIREBASE_CONFIG
    ? JSON.parse(process.env.FIREBASE_CONFIG)
    : undefined;

  initializeApp(firebaseConfig);
}

const database = getDatabase();
type RequestStatus = "pending" | "accepted" | "declined" | "cancelled";

type FriendRequestRecord = {
  fromUid: string;
  toUid: string;
  status: RequestStatus;
  createdAt: number;
};

function requireUid(auth: { uid: string } | undefined): string {
  if (!auth) throw new HttpsError("unauthenticated", "Sign in to manage friend requests.");
  return auth.uid;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpsError("invalid-argument", `${name} is required.`);
  }
  return value;
}

function pairKey(firstUid: string, secondUid: string): string {
  return [firstUid, secondUid]
    .sort()
    .map((uid) => Buffer.from(uid, "utf8").toString("base64url"))
    .join(".");
}

function requestIndex(direction: "incoming" | "outgoing", otherUid: string, status: RequestStatus, createdAt: number) {
  return { direction, otherUid, status, createdAt };
}

async function lockPair(key: string, requestId: string, now: number): Promise<void> {
  const lock = await database.ref(`friendRequestPairIndex/${key}`).transaction((current) => {
    // Only active creation/pending states block a new request.
    // Terminal states (accepted/declined/cancelled) are reusable.
    if (current?.status === "pending" || current?.status === "creating") return;
    return { requestId, status: "creating", updatedAt: now };
  });
  if (!lock.committed) throw new HttpsError("already-exists", "A pending friend request already exists.");
}

async function releaseCreatingLock(key: string, requestId: string): Promise<void> {
  await database.ref(`friendRequestPairIndex/${key}`).transaction((current) => {
    if (current?.requestId === requestId && current?.status === "creating") return null;
    return;
  });
}

export const createFriendRequest = onCall(async (request) => {
  const fromUid = requireUid(request.auth);
  const toUid = requireString(request.data?.toUid, "toUid");
  if (fromUid === toUid) throw new HttpsError("invalid-argument", "You cannot send a request to yourself.");

  const [targetProfile, friendship] = await Promise.all([
    database.ref(`users/${toUid}`).get(),
    database.ref(`friends/${fromUid}/${toUid}`).get(),
  ]);
  if (!targetProfile.exists()) throw new HttpsError("not-found", "The requested user does not exist.");
  if (friendship.exists()) throw new HttpsError("already-exists", "You are already friends.");

  const requestId = database.ref("friendRequests").push().key;
  if (!requestId) throw new HttpsError("internal", "Could not create a request ID.");
  const now = Date.now();
  const key = pairKey(fromUid, toUid);
  await lockPair(key, requestId, now);

  try {
    const requestRecord: FriendRequestRecord = { fromUid, toUid, status: "pending", createdAt: now };
    const notificationId = database.ref(`notifications/${toUid}`).push().key;
    const updates: Record<string, unknown> = {
      [`friendRequests/${requestId}`]: requestRecord,
      [`friendRequestIndex/${fromUid}/${requestId}`]: requestIndex("outgoing", toUid, "pending", now),
      [`friendRequestIndex/${toUid}/${requestId}`]: requestIndex("incoming", fromUid, "pending", now),
      [`friendRequestPairIndex/${key}`]: { requestId, status: "pending", updatedAt: now },
    };
    if (notificationId) {
      updates[`notifications/${toUid}/${notificationId}`] = {
        type: "friend_request", fromUid, read: false, createdAt: now,
      };
    }
    await database.ref().update(updates);
    return { requestId, status: "pending" };
  } catch (error) {
    await releaseCreatingLock(key, requestId);
    console.error("[FriendRequest] create failed:", error);

    // Preserve intentional Firebase callable errors. Convert unexpected
    // infrastructure/runtime failures to a useful server-side error.
    if (error instanceof HttpsError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Unknown server error";
    throw new HttpsError("internal", `Could not create the friend request: ${message}`);
  }
});

async function claimRequestStatus(
  requestId: string,
  uid: string,
  status: Exclude<RequestStatus, "pending">,
  role: "sender" | "recipient"
): Promise<FriendRequestRecord> {
  const requestRef = database.ref(`friendRequests/${requestId}`);
  const snapshot = await requestRef.get();

  if (!snapshot.exists()) {
    throw new HttpsError("not-found", "Friend request not found.");
  }

  const current = snapshot.val() as FriendRequestRecord;

  if (role === "recipient" && current.toUid !== uid) {
    throw new HttpsError("permission-denied", "Only the recipient can manage this request.");
  }
  if (role === "sender" && current.fromUid !== uid) {
    throw new HttpsError("permission-denied", "Only the sender can manage this request.");
  }
  if (current.status !== "pending") {
    throw new HttpsError("failed-precondition", "Friend request is no longer pending.");
  }

  const transaction = await requestRef.transaction((value) => {
    if (!value) return;

    const latest = value as FriendRequestRecord;

    // The transaction is the authoritative claim. If another request
    // already transitioned this record, abort instead of overwriting it.
    if (latest.status !== "pending") return;

    // Re-check ownership against the transaction's current value.
    if (role === "recipient" && latest.toUid !== uid) return;
    if (role === "sender" && latest.fromUid !== uid) return;

    return { ...latest, status };
  });

  if (!transaction.committed || !transaction.snapshot.exists()) {
    throw new HttpsError("failed-precondition", "Friend request was already handled.");
  }

  return transaction.snapshot.val() as FriendRequestRecord;
}

async function updateRequestIndexes(
  requestId: string,
  friendRequest: FriendRequestRecord,
  status: Exclude<RequestStatus, "pending">,
  createFriendship: boolean
): Promise<void> {
  const now = Date.now();
  const key = pairKey(friendRequest.fromUid, friendRequest.toUid);

  const updates: Record<string, unknown> = {
    [`friendRequestIndex/${friendRequest.fromUid}/${requestId}/status`]: status,
    [`friendRequestIndex/${friendRequest.toUid}/${requestId}/status`]: status,
    [`friendRequestPairIndex/${key}`]: { requestId, status, updatedAt: now },
  };

  if (createFriendship) {
    const friendshipId = [friendRequest.fromUid, friendRequest.toUid].sort().join("__");

    updates[`friendships/${friendshipId}`] = {
      participants: [friendRequest.fromUid, friendRequest.toUid],
      since: now,
    };

    updates[`friends/${friendRequest.fromUid}/${friendRequest.toUid}`] = {
      uid: friendRequest.toUid,
      since: now,
    };

    updates[`friends/${friendRequest.toUid}/${friendRequest.fromUid}`] = {
      uid: friendRequest.fromUid,
      since: now,
    };

    const notificationId = database.ref(`notifications/${friendRequest.fromUid}`).push().key;

    if (notificationId) {
      updates[`notifications/${friendRequest.fromUid}/${notificationId}`] = {
        type: "friend_accepted",
        fromUid: friendRequest.toUid,
        read: false,
        createdAt: now,
      };
    }
  }

  await database.ref().update(updates);
}

export const acceptFriendRequest = onCall(async (request) => {
  const uid = requireUid(request.auth);
  const requestId = requireString(request.data?.requestId, "requestId");

  const friendRequest = await claimRequestStatus(
    requestId,
    uid,
    "accepted",
    "recipient"
  );

  await updateRequestIndexes(requestId, friendRequest, "accepted", true);

  return { status: "accepted" };
});

export const declineFriendRequest = onCall(async (request) => {
  const uid = requireUid(request.auth);
  const requestId = requireString(request.data?.requestId, "requestId");

  const friendRequest = await claimRequestStatus(
    requestId,
    uid,
    "declined",
    "recipient"
  );

  await updateRequestIndexes(requestId, friendRequest, "declined", false);

  return { status: "declined" };
});

export const cancelFriendRequest = onCall(async (request) => {
  const uid = requireUid(request.auth);
  const requestId = requireString(request.data?.requestId, "requestId");

  const friendRequest = await claimRequestStatus(
    requestId,
    uid,
    "cancelled",
    "sender"
  );

  await updateRequestIndexes(requestId, friendRequest, "cancelled", false);

  return { status: "cancelled" };
});
