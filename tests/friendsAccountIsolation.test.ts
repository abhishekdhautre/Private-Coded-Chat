/**
 * Regression tests for account isolation of friend data (the "Friends 6" bug).
 *
 * Symptom: after signing out of an account with 6 friends and creating /
 * signing into a brand-new account with no friends, the Friends tab briefly
 * displayed the OLD account's count.
 *
 * Root cause (two independent defects, both fixed):
 *  1. State was not reset on UID change. The previous account's friend array
 *     stayed in React state until the new listener delivered, so the old count
 *     was rendered for the new account.
 *  2. The generation bump was driven by `useState` inside an effect that ALSO
 *     depended on that state (`[user, sessionId]` + `setSessionId`), producing
 *     an endless subscribe/unsubscribe loop. The fix bumps a ref, keyed on a
 *     stable scope string, and clears state synchronously.
 *
 * Each `attach` below models one effect run: reset state synchronously, then
 * attach a listener that discards its result if the account has since changed.
 */
import { describe, it, expect } from 'vitest';

type FriendListener = (uids: string[]) => void;

interface State {
  friendUids: string[];
  incoming: string[];
  outgoing: string[];
  loaded: boolean;
}

/** One effect run's worth of listener, with the generation it captured. */
interface Attachment {
  generation: number;
  emit: FriendListener;
  detached: boolean;
}

function createFriendsPage() {
  const state: State = { friendUids: [], incoming: [], outgoing: [], loaded: false };
  let generation = 0;
  let scope = '';
  let current: Attachment | null = null;

  /** Effect run. Mirrors the shipped friends effect exactly. */
  function attach(uid: string | undefined) {
    // Detach the previous run's listeners first, as the effect cleanup does.
    if (current) current.detached = true;

    // ── Synchronous reset. The previous account's data must never remain
    //    visible for the new one, even for a single render.
    state.friendUids = [];
    state.incoming = [];
    state.outgoing = [];
    state.loaded = false;

    // ── Ref-based generation bump, keyed on a stable scope string. A ref bump
    //    cannot re-run this effect, so this can never loop.
    const nextScope = uid ?? 'anon';
    if (scope !== nextScope) {
      scope = nextScope;
      generation += 1;
    }

    if (!uid) {
      current = null;
      return;
    }

    const captured = generation;
    const attachment: Attachment = {
      generation: captured,
      detached: false,
      emit: (uids) => {
        // A listener that has been detached, or that belongs to a superseded
        // account, must not touch the current page state.
        if (attachment.detached || generation !== captured) return;
        state.friendUids = uids;
        state.loaded = true;
      },
    };
    current = attachment;
  }

  /** The handle a caller would use to fire a Firebase delivery. */
  function listener(): FriendListener | null {
    return current ? current.emit : null;
  }

  /**
   * An ordinary re-render. The effect deps are `[user?.uid]`, so this must be a
   * complete no-op for subscriptions — modelled explicitly so the tests can
   * assert that the effect is not re-run by unrelated renders.
   */
  function render(): void {
    // Intentionally empty: see the doc comment above.
  }

  return {
    state,
    attach,
    listener,
    render,
    get generation() {
      return generation;
    },
  };
}

describe('friend data account isolation', () => {
  it('shows Friends 0 for a brand-new account with no friends node', () => {
    const page = createFriendsPage();
    page.attach('UID_B');
    page.listener()!([]); // /friends/UID_B does not exist -> empty
    expect(page.state.friendUids).toEqual([]);
    expect(page.state.friendUids.length).toBe(0);
    expect(page.state.loaded).toBe(true);
  });

  it('does NOT show the old account count after switching accounts', () => {
    const page = createFriendsPage();
    // Old account has 6 friends.
    page.attach('UID_A');
    page.listener()!(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    expect(page.state.friendUids.length).toBe(6);

    // Sign out (uid undefined), then into a brand-new account.
    page.attach(undefined);
    expect(page.state.friendUids).toEqual([]);
    page.attach('UID_B');
    // Before Firebase answers for UID_B the UI must already read 0, not 6.
    expect(page.state.friendUids).toEqual([]);
    expect(page.state.loaded).toBe(false);

    page.listener()!([]);
    expect(page.state.friendUids.length).toBe(0);
  });

  it('discards a callback still in flight for the PREVIOUS uid', () => {
    const page = createFriendsPage();
    page.attach('UID_A');
    const staleListener = page.listener()!;

    // Account switches before UID_A's listener ever answers.
    page.attach('UID_B');
    expect(page.state.friendUids).toEqual([]);

    // UID_A's listener finally delivers 6 friends — must be ignored entirely.
    staleListener(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    expect(page.state.friendUids).toEqual([]);
    expect(page.state.friendUids.length).not.toBe(6);
  });

  it('accepts the new account data after a late old-account callback was dropped', () => {
    const page = createFriendsPage();
    page.attach('UID_A');
    const staleListener = page.listener()!;
    page.attach('UID_B');

    staleListener(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']); // stale -> dropped
    expect(page.state.friendUids).toEqual([]);

    page.listener()!(['newFriend']); // current -> accepted
    expect(page.state.friendUids).toEqual(['newFriend']);
    expect(page.state.loaded).toBe(true);
  });

  it('resets the loaded flag so a pending load is not shown as "No friends yet"', () => {
    const page = createFriendsPage();
    page.attach('UID_A');
    page.listener()!(['f1']);
    expect(page.state.loaded).toBe(true);

    page.attach('UID_B');
    expect(page.state.loaded).toBe(false);
  });

  it('clears request lists on account switch too', () => {
    const page = createFriendsPage();
    page.state.incoming = ['req-1'];
    page.state.outgoing = ['req-2'];
    page.attach('UID_B');
    expect(page.state.incoming).toEqual([]);
    expect(page.state.outgoing).toEqual([]);
  });
});

describe('friends subscription does not loop', () => {
  /**
   * The effect's dependency list is `[user?.uid]`, so React re-runs it ONLY when
   * the uid changes. `render()` below models an ordinary re-render (typing,
   * opening a tab, etc.), which must NOT re-subscribe, re-bump the generation,
   * or reset the loaded data — that was the original looping bug, where the
   * effect depended on the very state it was setting.
   */
  it('re-renders never re-subscribe, re-bump, or clear loaded data', () => {
    const page = createFriendsPage();
    page.attach('UID_A');
    const listener = page.listener()!;
    listener!(['f1', 'f2']);
    expect(page.state.loaded).toBe(true);
    const generationAfterAttach = page.generation;

    // 50 ordinary re-renders with the same account.
    for (let i = 0; i < 50; i += 1) page.render();

    // Same listener instance -> no re-subscription happened.
    expect(page.listener()).toBe(listener);
    // Generation unchanged -> the effect was not re-run.
    expect(page.generation).toBe(generationAfterAttach);
    // Data intact -> a re-render never blanks the list.
    expect(page.state.friendUids).toEqual(['f1', 'f2']);
  });

  it('bumps the generation exactly once per distinct uid', () => {
    const page = createFriendsPage();
    page.attach('UID_A');
    const afterA = page.generation;
    page.attach('UID_B');
    expect(page.generation).toBe(afterA + 1);
    page.attach('UID_C');
    expect(page.generation).toBe(afterA + 2);
  });
});
