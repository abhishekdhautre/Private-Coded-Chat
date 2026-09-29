/**
 * Structured error classification for V3 message decryption failures.
 *
 * Maps technical error messages to categories without exposing secrets.
 * Used for diagnostics and stale-session protection.
 *
 * RULE: Never include plaintext, ciphertext, keys, or message content in
 * any diagnostic output or category determination.
 */
export type DecryptFailureCategory =
  | "stale-session"
  | "wrong-room"
  | "wrong-epoch"
  | "missing-epoch-key"
  | "missing-device"
  | "invalid-device-signature"
  | "missing-ratchet-state"
  | "sequence-too-old"
  | "sequence-gap"
  | "skipped-key-missing"
  | "invalid-message-signature"
  | "aad-mismatch"
  | "ciphertext-invalid"
  | "decrypt-failed"
  | "duplicate-delivery"
  | "media-failure"
  | "unknown";

/**
 * Classifies a decrypt failure error into a category.
 * The classification is based on error type, message patterns, and context
 * — never on plaintext or secret data.
 */
export function classifyDecryptFailure(
  error: unknown,
  context: {
    messageId: string;
    senderUid?: string | undefined;
    senderDeviceId?: string | undefined;
    roomId: string;
    currentUid: string;
    currentDeviceId?: string | undefined;
    epoch?: number | undefined;
    sequenceNumber?: number | undefined;
    cryptoVersion?: string | undefined;
    isV2?: boolean | undefined;
    failureStage?: string | undefined;
  }
): { category: DecryptFailureCategory; reason: string } {
  const msg =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);

  // Helper: check if error message contains a known pattern
  const contains = (pattern: string) =>
    msg.toLowerCase().includes(pattern.toLowerCase());

  // 1. Stale session: error mentions session, context changed, or old operation
  if (
    contains("stale") ||
    contains("session") ||
    contains("context") ||
    contains("changed") ||
    contains("cleared") ||
    contains("unmounted") ||
    contains("destroyed")
  ) {
    return {
      category: "stale-session",
      reason: "Decrypt operation from a previous session context",
    };
  }

  // 2. Wrong room: error mentions room mismatch
  if (contains("room") || contains("wrong room")) {
    return { category: "wrong-room", reason: "Message from wrong room context" };
  }

  // 3. Wrong epoch: error mentions epoch mismatch
  if (contains("epoch") && !contains("key") && !contains("key")) {
    // Distinguish from missing-epoch-key below
    if (contains("mismatch") || contains("different epoch")) {
      return { category: "wrong-epoch", reason: "Epoch mismatch in message" };
    }
  }

  // 4. Missing epoch key: no key available for the epoch
  if (
    contains("no epoch key") ||
    contains("no key available") ||
    contains("epoch key") &&
      (contains("not found") || contains("missing") || contains("unavailable"))
  ) {
    return {
      category: "missing-epoch-key",
      reason: "No epoch key available for the message's epoch",
    };
  }

  // 5. Missing device: sender device not found or unregistered
  if (
    contains("device") &&
    (contains("not found") || contains("unregistered") || contains("missing"))
  ) {
    return {
      category: "missing-device",
      reason: "Sender device not found or unregistered",
    };
  }

  // 6. Invalid device signature: ECDSA signature verification failed
  if (contains("signature") && contains("failed")) {
    return {
      category: "invalid-device-signature",
      reason: "Sender device identity signature verification failed",
    };
  }

  // 7. Missing ratchet state: ratchet chain not initialized or lost
  if (
    contains("ratchet") &&
    (contains("missing") || contains("lost") || contains("not initialized"))
  ) {
    return {
      category: "missing-ratchet-state",
      reason: "Ratchet chain state missing or lost",
    };
  }

  // 8. Sequence too old: message sequence number has passed the ratchet chain
  if (contains("already passed") || contains("passed for active")) {
    return {
      category: "sequence-too-old",
      reason: "Message sequence number has already passed the active ratchet chain",
    };
  }

  // 9. Sequence gap: out-of-order message requiring skipped key consumption
  if (contains("gap") || contains("out-of-order") || contains("catch up")) {
    return {
      category: "sequence-gap",
      reason: "Message requires skipped key consumption (out-of-order delivery)",
    };
  }

  // 10. Skipped key missing: no skipped key available in the store
  if (
    contains("skipped key") ||
    contains("no skipped key") ||
    contains("key not in store")
  ) {
    return {
      category: "skipped-key-missing",
      reason: "No skipped key available for the message sequence gap",
    };
  }

  // 11. Invalid message signature: message ECDSA signature verification failed
  if (contains("message.*signature") || contains("message signature")) {
    return {
      category: "invalid-message-signature",
      reason: "Message ECDSA signature verification failed",
    };
  }

  // 12. AAD mismatch: Additional Authenticated Data context mismatch
  if (contains("aad") || context.failureStage === "aad-mismatch") {
    return {
      category: "aad-mismatch",
      reason: "Additional Authenticated Data context mismatch",
    };
  }

  // 13. Ciphertext invalid: ciphertext decryption issues
  if (contains("ciphertext")) {
    return {
      category: "ciphertext-invalid",
      reason: "Ciphertext decryption issue",
    };
  }

  // 14. Decrypt failed: generic AES-GCM decryption failure
  if (
    contains("failed to decrypt") ||
    contains("decrypt") ||
    contains("AES-GCM") ||
    contains("authentication tag")
  ) {
    return {
      category: "decrypt-failed",
      reason: "AES-GCM decryption failed (ciphertext, IV, or AAD context mismatch)",
    };
  }

  // 15. Duplicate delivery: message already processed
  if (contains("replay") || contains("already processed")) {
    return {
      category: "duplicate-delivery",
      reason: "Message already processed (duplicate delivery)",
    };
  }

  // 16. Media failure: media-specific decrypt failure
  if (context.failureStage === "media") {
    return {
      category: "media-failure",
      reason: "Media decryption or blob reconstruction failed",
    };
  }

  // Default: unknown
  return {
    category: "unknown",
    reason: `Unknown decrypt failure: ${msg.substring(0, 80)}...`,
  };
}