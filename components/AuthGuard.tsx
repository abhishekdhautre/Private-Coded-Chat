"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth(); const router = useRouter();
  useEffect(() => { if (!loading && !user) router.replace("/login"); }, [loading, user, router]);
  if (loading || !user) return <main className="grid min-h-screen place-items-center text-slate-400">Checking session…</main>;
  return <>{children}</>;
}
