"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { BottomNav } from "@/components/BottomNav";
import { PresenceGuard } from "@/components/PresenceGuard";
import { useAuth } from "@/contexts/AuthContext";
import {
  subscribeNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  subscribeProfile,
} from "@/lib/userService";
import type { AppNotification } from "@/lib/userService";
import type { UserProfile } from "@/types/user";

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

const NOTIF_ICON: Record<AppNotification["type"], string> = {
  friend_request: "🤝",
  friend_accepted: "✅",
  reaction: "❤️",
  reply: "↩",
  message: "🔐",
  media: "📸",
};

const NOTIF_LABEL: Record<AppNotification["type"], string> = {
  friend_request: "sent you a friend request",
  friend_accepted: "accepted your friend request",
  reaction: "reacted to your message",
  reply: "replied to your message",
  message: "sent you a private message",
  media: "sent you media",
};

function NotifRow({
  n,
  uid,
  onRead,
}: {
  n: AppNotification;
  uid: string;
  onRead: (id: string) => void;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => subscribeProfile(n.fromUid, setProfile), [n.fromUid]);

  function handleClick() {
    if (!n.read) onRead(n.id);
    if (n.type === "friend_request" || n.type === "friend_accepted") {
      router.push("/friends");
    } else if (n.roomId) {
      router.push(`/chat/${encodeURIComponent(n.roomId)}`);
    }
  }

  return (
    <button
      className={`notif-row notif-row-btn${n.read ? " notif-row-done" : ""}`}
      onClick={handleClick}
      aria-label={`${profile?.displayName ?? "Someone"} ${NOTIF_LABEL[n.type]}`}
    >
      <div className="notif-avatar-wrap">
        <span className="notif-avatar">{profile?.photoURL ?? "👤"}</span>
        <span className="notif-type-icon">{NOTIF_ICON[n.type]}</span>
      </div>
      <div className="notif-body">
        <p className="notif-title">
          <strong>{profile?.displayName ?? "Someone"}</strong>{" "}
          {NOTIF_LABEL[n.type]}
        </p>
        <p className="notif-sub">{timeAgo(n.createdAt)}</p>
      </div>
      {!n.read && <span className="notif-unread-dot" aria-label="Unread" />}
    </button>
  );
}

function NotificationsInner() {
  const { user } = useAuth();
  const [notifs, setNotifs] = useState<AppNotification[]>([]);

  useEffect(() => {
    if (!user) return;
    return subscribeNotifications(user.uid, setNotifs);
  }, [user]);

  const unreadCount = notifs.filter((n) => !n.read).length;

  function handleRead(id: string) {
    if (!user) return;
    markNotificationRead(user.uid, id).catch(() => {});
  }

  function handleReadAll() {
    if (!user) return;
    markAllNotificationsRead(user.uid).catch(() => {});
  }

  return (
    <PresenceGuard>
      <main className="app-page">
        <header className="app-header">
          <h1 className="app-header-title">Notifications</h1>
          {unreadCount > 0 && (
            <div className="flex items-center gap-2">
              <span className="app-header-badge-count">{unreadCount > 99 ? "99+" : unreadCount}</span>
              <button onClick={handleReadAll} className="notif-mark-all-btn">
                Mark all read
              </button>
            </div>
          )}
        </header>

        <div className="notif-list">
          {notifs.length === 0 && (
            <div className="empty-home">
              <span className="text-4xl">🔔</span>
              <p>No notifications yet.</p>
            </div>
          )}
          {notifs.map((n) => (
            <NotifRow key={n.id} n={n} uid={user!.uid} onRead={handleRead} />
          ))}
        </div>

        <BottomNav />
      </main>
    </PresenceGuard>
  );
}

export default function NotificationsPage() {
  return <AuthGuard><NotificationsInner /></AuthGuard>;
}
