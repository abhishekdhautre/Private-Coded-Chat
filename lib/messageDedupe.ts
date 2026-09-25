/**
 * UI-level duplicate-delivery suppression for the chat message listener.
 *
 * Firebase `onChildAdded` replays every existing child whenever the listener
 * is (re)attached — on mount, on StrictMode remount, and on any effect
 * re-subscription. Without suppression, each replayed row re-enters the
 * cryptographic decrypt path, where the module-level replay detector
 * (`seenMessageIds` in messageCryptoV2) correctly rejects the already-seen
 * messageId — producing noisy, misleading "Replay attack detected" console
 * errors for what is simply a normal duplicate delivery.
 *
 * This helper decides, purely from identifiers and ciphertext fingerprints,
 * whether a delivery may be skipped BEFORE any crypto runs:
 *
 * - Skip only when the messageId has a cached entry AND that entry previously
 *   decrypted successfully AND the row's ciphertext/media payload is unchanged.
 * - Never skip when there is no cached entry (new message).
 * - Never skip when the previous attempt failed (decryptOk === false), so
 *   failures stay retryable on redelivery.
 * - Never skip when ciphertext or media bytes changed (edits / new media).
 * - Never key off sequenceNumber — messageId only.
 *
 * Cryptographic replay protection, signature verification, and sequence
 * validation in messageCryptoV2/ratchetV2 are untouched and remain the
 * authoritative defense; this is purely a UI-layer idempotency guard.
 */

export interface DedupeFingerprint {
  ciphertext?: string | null;
  mediaData?: string | null;
}

export function isDuplicateDelivery(params: {
  /** Cached decrypted entry for this messageId, if the UI has one. */
  cached?: DedupeFingerprint | null;
  /** True only if the cached entry previously decrypted successfully. */
  decryptedSuccessfully: boolean;
  /** Fingerprint of the freshly delivered row. */
  row: DedupeFingerprint;
}): boolean {
  const { cached, decryptedSuccessfully, row } = params;

  if (!cached) return false;
  if (!decryptedSuccessfully) return false;

  return (
    cached.ciphertext === row.ciphertext &&
    (cached.mediaData ?? null) === (row.mediaData ?? null)
  );
}
