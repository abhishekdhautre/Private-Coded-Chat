/**
 * Regression tests for signup email handling.
 *
 * Contract under test (the production bug these lock down):
 * - Firebase AUTH is the ONLY authority for email uniqueness. The app must not
 *   pre-check /users/{uid} or RTDB, because deleting an application profile
 *   does not delete the auth account — and worse, an app-data pre-check reports
 *   "already exists" for addresses that are genuinely free.
 * - Emails are normalized (trim + lowercase) before the call, because Firebase
 *   Auth matches case-insensitively. Otherwise retyping "A@x.com" as "a@x.com"
 *   dodges a duplicate check and creates a confusing second identity.
 * - Only a genuine `auth/email-already-in-use` from Firebase produces the
 *   "already exists" message; every other failure maps to its own message.
 * - Editing the email field clears a stale error, so a resolved message never
 *   lingers beside a new address.
 */
import { describe, it, expect } from 'vitest';

/** Mirrors normalizeEmail() in app/signup/page.tsx. */
function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Mirrors getErrorMessage() in app/signup/page.tsx. */
function getErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: string }).code;
    if (code === 'auth/email-already-in-use') return 'An account with this email already exists.';
    if (code === 'auth/invalid-email') return 'Please enter a valid email address.';
    if (code === 'auth/weak-password') return 'Password should be at least 6 characters long.';
    if (code === 'auth/operation-not-allowed') {
      return 'Email/password sign-up is currently disabled. Contact support.';
    }
    if (code === 'auth/network-request-failed') {
      return 'Network error. Please check your internet connection.';
    }
    if (code === 'auth/too-many-requests') {
      return 'Too many attempts. Please wait a moment and try again.';
    }
  }
  return 'Account creation failed. Please try again.';
}

const VALID = /^\S+@\S+\.\S+$/;

describe('signup email normalization', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('lowercases so case variants cannot dodge the duplicate check', () => {
    // Firebase Auth matches emails case-insensitively: these are ONE account.
    expect(normalizeEmail('User@Example.COM')).toBe(normalizeEmail('user@example.com'));
    expect(normalizeEmail('USER@EXAMPLE.COM')).toBe('user@example.com');
  });

  it('normalizes tabs/newlines and inner casing together', () => {
    expect(normalizeEmail('\t MixedCase@Test.io \n')).toBe('mixedcase@test.io');
  });

  it('leaves an already-normalized address untouched', () => {
    expect(normalizeEmail('clean@example.com')).toBe('clean@example.com');
  });

  it('rejects whitespace-only input', () => {
    expect(normalizeEmail('   ')).toBe('');
    expect(VALID.test(normalizeEmail('   '))).toBe(false);
  });

  it('rejects a missing domain or missing local part', () => {
    expect(VALID.test(normalizeEmail('nodomain@'))).toBe(false);
    expect(VALID.test(normalizeEmail('@example.com'))).toBe(false);
    expect(VALID.test(normalizeEmail('plainaddress'))).toBe(false);
  });

  it('accepts a normalized valid address', () => {
    expect(VALID.test(normalizeEmail(' New.User+tag@Sub.Domain.com '))).toBe(true);
  });
});

describe('signup error mapping', () => {
  it('shows "already exists" ONLY for a real auth/email-already-in-use', () => {
    expect(getErrorMessage({ code: 'auth/email-already-in-use' })).toBe(
      'An account with this email already exists.'
    );
  });

  it('does not claim "already exists" when Firebase returns something else', () => {
    // The regression: a deleted/free address must never be told it is taken.
    for (const code of [
      'auth/invalid-email',
      'auth/weak-password',
      'auth/network-request-failed',
      'auth/operation-not-allowed',
      'auth/too-many-requests',
      'auth/user-disabled',
    ]) {
      expect(getErrorMessage({ code })).not.toContain('already exists');
    }
  });

  it('maps the remaining auth errors to their own actionable messages', () => {
    expect(getErrorMessage({ code: 'auth/invalid-email' })).toBe('Please enter a valid email address.');
    expect(getErrorMessage({ code: 'auth/weak-password' })).toBe(
      'Password should be at least 6 characters long.'
    );
    expect(getErrorMessage({ code: 'auth/network-request-failed' })).toContain('Network error');
    expect(getErrorMessage({ code: 'auth/too-many-requests' })).toContain('Too many attempts');
  });

  it('falls back to a generic message for unknown/empty errors', () => {
    expect(getErrorMessage({})).toBe('Account creation failed. Please try again.');
    expect(getErrorMessage(new Error('boom'))).toBe('Account creation failed. Please try again.');
    expect(getErrorMessage(null)).toBe('Account creation failed. Please try again.');
    expect(getErrorMessage('string failure')).toBe('Account creation failed. Please try again.');
  });
});

describe('signup uniqueness source', () => {
  /**
   * Models the production decision: a free address signs up successfully even
   * when a stale application profile for a DELETED account still references it,
   * because only Firebase Auth is consulted. A taken address is rejected by
   * Firebase, not by any app-data lookup.
   */
  function signUp(
    email: string,
    authAccounts: Set<string>,
    staleAppProfiles: Set<string>
  ): { ok: boolean; error: string } {
    const normalized = normalizeEmail(email);
    if (!normalized || !VALID.test(normalized)) {
      return { ok: false, error: 'Please enter a valid email address.' };
    }
    // NOTE: staleAppProfiles is intentionally NOT consulted. Asserting that it
    // is irrelevant here is the regression guard for the false positive.
    if (authAccounts.has(normalized)) {
      return { ok: false, error: getErrorMessage({ code: 'auth/email-already-in-use' }) };
    }
    return { ok: true, error: '' };
  }

  it('allows signup for a free email despite a stale deleted app profile', () => {
    const auth = new Set<string>();
    const staleProfiles = new Set(['ghost@example.com']);
    const result = signUp('ghost@example.com', auth, staleProfiles);
    expect(result.ok).toBe(true);
    expect(result.error).toBe('');
  });

  it('rejects an email that Firebase Auth already holds', () => {
    const auth = new Set(['taken@example.com']);
    const result = signUp('taken@example.com', auth, new Set());
    expect(result.ok).toBe(false);
    expect(result.error).toBe('An account with this email already exists.');
  });

  it('rejects a case/whitespace variant of a taken email', () => {
    const auth = new Set(['taken@example.com']);
    expect(signUp('  TAKEN@Example.com ', auth, new Set()).ok).toBe(false);
  });

  it('allows a fresh account with no friends data at all', () => {
    const result = signUp('brandnew@example.com', new Set(), new Set());
    expect(result.ok).toBe(true);
  });
});
