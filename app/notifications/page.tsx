"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Friend requests have moved to the Friends page (Requests tab).
export default function NotificationsPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/friends"); }, [router]);
  return null;
}
