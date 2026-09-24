import { ref, runTransaction, get, update, push, remove } from "firebase/database";
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
  const myIndexRef = ref(db, `friendRequestIndex/${fromUid}/${requestId}`);

  const now = Date.now();

  const txResult = await runTransaction(myIndexRef, (current) => {
    if (current && current.status === "pending") {
      return; // abort — pending request already exists
    }
    return {
      direction: "outgoing",
      otherUid: toUid,
      status: "pending",
      createdAt: now,
    };
  });

  if (!txResult.committed || !txResult.snapshot.exists()) {
    throw new Error("A pending friend request already exists.");
  }

  const notifId = push(ref(db, `notifications/${toUid}`)).key;

  const updates: Record<string, unknown> = {
    [`friendRequests/${requestId}`]: {
      fromUid,
      toUid,
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

  try {
    await update(ref(db), updates);
  } catch (error) {
    console.error("[createFriendRequest] multi-location update failed:", error);
    await remove(myIndexRef).catch(() => {});
    throw error;
  }

  return requestId;
}

export async function acceptFriendRequest(requestId: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("You must be logged in to accept friend requests.");

  const reqSnap = await get(ref(db, `friendRequests/${requestId}`));
  if (!reqSnap.exists()) {
    throw new Error("Friend request not found.");
  }

  const req = reqSnap.val() as {
    fromUid: string;
    toUid: string;
    status: string;
    createdAt: number;
  };

  if (req.toUid !== uid) {
    throw new Error("Only the recipient can accept this friend request.");
  }
  if (req.status !== "pending") {
    throw new Error("Friend request is no longer pending.");
  }

  // Atomically claim state transition on recipient's own incoming index
  const myIndexRef = ref(db, `friendRequestIndex/${uid}/${requestId}`);
  const txResult = await runTransaction(myIndexRef, (current) => {
    if (!current || current.status !== "pending") return;
    return {
      ...current,
      status: "accepted",
    };
  });

  if (!txResult.committed) {
    throw new Error("Friend request was already handled.");
  }

  const now = Date.now();
  const notifId = push(ref(db, `notifications/${req.fromUid}`)).key;

  const updates: Record<string, unknown> = {
    [`friendRequests/${requestId}/status`]: "accepted",
    [`friendRequestIndex/${req.fromUid}/${requestId}/status`]: "accepted",
    [`friendships/${requestId}`]: {
      participants: { 0: req.fromUid, 1: req.toUid },
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

  try {
    console.log("[acceptFriendRequest] executing multi-location update on keys:", Object.keys(updates));
    await update(ref(db), updates);
    console.log("[acceptFriendRequest] update SUCCESS!");
  } catch (error) {
    console.error("[acceptFriendRequest] multi-location update FAILED:", error);
    // Rollback index claim on failure
    await update(ref(db), { [`friendRequestIndex/${uid}/${requestId}/status`]: "pending" }).catch(() => {});
    throw error;
  }
}

export async function declineFriendRequest(requestId: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("You must be logged in to decline friend requests.");

  const reqSnap = await get(ref(db, `friendRequests/${requestId}`));
  if (!reqSnap.exists()) {
    throw new Error("Friend request not found.");
  }

  const req = reqSnap.val() as { fromUid: string; toUid: string; status: string };

  if (req.toUid !== uid) {
    throw new Error("Only the recipient can decline this friend request.");
  }
  if (req.status !== "pending") {
    throw new Error("Friend request is no longer pending.");
  }

  const myIndexRef = ref(db, `friendRequestIndex/${uid}/${requestId}`);
  const txResult = await runTransaction(myIndexRef, (current) => {
    if (!current || current.status !== "pending") return;
    return {
      ...current,
      status: "declined",
    };
  });

  if (!txResult.committed) {
    throw new Error("Friend request was already handled.");
  }

  const updates: Record<string, unknown> = {
    [`friendRequests/${requestId}/status`]: "declined",
    [`friendRequestIndex/${req.fromUid}/${requestId}/status`]: "declined",
  };

  try {
    await update(ref(db), updates);
  } catch (error) {
    console.error("[declineFriendRequest] multi-location update failed:", error);
    await update(ref(db), { [`friendRequestIndex/${uid}/${requestId}/status`]: "pending" }).catch(() => {});
    throw error;
  }
}

export async function cancelFriendRequest(requestId: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("You must be logged in to cancel friend requests.");

  const reqSnap = await get(ref(db, `friendRequests/${requestId}`));
  if (!reqSnap.exists()) {
    throw new Error("Friend request not found.");
  }

  const req = reqSnap.val() as { fromUid: string; toUid: string; status: string };

  if (req.fromUid !== uid) {
    throw new Error("Only the sender can cancel this friend request.");
  }
  if (req.status !== "pending") {
    throw new Error("Friend request is no longer pending.");
  }

  const myIndexRef = ref(db, `friendRequestIndex/${uid}/${requestId}`);
  const txResult = await runTransaction(myIndexRef, (current) => {
    if (!current || current.status !== "pending") return;
    return {
      ...current,
      status: "cancelled",
    };
  });

  if (!txResult.committed) {
    throw new Error("Friend request was already handled.");
  }

  const updates: Record<string, unknown> = {
    [`friendRequests/${requestId}/status`]: "cancelled",
    [`friendRequestIndex/${req.toUid}/${requestId}/status`]: "cancelled",
  };

  try {
    await update(ref(db), updates);
  } catch (error) {
    console.error("[cancelFriendRequest] multi-location update failed:", error);
    await update(ref(db), { [`friendRequestIndex/${uid}/${requestId}/status`]: "pending" }).catch(() => {});
    throw error;
  }
}
