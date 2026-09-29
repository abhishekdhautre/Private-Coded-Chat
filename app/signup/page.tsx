"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { AuthShell, AuthError, Field, PasswordVisibilityToggle } from "@/components/auth/AuthShell";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Firebase Auth treats emails case-insensitively, so "A@x.com" and "a@x.com"
  // are the SAME account. Normalizing before the call means one canonical
  // spelling is used for the duplicate check, and the address the user retypes
  // can no longer dodge it by changing case or adding whitespace.
  function normalizeEmail(raw: string): string {
    return raw.trim().toLowerCase();
  }

  function getErrorMessage(err: unknown): string {
    if (typeof err === "object" && err !== null && "code" in err) {
      const code = (err as { code?: string }).code;
      if (code === "auth/email-already-in-use") return "An account with this email already exists.";
      if (code === "auth/invalid-email") return "Please enter a valid email address.";
      if (code === "auth/weak-password") return "Password should be at least 6 characters long.";
      if (code === "auth/operation-not-allowed") {
        return "Email/password sign-up is currently disabled. Contact support.";
      }
      if (code === "auth/network-request-failed") {
        return "Network error. Please check your internet connection.";
      }
      if (code === "auth/too-many-requests") {
        return "Too many attempts. Please wait a moment and try again.";
      }
    }
    return "Account creation failed. Please try again.";
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");

    // Authoritative uniqueness source is Firebase Authentication itself:
    // createUserWithEmailAndPassword is the ONLY check performed here. There is
    // deliberately no /users/{uid} or RTDB pre-check — deleting an application
    // profile does not delete the auth account, and querying app data would
    // produce a false "already exists" for an email that is genuinely free.
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters long.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      await createUserWithEmailAndPassword(auth, normalizedEmail, password);
      router.replace("/profile-setup");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Private by design"
      title="Create your account"
      subtitle="Join Private Coded Chat for end-to-end encrypted messaging."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="setup-link">
            Sign in
          </Link>
        </>
      }
    >
      <form className="setup-form" onSubmit={submit} noValidate>
        <Field
          id="signup-email"
          label="Email"
          type="email"
          value={email}
          // Clear any stale error as soon as the field is edited — otherwise a
          // resolved "already exists" message lingers next to a new address.
          onChange={(v) => {
            setEmail(v);
            if (error) setError("");
          }}
          placeholder="you@example.com"
          autoComplete="email"
          required
        />
        <Field
          id="signup-password"
          label="Password"
          type={showPassword ? "text" : "password"}
          value={password}
          onChange={setPassword}
          placeholder="Min. 6 characters"
          autoComplete="new-password"
          required
          hint="At least 6 characters. This protects your account — it is not the chat encryption passphrase."
          trailing={
            <PasswordVisibilityToggle
              visible={showPassword}
              onToggle={() => setShowPassword((v) => !v)}
              inputId="signup-password"
            />
          }
        />
        <Field
          id="signup-confirm"
          label="Confirm password"
          type={showPassword ? "text" : "password"}
          value={confirmPassword}
          onChange={setConfirmPassword}
          placeholder="Re-enter password"
          autoComplete="new-password"
          required
        />

        <AuthError message={error} />

        <button type="submit" className="setup-btn" disabled={busy} aria-busy={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthShell>
  );
}
