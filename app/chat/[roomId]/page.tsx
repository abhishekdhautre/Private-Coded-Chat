"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { onValue, push, ref, remove } from "firebase/database";
import { AuthGuard } from "@/components/AuthGuard";
import { useAuth } from "@/contexts/AuthContext";
import { useCrypto } from "@/contexts/CryptoContext";
import { db } from "@/lib/firebase";
import { decrypt, encrypt } from "@/lib/crypto";
import { encodeText } from "@/lib/cipher";
import type { DecryptedMessage, StoredMessage } from "@/types/chat";

function ChatInner(){
  const params=useParams<{roomId:string}>(); const roomId=decodeURIComponent(params.roomId); const router=useRouter(); const {user}=useAuth(); const {key,keyword,lock}=useCrypto();
  const [messages,setMessages]=useState<DecryptedMessage[]>([]); const [input,setInput]=useState(""); const [revealed,setRevealed]=useState(false); const [blurred,setBlurred]=useState(false); const [error,setError]=useState(""); const bottom=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!key){setMessages([]);router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`)}},[key,router,roomId]);
  useEffect(()=>{ if(!key||!user)return; const messagesRef=ref(db,`rooms/${roomId}/messages`); return onValue(messagesRef,async snapshot=>{const rows=snapshot.val() as Record<string,StoredMessage>|null;if(!rows){setMessages([]);return;}const now=Date.now();const next:DecryptedMessage[]=[];for(const [id,row] of Object.entries(rows)){if(row.expiresAt&&row.expiresAt<=now){remove(ref(db,`rooms/${roomId}/messages/${id}`)).catch(()=>{});continue;}try{const plaintext=await decrypt(row.ciphertext,row.iv,key);next.push({...row,id,plaintext});}catch{next.push({...row,id,plaintext:"Unable to decrypt message."});}}next.sort((a,b)=>a.timestamp-b.timestamp);setMessages(next);});},[key,user,roomId]);
  useEffect(()=>{bottom.current?.scrollIntoView({behavior:"smooth"})},[messages.length]);
  useEffect(()=>{const onBlur=()=>setBlurred(true),onFocus=()=>setBlurred(false),onVis=()=>{if(document.visibilityState==="hidden")lock()};window.addEventListener("blur",onBlur);window.addEventListener("focus",onFocus);document.addEventListener("visibilitychange",onVis);return()=>{window.removeEventListener("blur",onBlur);window.removeEventListener("focus",onFocus);document.removeEventListener("visibilitychange",onVis)}},[lock]);
  const visible=useMemo(()=>messages.map(m=>({...m,display:revealed?m.plaintext:encodeText(m.plaintext,keyword)})),[messages,revealed,keyword]);
  async function send(e:FormEvent){e.preventDefault();if(!input.trim()||!key||!user)return;setError("");try{const payload=await encrypt(input.trim(),key);await push(ref(db,`rooms/${roomId}/messages`),{...payload,senderId:user.uid,timestamp:Date.now()});setInput("");}catch{setError("Message could not be encrypted/sent.")}}
  if(!key)return null;
  return <main className="flex min-h-screen flex-col bg-[#05070b]"><header className="flex items-center justify-between border-b border-white/10 px-4 py-4 md:px-8"><div><div className="flex items-center gap-2"><span className="text-lg">🔐</span><span className="font-semibold">Private room</span></div><p className="text-xs text-slate-500">End-to-end encrypted · {roomId}</p></div><div className="flex items-center gap-2"><button onClick={()=>setRevealed(v=>!v)} className="rounded-lg border border-white/10 px-3 py-2 text-sm">{revealed?"Revealed":"Coded"}</button><button onClick={()=>{lock();router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`)}} className="rounded-lg border border-white/10 px-3 py-2 text-sm">Lock</button></div></header>
  <section className={`flex-1 overflow-y-auto p-4 transition duration-100 md:p-8 ${blurred?"blur-xl select-none": ""}`} aria-label="Message list"> <div className="mx-auto flex max-w-3xl flex-col gap-3">{visible.map(m=><div key={m.id} className={`max-w-[85%] rounded-2xl border border-white/10 px-4 py-3 ${m.senderId===user?.uid?"ml-auto bg-cyan-400/10":"bg-white/[.04]"}`}><p className="whitespace-pre-wrap break-words text-sm leading-6">{m.display}</p><p className="mt-1 text-[10px] text-slate-500">{new Date(m.timestamp).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</p></div>)}<div ref={bottom}/></div></section>
  <form onSubmit={send} className="border-t border-white/10 p-4 md:px-8"><div className="mx-auto flex max-w-3xl gap-2"><textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void send(e)}}} rows={1} placeholder="Write a message…" className="min-h-12 flex-1 resize-none rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-cyan-400"/><button className="rounded-xl bg-cyan-400 px-5 font-semibold text-slate-950">Send</button></div>{error&&<p className="mx-auto mt-2 max-w-3xl text-xs text-red-300">{error}</p>}</form></main>
}
export default function ChatPage(){return <AuthGuard><ChatInner/></AuthGuard>}
