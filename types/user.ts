export type UserProfile = {
  uid: string;
  username: string;
  displayName: string;
  photoURL: string;
  bio: string;
  createdAt: number;
  updatedAt: number;
  lastSeen: number;
  online: boolean;
};

export type FriendRequest = {
  id: string;
  fromUid: string;
  toUid: string;
  status: "pending" | "accepted" | "declined";
  createdAt: number;
};

export type FriendEntry = {
  uid: string;
  since: number;
};

// Stored at /chatMeta/{roomId}
export type ChatMeta = {
  roomId: string;
  participants: { 0: string; 1: string }; // RTDB stores arrays as {0:uid, 1:uid}
  lastMessage: string; // always "🔐 New private message" — never plaintext
  lastMessageAt: number;
  unreadCounts?: Record<string, number>; // { [uid]: count }
};
