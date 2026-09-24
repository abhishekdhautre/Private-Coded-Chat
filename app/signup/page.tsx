"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function getErrorMessage(err: unknown): string {
    if (typeof err === "object" && err !== null && "code" in err) {
      const code = (err as { code?: string }).code;
      if (code === "auth/email-already-in-use") {
        return "An account with this email already exists.";
      }
      if (code === "auth/invalid-email") {
        return "Please enter a valid email address.";
      }
      if (code === "auth/weak-password") {
        return "Password should be at least 6 characters long.";
      }
      if (code === "auth/network-request-failed") {
        return "Network error. Please check your internet connection.";
      }
    }
    return "Account creation failed. Please try again.";
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
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
      await createUserWithEmailAndPassword(auth, trimmedEmail, password);
      router.replace("/profile-setup");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center p-4 sm:p-6">
      <form onSubmit={submit} className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[.04] p-6 sm:p-8 shadow-2xl backdrop-blur-xl">
        <p className="text-xs uppercase tracking-[.25em] text-cyan-300 font-semibold">Private Coded Chat</p>
        <h1 className="mt-2 text-2xl sm:text-3xl font-semibold text-slate-100">Create account</h1>
        <p className="mt-2 mb-6 text-sm text-slate-400">Join Private Coded Chat for zero-knowledge E2EE messaging.</p>

        <label className="mb-4 block text-sm font-medium text-slate-300">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-cyan-400 text-slate-100 placeholder-slate-500"
          />
        </label>

        <label className="mb-4 block text-sm font-medium text-slate-300">
          Password
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Min. 6 characters"
            className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-cyan-400 text-slate-100 placeholder-slate-500"
          />
        </label>

        <label className="mb-4 block text-sm font-medium text-slate-300">
          Confirm password
          <input
            type="password"
            required
            minLength={6}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Re-enter password"
            className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-cyan-400 text-slate-100 placeholder-slate-500"
          />
        </label>

        {error && <p className="my-3 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-3 w-full rounded-xl bg-cyan-400 px-4 py-3 font-semibold text-slate-950 hover:bg-cyan-300 active:bg-cyan-500 disabled:opacity-50 transition-all cursor-pointer"
        >
          {busy ? "Creating account…" : "Create account"}
        </button>

        <div className="mt-6 text-center text-sm text-slate-400">
          Already have an account?{" "}
          <Link href="/login" className="text-cyan-400 font-medium hover:underline">
            Sign in
          </Link>
        </div>
      </form>
    </main>
  );
}
