"use client";
import { useEffect } from "react";
import { ref, onValue, onDisconnect, serverTimestamp, update, off } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";

export function PresenceGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    const uid = user.uid;
    const connRef = ref(db, ".info/connected");
    const userRef = ref(db, `users/${uid}`);

    const handler = (snap: { val(): unknown }) => {
      if (!snap.val()) return;
      // On disconnect: mark offline with last seen timestamp
      onDisconnect(userRef).update({ online: false, lastSeen: serverTimestamp() }).catch(() => {});
      // Mark online now
      update(userRef, { online: true, lastSeen: serverTimestamp() }).catch(() => {});
    };

    onValue(connRef, handler);

    const onVis = () => {
      if (document.visibilityState === "hidden") {
        update(userRef, { online: false, lastSeen: serverTimestamp() }).catch(() => {});
      } else {
        onDisconnect(userRef).update({ online: false, lastSeen: serverTimestamp() }).catch(() => {});
        update(userRef, { online: true, lastSeen: serverTimestamp() }).catch(() => {});
      }
    };

    document.addEventListener("visibilitychange", onVis);
    return () => {
      off(connRef, "value", handler);
      document.removeEventListener("visibilitychange", onVis);
      update(userRef, { online: false, lastSeen: serverTimestamp() }).catch(() => {});
    };
  }, [user]);

  return <>{children}</>;
}
