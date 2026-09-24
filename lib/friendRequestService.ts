import { ref, runTransaction, get, update, push } from "firebase/database";
import { auth, db } from "@/lib/firebase";

export function friendshipId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join("__");
}

export async function createFriendRequest(toUid: string): Promise<string> {
  const fromUid = auth.currentUser?.uid;
  if (!fromUid) throw new Error("You must be logged in to send a friend request.");
  if (fromUid === toUid) throw new Error("You cannot send a request to yourself.");

  const targetSnap = await get(ref(db, `users/${toUid}`));
  if (!targetSnap.exists()) throw new Error("The requested user does not exist.");

  const friendSnap = await get(ref(db, `friends/${fromUid}/${toUid}`));
  if (friendSnap.exists()) throw new Error("You are already friends.");

  const requestId = friendshipId(fromUid, toUid);
  const requestRef = ref(db, `friendRequests/${requestId}`);

  const txResult = await runTransaction(requestRef, (current) => {
    if (current && current.status === "pending") {
      return; // abort — pending request already exists
    }
    return {
      fromUid,
      toUid,
      status: "pending",
      createdAt: Date.now(),
    };
  });

  if (!txResult.committed || !txResult.snapshot.exists()) {
    throw new Error("A pending friend request already exists.");
  }

  const now = txResult.snapshot.val().createdAt;
  const notifId = push(ref(db, `notifications/${toUid}`)).key;

  const updates: Record<string, unknown> = {
    [`friendRequestIndex/${fromUid}/${requestId}`]: {
      direction: "outgoing",
      otherUid: toUid,
      status: "pending",
      createdAt: now,
    },
    [`friendRequestIndex/${toUid}/${requestId}`]: {
      direction: "incoming",
      otherUid: fromUid,
      status: "pending",
      createdAt: now,
    },
  };

  if (notifId) {
    updates[`notifications/${toUid}/${notifId}`] = {
      type: "friend_request",
      fromUid,
      read: false,
      createdAt: now,
    };
  }

  await update(ref(db), updates);
  return requestId;
}

export async function acceptFriendRequest(requestId: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("You must be logged in to accept friend requests.");

  const requestRef = ref(db, `friendRequests/${requestId}`);

  const txResult = await runTransaction(requestRef, (current) => {
    if (!current) return;
    if (current.toUid !== uid) return;
    if (current.status !== "pending") return;

    return {
      ...current,
      status: "accepted",
    };
  });

  if (!txResult.committed || !txResult.snapshot.exists()) {
    throw new Error("Friend request is no longer pending or cannot be accepted.");
  }

  const req = txResult.snapshot.val() as {
    fromUid: string;
    toUid: string;
    status: string;
    createdAt: number;
  };

  const now = Date.now();
  const notifId = push(ref(db, `notifications/${req.fromUid}`)).key;

  const updates: Record<string, unknown> = {
    [`friendRequestIndex/${req.fromUid}/${requestId}/status`]: "accepted",
    [`friendRequestIndex/${req.toUid}/${requestId}/status`]: "accepted",
    [`friendships/${requestId}`]: {
      participants: [req.fromUid, req.toUid],
      since: now,
    },
    [`friends/${req.fromUid}/${req.toUid}`]: {
      uid: req.toUid,
      since: now,
    },
    [`friends/${req.toUid}/${req.fromUid}`]: {
      uid: req.fromUid,
      since: now,
    },
  };

  if (notifId) {
    updates[`notifications/${req.fromUid}/${notifId}`] = {
      type: "friend_accepted",
      fromUid: req.toUid,
      read: false,
      createdAt: now,
    };
  }

  await update(ref(db), updates);
}

export async function declineFriendRequest(requestId: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("You must be logged in to decline friend requests.");

  const requestRef = ref(db, `friendRequests/${requestId}`);

  const txResult = await runTransaction(requestRef, (current) => {
    if (!current) return;
    if (current.toUid !== uid) return;
    if (current.status !== "pending") return;

    return {
      ...current,
      status: "declined",
    };
  });

  if (!txResult.committed || !txResult.snapshot.exists()) {
    throw new Error("Friend request is no longer pending or cannot be declined.");
  }

  const req = txResult.snapshot.val() as { fromUid: string; toUid: string; status: string };

  const updates: Record<string, unknown> = {
    [`friendRequestIndex/${req.fromUid}/${requestId}/status`]: "declined",
    [`friendRequestIndex/${req.toUid}/${requestId}/status`]: "declined",
  };

  await update(ref(db), updates);
}

export async function cancelFriendRequest(requestId: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("You must be logged in to cancel friend requests.");

  const requestRef = ref(db, `friendRequests/${requestId}`);

  const txResult = await runTransaction(requestRef, (current) => {
    if (!current) return;
    if (current.fromUid !== uid) return;
    if (current.status !== "pending") return;

    return {
      ...current,
      status: "cancelled",
    };
  });

  if (!txResult.committed || !txResult.snapshot.exists()) {
    throw new Error("Friend request is no longer pending or cannot be cancelled.");
  }

  const req = txResult.snapshot.val() as { fromUid: string; toUid: string; status: string };

  const updates: Record<string, unknown> = {
    [`friendRequestIndex/${req.fromUid}/${requestId}/status`]: "cancelled",
    [`friendRequestIndex/${req.toUid}/${requestId}/status`]: "cancelled",
  };

  await update(ref(db), updates);
}
