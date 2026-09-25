/**
 * Regression tests for singleFlight() — the UI-layer guard that makes
 * decryptRow() run at most once per messageId at a time.
 *
 * Root cause under test: Firebase delivers the SAME row from two directions
 * while the first decrypt is still in flight (child_added racing a peer's
 * read-receipt child_changed, or a listener re-subscription replaying history
 * over a pending decrypt). Two concurrent receive paths for one id advance the
 * sender's ratchet chain twice and — because the loser settles last — the
 * failed attempt overwrote an already-decrypted bubble with
 * "Unable to decrypt message." permanently.
 */
import { describe, it, expect } from 'vitest';
import { singleFlight, type InFlightRun } from '@/lib/singleFlight';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  it('coalesces concurrent callers with the same key + fingerprint onto ONE run', async () => {
    const inFlight = new Map<string, InFlightRun<string>>();
    const gate = deferred<string>();
    let runs = 0;
    const run = () => {
      runs += 1;
      return gate.promise;
    };

    const first = singleFlight(inFlight, 'msg-1', 'fp-A', run);
    const second = singleFlight(inFlight, 'msg-1', 'fp-A', run);
    const third = singleFlight(inFlight, 'msg-1', 'fp-A', run);
    gate.resolve('decrypted');

    expect(await first).toBe('decrypted');
    expect(await second).toBe('decrypted');
    expect(await third).toBe('decrypted');
    expect(runs).toBe(1); // the receive path ran exactly once
    expect(inFlight.size).toBe(0);
  });

  it('does not serialize different keys (messages stay independent)', async () => {
    const inFlight = new Map<string, InFlightRun<string>>();
    let active = 0;
    let maxActive = 0;
    const run = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return 'ok';
    };

    await Promise.all([
      singleFlight(inFlight, 'msg-1', 'fp', run),
      singleFlight(inFlight, 'msg-2', 'fp', run),
      singleFlight(inFlight, 'msg-3', 'fp', run),
    ]);

    expect(maxActive).toBe(3);
  });

  it('shares one rejection with every coalesced caller and keeps it retryable', async () => {
    const inFlight = new Map<string, InFlightRun<string>>();
    let runs = 0;
    const run = async () => {
      runs += 1;
      throw new Error('decrypt exploded');
    };

    const first = singleFlight(inFlight, 'msg-1', 'fp', run);
    const second = singleFlight(inFlight, 'msg-1', 'fp', run);

    await expect(first).rejects.toThrow('decrypt exploded');
    await expect(second).rejects.toThrow('decrypt exploded');
    expect(runs).toBe(1);
    expect(inFlight.size).toBe(0); // slot released despite the failure

    // Failures are never cached by this layer — a later delivery retries.
    await expect(singleFlight(inFlight, 'msg-1', 'fp', run)).rejects.toThrow(
      'decrypt exploded'
    );
    expect(runs).toBe(2);
  });

  it('waits for an in-flight run whose payload changed, then runs fresh', async () => {
    const inFlight = new Map<string, InFlightRun<string>>();
    const order: string[] = [];
    const gate = deferred<void>();

    const original = singleFlight(inFlight, 'msg-1', 'cipher-v1', async () => {
      order.push('v1-start');
      await gate.promise;
      order.push('v1-end');
      return 'plain-v1';
    });
    // An edit lands while the first decrypt is still running.
    const edited = singleFlight(inFlight, 'msg-1', 'cipher-v2', async () => {
      order.push('v2-start');
      return 'plain-v2';
    });

    await Promise.resolve();
    expect(order).toEqual(['v1-start']); // edited run has NOT started yet

    gate.resolve();
    expect(await original).toBe('plain-v1');
    expect(await edited).toBe('plain-v2');
    expect(order).toEqual(['v1-start', 'v1-end', 'v2-start']);
    expect(inFlight.size).toBe(0);
  });

  it('runs again once the previous run has settled', async () => {
    const inFlight = new Map<string, InFlightRun<string>>();
    let runs = 0;
    const run = async () => `result-${(runs += 1)}`;

    expect(await singleFlight(inFlight, 'msg-1', 'fp', run)).toBe('result-1');
    expect(await singleFlight(inFlight, 'msg-1', 'fp', run)).toBe('result-2');
    expect(inFlight.size).toBe(0);
  });

  it('never starts two runs for one key even when callers arrive back-to-back', async () => {
    const inFlight = new Map<string, InFlightRun<number>>();
    let runs = 0;
    const run = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 5));
      return runs;
    };

    const results = await Promise.all(
      Array.from({ length: 25 }, () => singleFlight(inFlight, 'msg-1', 'fp', run))
    );

    expect(runs).toBe(1);
    expect(new Set(results).size).toBe(1);
  });
});
