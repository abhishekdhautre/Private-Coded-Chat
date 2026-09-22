"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { BottomNav } from "@/components/BottomNav";
import { PresenceGuard } from "@/components/PresenceGuard";
import { useAuth } from "@/contexts/AuthContext";
import { getProfile, subscribeChatList, subscribeProfile, markChatRead } from "@/lib/userService";
import type { UserProfile } from "@/types/user";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function ChatRow({
  roomId,
  otherUid,
  lastMessageAt,
  unread,
  myUid,
}: {
  roomId: string;
  otherUid: string;
  lastMessageAt: number;
  unread: number;
  myUid: string;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    if (!otherUid) return;
    return subscribeProfile(otherUid, setProfile);
  }, [otherUid]);

  function openChat() {
    // Mark as read before navigating
    if (unread > 0) markChatRead(roomId, myUid).catch(() => {});
    router.push(`/chat/${encodeURIComponent(roomId)}`);
  }

  return (
    <button
      className="chat-row"
      onClick={openChat}
      aria-label={`Open chat with ${profile?.displayName ?? "…"}`}
    >
      <div className="chat-row-avatar">
        <span>{profile?.photoURL ?? "👤"}</span>
        {profile?.online && <span className="online-dot" aria-label="Online" />}
      </div>
      <div className="chat-row-body">
        <div className="chat-row-top">
          <span className={`chat-row-name${unread > 0 ? " chat-row-name-unread" : ""}`}>
            {profile?.displayName ?? "…"}
          </span>
          <span className="chat-row-time">{timeAgo(lastMessageAt)}</span>
        </div>
        <div className="chat-row-bottom">
          <p className="chat-row-preview">🔐 New private message</p>
          {unread > 0 && (
            <span className="chat-unread-badge" aria-label={`${unread} unread`}>
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function HomeInner() {
  const { user } = useAuth();
  const router = useRouter();
  const [chats, setChats] = useState<Array<{
    roomId: string;
    otherUid: string;
    lastMessageAt: number;
    unread: number;
  }>>([]);
  const [profileChecked, setProfileChecked] = useState(false);

  // Redirect to profile setup if no profile
  useEffect(() => {
    if (!user) return;
    getProfile(user.uid).then((p) => {
      if (!p) router.replace("/profile-setup");
      else setProfileChecked(true);
    });
  }, [user, router]);

  useEffect(() => {
    if (!user || !profileChecked) return;
    return subscribeChatList(user.uid, setChats);
  }, [user, profileChecked]);

  if (!profileChecked) {
    return <main className="app-page"><p className="loading-text">Loading…</p></main>;
  }

  const totalUnread = chats.reduce((sum, c) => sum + c.unread, 0);

  return (
    <PresenceGuard>
      <main className="app-page">
        <header className="app-header">
          <h1 className="app-header-title">Chats</h1>
          {totalUnread > 0 && (
            <span className="app-header-badge-count">{totalUnread > 99 ? "99+" : totalUnread}</span>
          )}
        </header>

        <div className="chat-list">
          {chats.length === 0 && (
            <div className="empty-home">
              <span className="text-4xl">💬</span>
              <p>No chats yet.</p>
              <p className="text-slate-500 text-sm">Find friends and start a conversation.</p>
            </div>
          )}
          {chats.map((c) => (
            <ChatRow key={c.roomId} {...c} myUid={user!.uid} />
          ))}
        </div>

        <BottomNav />
      </main>
    </PresenceGuard>
  );
}

export default function HomePage() {
  return <AuthGuard><HomeInner /></AuthGuard>;
}
