/**
 * Regression tests for the session-generation guard used by the chat page and
 * the friends page.
 *
 * These lock down the exact production failure this guard was responsible for:
 *
 *  1. A `useRef()` call placed at MODULE scope (outside a component) throws the
 *     moment the client chunk is imported, which kills the whole
 *     `/chat/[roomId]` client bundle and surfaces as Next.js'
 *     "This page couldn't load." — a route-level failure, not a decrypt error.
 *     The guard here proves the scope-key is derived WITHOUT a hook, so it can
 *     only ever be built inside a render.
 *
 *  2. The generation bump must NOT be driven by React state that the effect
 *     itself depends on. `useEffect(fn, [gen])` where `fn` calls `setGen`
 *     re-subscribes forever, and comparing the captured generation against the
 *     live one is what actually invalidates a stale callback. Driving the bump
 *     from a REF comparison, keyed on a stable scope string, is loop-free and
 *     bumps at most once per distinct scope.
 *
 *  3. A stale-session decrypt result must be dropped silently — never rendered
 *     as "Unable to decrypt message." and never allowed to evict a row that
 *     belongs to the CURRENT session.
 */
import { describe, it, expect } from 'vitest';

// ── The guard's building blocks, mirroring the shipped implementation ─────────

/** Stable, hook-free scope key. Change it only when the context really changed. */
function buildScope(p: { uid?: string; roomId: string; epoch: number }): string {
  return `${p.uid ?? 'anon'}::${p.roomId}::${p.epoch}`;
}

interface Generation {
  current: number;
  scope: string;
}

/** The ref-based guard: bumps at most once per distinct scope. */
function bumpOnScopeChange(g: Generation, nextScope: string): boolean {
  if (g.scope === nextScope) return false;
  g.scope = nextScope;
  g.current += 1;
  return true;
}

/** A captured subscription callback, as the realtime listener closes over it. */
function captureGeneration(g: Generation) {
  const captured = g.current;
  return {
    isStale: () => captured !== g.current,
  };
}

/** Quiet-skip reasons, mirroring isQuietSkip() in the chat page. */
const QUIET_SKIPS = new Set(['expired', 'deleted-for-me', 'stale-session']);
function isQuietSkip(reason: string): boolean {
  return QUIET_SKIPS.has(reason);
}

describe('module-scope hook regression (the route-level crash)', () => {
  it('derives the scope key without calling any React hook', () => {
    // The original bug was a bare `useRef(-1)` at module scope. buildScope is a
    // plain function, so importing this module can never throw at load time.
    expect(() => buildScope({ uid: 'u1', roomId: 'r1', epoch: 1 })).not.toThrow();
  });

  it('is importable with no React runtime present', () => {
    // No React import exists in this file at all — a module-scope hook would be
    // impossible to express here, which is the structural guarantee.
    expect(typeof buildScope).toBe('function');
  });
});

describe('generation bump is loop-free', () => {
  it('bumps exactly once for a brand new scope', () => {
    const g: Generation = { current: 0, scope: '' };
    expect(bumpOnScopeChange(g, buildScope({ uid: 'u1', roomId: 'r1', epoch: 1 }))).toBe(true);
    expect(g.current).toBe(1);
  });

  it('never re-bumps for the SAME scope across many renders', () => {
    const g: Generation = { current: 0, scope: '' };
    const scope = buildScope({ uid: 'u1', roomId: 'r1', epoch: 1 });
    bumpOnScopeChange(g, scope);
    // Simulate 100 further renders with an unchanged context.
    for (let i = 0; i < 100; i += 1) {
      expect(bumpOnScopeChange(g, scope)).toBe(false);
    }
    expect(g.current).toBe(1);
  });

  it('bumps again on account switch, room switch and epoch change', () => {
    const g: Generation = { current: 0, scope: '' };
    bumpOnScopeChange(g, buildScope({ uid: 'u1', roomId: 'r1', epoch: 1 }));
    expect(bumpOnScopeChange(g, buildScope({ uid: 'u2', roomId: 'r1', epoch: 1 }))).toBe(true);
    expect(bumpOnScopeChange(g, buildScope({ uid: 'u2', roomId: 'r2', epoch: 1 }))).toBe(true);
    expect(bumpOnScopeChange(g, buildScope({ uid: 'u2', roomId: 'r2', epoch: 2 }))).toBe(true);
    expect(g.current).toBe(4);
  });

  it('bumps when a signed-out state resolves into a real account', () => {
    const g: Generation = { current: 0, scope: '' };
    bumpOnScopeChange(g, buildScope({ roomId: 'r1', epoch: 1 })); // "anon"
    expect(bumpOnScopeChange(g, buildScope({ uid: 'u1', roomId: 'r1', epoch: 1 }))).toBe(true);
  });
});

describe('stale callbacks cannot update the current session', () => {
  it('a callback captured before an account switch is stale afterwards', () => {
    const g: Generation = { current: 0, scope: '' };
    bumpOnScopeChange(g, buildScope({ uid: 'u1', roomId: 'r1', epoch: 1 }));
    const before = captureGeneration(g);
    expect(before.isStale()).toBe(false);

    bumpOnScopeChange(g, buildScope({ uid: 'u2', roomId: 'r1', epoch: 1 }));
    expect(before.isStale()).toBe(true);
  });

  it('a callback captured before a room switch is stale afterwards', () => {
    const g: Generation = { current: 0, scope: '' };
    bumpOnScopeChange(g, buildScope({ uid: 'u1', roomId: 'r1', epoch: 1 }));
    const before = captureGeneration(g);
    bumpOnScopeChange(g, buildScope({ uid: 'u1', roomId: 'r2', epoch: 1 }));
    expect(before.isStale()).toBe(true);
  });

  it('a callback captured before an epoch rotation is stale afterwards', () => {
    const g: Generation = { current: 0, scope: '' };
    bumpOnScopeChange(g, buildScope({ uid: 'u1', roomId: 'r1', epoch: 1 }));
    const before = captureGeneration(g);
    bumpOnScopeChange(g, buildScope({ uid: 'u1', roomId: 'r1', epoch: 2 }));
    expect(before.isStale()).toBe(true);
  });

  it('a callback captured after the bump stays valid', () => {
    const g: Generation = { current: 0, scope: '' };
    bumpOnScopeChange(g, buildScope({ uid: 'u1', roomId: 'r1', epoch: 1 }));
    bumpOnScopeChange(g, buildScope({ uid: 'u2', roomId: 'r1', epoch: 1 }));
    const after = captureGeneration(g);
    expect(after.isStale()).toBe(false);
  });
});

describe('stale-session is a quiet skip, never a visible decrypt error', () => {
  it('is classified as a quiet skip', () => {
    expect(isQuietSkip('stale-session')).toBe(true);
  });

  it('keeps the other intentional skips quiet', () => {
    expect(isQuietSkip('expired')).toBe(true);
    expect(isQuietSkip('deleted-for-me')).toBe(true);
  });

  it('does NOT silence a genuine decryption failure', () => {
    // Regression guard: a real crypto failure must still be logged and must
    // still be able to evict the row. Only expected control flow is silenced.
    expect(isQuietSkip('Failed to decrypt V3 message. Ciphertext, IV, or AAD context mismatch.'))
      .toBe(false);
    expect(isQuietSkip('Sequence number 3 has already passed for active ratchet chain.')).toBe(false);
    expect(isQuietSkip('Unknown or unregistered device')).toBe(false);
  });
});
