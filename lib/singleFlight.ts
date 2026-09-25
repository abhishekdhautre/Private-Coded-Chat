/**
 * Single-flight coalescing for asynchronous work keyed by an id.
 *
 * Why the chat page needs this: Firebase can deliver the SAME message row from
 * two directions before the first decryption has finished —
 *
 *   1. `child_added` racing `child_changed`. The sender's own echo starts
 *      decrypting (one `get()` for the sender bundle), and the peer's read
 *      receipt writes `readBy/{uid}` onto that same row while it is still in
 *      flight. The changed handler found no cached entry yet, so it entered
 *      the receive path a second time.
 *   2. A listener re-subscription (lock/unlock, remount, room re-entry)
 *      replaying history while an earlier decrypt of the same row is pending.
 *
 * Running the receive path twice for one messageId meant two concurrent
 * ratchet advances, and — because the loser settles last — a failed second
 * attempt could overwrite an already-decrypted bubble with
 * "Unable to decrypt message." permanently (the winner had already added the
 * id to the processed set, so no later redelivery retried it).
 *
 * This is pure UI-layer concurrency control. It never decides whether a
 * message is authentic: it only guarantees ONE in-flight run per key so every
 * caller observes the same, single result. Failures stay failures and remain
 * retryable — nothing is suppressed or invented.
 */

/** A run currently in progress for one key. */
export interface InFlightRun<T> {
  /** Payload identity of the run (e.g. ciphertext + media payload). */
  fingerprint: string;
  promise: Promise<T>;
}

/**
 * Runs `run()` at most once per (key, fingerprint) at a time.
 *
 * - Same key + same fingerprint while a run is in flight → returns that run's
 *   promise; `run` is NOT invoked again.
 * - Same key + different fingerprint → waits for the in-flight run to settle,
 *   then starts a fresh one (an edit landing mid-decryption must re-decrypt).
 * - After a run settles (success or failure) its slot is released, so a later
 *   delivery runs again — failures are never cached by this layer.
 *
 * The critical section between the last `await` and `inFlight.set` is fully
 * synchronous, so no two callers can both start a run for the same key.
 */
export async function singleFlight<K, T>(
  inFlight: Map<K, InFlightRun<T>>,
  key: K,
  fingerprint: string,
  run: () => Promise<T>
): Promise<T> {
  for (;;) {
    const existing = inFlight.get(key);
    if (!existing) break;
    if (existing.fingerprint === fingerprint) return existing.promise;
    await existing.promise.catch(() => undefined);
  }

  const entry: InFlightRun<T> = { fingerprint, promise: run() };
  inFlight.set(key, entry);
  try {
    return await entry.promise;
  } finally {
    if (inFlight.get(key) === entry) inFlight.delete(key);
  }
}
