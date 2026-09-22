"use client";
import { useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { setOnline, setOffline } from "@/lib/userService";

export function PresenceGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    const uid = user.uid;
    setOnline(uid);

    const onVis = () => {
      if (document.visibilityState === "hidden") setOffline(uid);
      else setOnline(uid);
    };
    const onUnload = () => setOffline(uid);

    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      setOffline(uid);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [user]);

  return <>{children}</>;
}
