"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) { e.preventDefault(); setBusy(true); setError(""); try { await signInWithEmailAndPassword(auth, email, password); router.replace("/"); } catch { setError("Invalid email or password."); } finally { setBusy(false); } }
  return <main className="grid min-h-screen place-items-center p-6"><form onSubmit={submit} className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[.04] p-8">
    <p className="text-xs uppercase tracking-[.25em] text-cyan-300">Private Coded Chat</p><h1 className="mt-2 text-3xl font-semibold">Sign in</h1><p className="mt-2 mb-6 text-sm text-slate-400">Your Firebase login password is not the chat encryption passphrase.</p>
    <label className="mb-2 block text-sm">Email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-cyan-400" /></label>
    <label className="mb-2 block text-sm">Login password<input type="password" required value={password} onChange={e=>setPassword(e.target.value)} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-cyan-400" /></label>
    {error && <p className="my-3 text-sm text-red-300">{error}</p>}<button disabled={busy} className="mt-3 w-full rounded-xl bg-cyan-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50">{busy?"Signing in…":"Sign in"}</button>
  </form></main>;
}
