"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";

export default function Home() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [roomId, setRoomId] = useState("");

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) return <main className="grid min-h-screen place-items-center text-slate-400">Loading…</main>;

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <section className="w-full max-w-lg rounded-3xl border border-white/10 bg-white/[.04] p-8 shadow-2xl">
        <div className="mb-8">
          <p className="mb-2 text-xs uppercase tracking-[.25em] text-cyan-300">Private Coded Chat</p>
          <h1 className="text-3xl font-semibold">Choose a room</h1>
          <p className="mt-2 text-sm text-slate-400">Only the two Firebase UIDs listed in a room’s metadata can access its messages.</p>
        </div>
        <input
          value={roomId}
          onChange={(e) => setRoomId(e.target.value.trim())}
          placeholder="Room ID"
          className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-cyan-400"
        />
        <button
          onClick={() => roomId && router.push(`/chat/${encodeURIComponent(roomId)}`)}
          disabled={!roomId}
          className="mt-3 w-full rounded-xl bg-cyan-400 px-4 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Open room
        </button>
        <button onClick={() => router.push("/setup")} className="mt-3 w-full rounded-xl border border-white/10 px-4 py-3 text-sm hover:bg-white/5">Room setup</button>
      </section>
    </main>
  );
}
