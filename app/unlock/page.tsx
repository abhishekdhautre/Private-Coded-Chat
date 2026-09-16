"use client";
import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useCrypto } from "@/contexts/CryptoContext";
import { db } from "@/lib/firebase";
import { decrypt, deriveKey } from "@/lib/crypto";
import { get, ref } from "firebase/database";

function UnlockInner() {
  const router = useRouter(); const params = useSearchParams(); const roomId = params.get("roomId") || "";
  const { key, unlock } = useCrypto(); const [passphrase,setPassphrase]=useState(""); const [keyword,setKeyword]=useState(""); const [error,setError]=useState(""); const [busy,setBusy]=useState(false);
  useEffect(()=>{ if(key && roomId) router.replace(`/chat/${encodeURIComponent(roomId)}`); },[key,roomId,router]);
  async function submit(e: FormEvent){e.preventDefault(); if(!roomId){setError("Missing room ID.");return;} setBusy(true);setError("");try{const snapshot=await get(ref(db,`rooms/${roomId}/meta/keyCheck`));const keyCheck=snapshot.val() as {ciphertext?:string;iv?:string}|null;if(!keyCheck?.ciphertext||!keyCheck.iv)throw new Error("Room verifier is missing");const derivedKey=await deriveKey(passphrase,roomId);await decrypt(keyCheck.ciphertext,keyCheck.iv,derivedKey);unlock(derivedKey,keyword);router.replace(`/chat/${encodeURIComponent(roomId)}`);}catch{setError("Incorrect encryption passphrase.");}finally{setBusy(false)}}
  return <main className="grid min-h-screen place-items-center p-6"><form onSubmit={submit} className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[.04] p-8">
    <div className="mb-6 text-4xl">🔒</div><h1 className="text-3xl font-semibold">Unlock room</h1><p className="mt-2 text-sm text-slate-400">The passphrase and display keyword stay in memory only. They are never sent to Firebase.</p>
    <label className="mt-6 mb-3 block text-sm">Shared encryption passphrase<input autoFocus type="password" required value={passphrase} onChange={e=>setPassphrase(e.target.value)} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-cyan-400" /></label>
    <label className="mb-3 block text-sm">Shared display keyword<input type="password" required value={keyword} onChange={e=>setKeyword(e.target.value)} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-cyan-400" /></label>
    <p className="text-xs text-slate-500">Room: {roomId || "not specified"}</p>{error&&<p className="my-3 text-sm text-red-300">{error}</p>}<button disabled={busy} className="mt-4 w-full rounded-xl bg-cyan-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50">{busy?"Deriving key…":"Unlock"}</button>
  </form></main>;
}
export default function UnlockPage(){return <AuthGuard><UnlockInner/></AuthGuard>}
