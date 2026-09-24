"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";

export default function Home() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace("/login"); return; }
    router.replace("/home");
  }, [loading, user, router]);

  return (
    <main className="setup-page">
      <p className="loading-text">Loading…</p>
    </main>
  );
}
