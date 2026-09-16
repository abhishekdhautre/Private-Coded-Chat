export type StoredMessage = {
  ciphertext: string;
  iv: string;
  senderId: string;
  timestamp: number;
  expiresAt?: number | null;
};

export type DecryptedMessage = StoredMessage & { id: string; plaintext: string };
