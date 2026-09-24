"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { AuthShell, AuthError, Field, PasswordVisibilityToggle } from "@/components/auth/AuthShell";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function getErrorMessage(err: unknown): string {
    if (typeof err === "object" && err !== null && "code" in err) {
      const code = (err as { code?: string }).code;
      if (code === "auth/user-not-found" || code === "auth/wrong-password" || code === "auth/invalid-credential") {
        return "Invalid email or password.";
      }
      if (code === "auth/invalid-email") return "Please enter a valid email address.";
      if (code === "auth/network-request-failed") {
        return "Network error. Please check your internet connection.";
      }
      if (code === "auth/too-many-requests") return "Too many attempts. Please wait and try again.";
    }
    return "Invalid email or password.";
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await signInWithEmailAndPassword(auth, email, password);
      router.replace("/");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Private by design"
      title="Welcome back"
      subtitle="Your conversations are end-to-end encrypted on this device."
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="setup-link">
            Create one
          </Link>
        </>
      }
    >
      <form className="setup-form" onSubmit={submit} noValidate>
        <Field
          id="login-email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          autoComplete="email"
          required
        />
        <Field
          id="login-password"
          label="Password"
          type={showPassword ? "text" : "password"}
          value={password}
          onChange={setPassword}
          placeholder="Your account password"
          autoComplete="current-password"
          required
          trailing={
            <PasswordVisibilityToggle
              visible={showPassword}
              onToggle={() => setShowPassword((v) => !v)}
              inputId="login-password"
            />
          }
        />

        <AuthError message={error} />

        <button type="submit" className="setup-btn" disabled={busy} aria-busy={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="setup-hint setup-hint-center">
          Your account password is not the chat encryption passphrase.
        </p>
      </form>
    </AuthShell>
  );
}
