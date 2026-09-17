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
};
