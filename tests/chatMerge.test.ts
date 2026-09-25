/**
 * Regression tests for the realtime merge contract (lib/chatMerge.ts).
 *
 * The chat page renders from exactly ONE writer path — `onChildAdded` (live
 * rows and the listener's initial history replay alike) → `setMessages` with
 * a functional update. These tests pin the merge semantics that keep that
 * pipeline loss-free and duplicate-free:
 *
 * - a new row is appended (and the list stays timestamp-sorted)
 * - a duplicate delivery of the same messageId changes nothing (same ref)
 * - history replay interleaved with live arrivals converges to one list
 * - media rows merge exactly like text rows (payload-agnostic)
 * - expiry partition keeps unexpired rows and collects expired ones
 */
import { describe, it, expect } from 'vitest';
import { mergeIncomingMessage, partitionExpired } from '@/lib/chatMerge';

interface Row {
  id: string;
  timestamp: number;
  mediaData?: string | null;
  expiresAt?: number | null;
}

function row(id: string, timestamp: number, extra?: Partial<Row>): Row {
  return { id, timestamp, ...extra };
}

describe('mergeIncomingMessage', () => {
  it('appends a new realtime row to an empty list', () => {
    const next = mergeIncomingMessage([], row('m1', 1000));
    expect(next).toEqual([row('m1', 1000)]);
  });

  it('appends a new live row after replayed history, keeping timestamp order', () => {
    const history = [row('h1', 1000), row('h2', 2000)];
    const next = mergeIncomingMessage(history, row('live', 3000));
    expect(next.map((m) => m.id)).toEqual(['h1', 'h2', 'live']);
    expect(history).toHaveLength(2); // input untouched
  });

  it('inserts an older row in timestamp order (late / out-of-order arrival)', () => {
    const prev = [row('h1', 1000), row('h3', 3000)];
    const next = mergeIncomingMessage(prev, row('h2', 2000));
    expect(next.map((m) => m.id)).toEqual(['h1', 'h2', 'h3']);
  });

  it('duplicate realtime delivery of the same messageId changes nothing', () => {
    const prev = [row('h1', 1000), row('m1', 2000)];
    const next = mergeIncomingMessage(prev, row('m1', 2000));
    expect(next).toBe(prev); // same reference → React bails out, no duplicate bubble
    expect(next).toHaveLength(2);
  });

  it('history replay interleaved with live arrivals converges without loss or duplication', () => {
    // Listener replays h1..h3 while two live rows arrive mid-replay, plus a
    // duplicate redelivery of h2 (re-attach / StrictMode style).
    let list: Row[] = [];
    const deliveries: Row[] = [
      row('h1', 1000),
      row('live-a', 4000),
      row('h2', 2000),
      row('h2', 2000), // duplicate
      row('h3', 3000),
      row('live-b', 5000),
      row('live-a', 4000), // duplicate
    ];
    for (const d of deliveries) list = mergeIncomingMessage(list, d);
    expect(list.map((m) => m.id)).toEqual(['h1', 'h2', 'h3', 'live-a', 'live-b']);
  });

  it('media rows merge exactly like text rows', () => {
    const prev = [row('t1', 1000)];
    const media = row('img1', 2000, { mediaData: 'base64…', expiresAt: 9999 });
    const next = mergeIncomingMessage(prev, media);
    expect(next.map((m) => m.id)).toEqual(['t1', 'img1']);
    expect(next[1]).toBe(media);
    // Duplicate media delivery (child_changed echo) does not duplicate.
    expect(mergeIncomingMessage(next, media)).toBe(next);
  });
});

describe('partitionExpired', () => {
  it('keeps unexpired rows and collects expired ones for cleanup', () => {
    const list = [
      row('keep1', 1000),
      row('gone', 2000, { expiresAt: 5000 }),
      row('keep2', 3000, { expiresAt: 9000 }),
      row('edge', 4000, { expiresAt: 6000 }),
    ];
    const { kept, expired } = partitionExpired(list, 6000);
    expect(kept.map((m) => m.id)).toEqual(['keep1', 'keep2']);
    expect(expired.map((m) => m.id)).toEqual(['gone', 'edge']); // expiresAt <= now counts
  });

  it('rows without expiresAt are never expired', () => {
    const list = [row('a', 1000), row('b', 2000)];
    const { kept, expired } = partitionExpired(list, Number.MAX_SAFE_INTEGER);
    expect(kept).toHaveLength(2);
    expect(expired).toHaveLength(0);
  });

  it('30s media window: media past its window is collected for revoke + removal', () => {
    const sentAt = 1_000_000;
    const media = row('img1', sentAt, { mediaData: 'base64…', expiresAt: sentAt + 30_000 });
    expect(partitionExpired([media], sentAt + 29_999).expired).toHaveLength(0);
    const { kept, expired } = partitionExpired([media], sentAt + 30_000);
    expect(kept).toHaveLength(0);
    expect(expired.map((m) => m.id)).toEqual(['img1']);
  });
});
