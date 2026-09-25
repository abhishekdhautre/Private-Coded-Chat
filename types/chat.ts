export type MessageType = "text" | "image" | "video" | "sticker" | "gif";

export type Reaction = {
  [uid: string]: string; // uid -> emoji
};

export type StoredMessage = {
  ciphertext: string;
  iv: string;
  senderId: string;
  timestamp: number;
  expiresAt?: number | null;
  // legacy media fields (image/video)
  mediaType?: string | null;
  mediaData?: string | null;
  mediaIv?: string | null;
  // Real MIME type of the picked file (image/heic, image/png, video/quicktime…).
  // Optional: rows written before this existed fall back to a legacy guess.
  mediaMime?: string | null;
  // extended type
  msgType?: MessageType;
  // sticker: stickerUrl stored as plaintext (not sensitive)
  stickerUrl?: string | null;
  // gif: gifUrl stored as plaintext
  gifUrl?: string | null;
  gifPreview?: string | null;
  // reactions: { uid: emoji }
  reactions?: Reaction | null;
  // disappearing: viewedAt per uid
  viewedAt?: { [uid: string]: number } | null;
  replyTo?: string | null;
  editedAt?: number | null;
  deletedFor?: { [uid: string]: boolean } | null;
  readBy?: { [uid: string]: number } | null;
  pinned?: boolean;
  ghostLifetimeMs?: number | null;
  viewOnce?: boolean;
  consumedBy?: { [uid: string]: number } | null;
};

export type DecryptedMessage = StoredMessage & {
  id: string;
  plaintext: string;
  mediaBlobUrl?: string | null;
};

export type RoomMeta = {
  participants: { 0: string; 1: string };
  keyCheck: { ciphertext: string; iv: string };
  disappearing?: boolean;
  disappearingViewedAt?: { [uid: string]: number };
  mode?: ConversationMode;
  ghostLifetimeMs?: number | null;
  sessionExpiresAt?: number | null;
  pulseEnabled?: boolean;
};

export type ConversationMode = "NORMAL" | "GHOST" | "BURST" | "VAULT" | "STEALTH" | "LIVE";

export type NotificationPreferences = {
  messages: boolean;
  reactions: boolean;
  replies: boolean;
  mentions: boolean;
  calls: boolean;
  ghostMessages: boolean;
  moments: boolean;
  activity: boolean;
  privacy: "hide-content" | "show-content" | "hide-sender" | "disabled";
};
