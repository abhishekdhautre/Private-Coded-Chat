export type StoredMessage = {
  ciphertext: string;
  iv: string;
  senderId: string;
  timestamp: number;
  expiresAt?: number | null;
  mediaType?: string | null;   // "image" | "video" | null
  mediaData?: string | null;   // AES-GCM encrypted base64 of the file bytes
  mediaIv?: string | null;     // IV for mediaData encryption
};

export type DecryptedMessage = StoredMessage & {
  id: string;
  plaintext: string;
  mediaBlobUrl?: string | null;
};
