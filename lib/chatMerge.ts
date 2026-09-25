/**
 * Pure message-list helpers for the realtime chat pipeline.
 *
 * The chat page has exactly ONE writer path for incoming rows
 * (`onChildAdded` → `decryptRow` → `setMessages`), and history arrives through
 * that same path as the listener's initial replay — there is no separate
 * `get()` history load that could overwrite newer realtime rows. These helpers
 * encode the merge contract so it is unit-testable without React/Firebase:
 *
 * - `mergeIncomingMessage`: insert-or-ignore by messageId, timestamp-sorted.
 *   A replayed row, a live row and a re-delivered row all converge to the same
 *   list — no duplicates, no lost messages, regardless of arrival order.
 * - `partitionExpired`: split a message list into kept/expired at `now` for
 *   the client-side expiry sweep (disappearing / 30s media).
 *
 * No Firebase, no crypto, no DOM in this module.
 */

export interface MergeableMessage {
  id: string;
  timestamp: number;
}

/**
 * Merges one decrypted message into the rendered list.
 *
 * Returns the previous array UNCHANGED (same reference) when the id is
 * already present, so React bails out and no duplicate bubble is created.
 * Otherwise returns a new array with the message appended and the list sorted
 * by timestamp — history replay and live realtime deliveries interleave safely
 * because every update is a pure function of the previous list.
 */
export function mergeIncomingMessage<T extends MergeableMessage>(
  prev: T[],
  msg: T
): T[] {
  if (prev.some((m) => m.id === msg.id)) return prev;
  const next = [...prev, msg];
  next.sort((a, b) => a.timestamp - b.timestamp);
  return next;
}

export interface ExpirableMessage extends MergeableMessage {
  expiresAt?: number | null;
}

/**
 * Splits a message list at `now`. A row whose `expiresAt` has been reached
 * (inclusive) is expired; rows without `expiresAt` are always kept.
 */
export function partitionExpired<T extends ExpirableMessage>(
  list: T[],
  now: number
): { kept: T[]; expired: T[] } {
  const kept: T[] = [];
  const expired: T[] = [];
  for (const m of list) {
    if (m.expiresAt && m.expiresAt <= now) expired.push(m);
    else kept.push(m);
  }
  return { kept, expired };
}
