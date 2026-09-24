"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { BottomNav } from "@/components/BottomNav";
import { PresenceGuard } from "@/components/PresenceGuard";
import { useAuth } from "@/contexts/AuthContext";
import { getProfile, subscribeChatList, subscribeProfile, markChatRead, pinChat, muteChat } from "@/lib/userService";
import { BrandMark, Icon } from "@/components/Icon";
import type { UserProfile } from "@/types/user";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function isMuted(muteUntil: number | null | undefined): boolean {
  if (!muteUntil) return false;
  if (muteUntil === -1) return true;
  return muteUntil > Date.now();
}

function ChatRow({
  roomId, otherUid, lastMessageAt, unread, pinned, muteUntil, myUid,
}: {
  roomId: string; otherUid: string; lastMessageAt: number;
  unread: number; pinned?: boolean; muteUntil?: number | null; myUid: string;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const muted = isMuted(muteUntil);

  useEffect(() => {
    if (!otherUid) return;
    return subscribeProfile(otherUid, setProfile);
  }, [otherUid]);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [menuOpen]);

  function openChat() {
    if (unread > 0) markChatRead(roomId, myUid).catch(() => {});
    router.push(`/chat/${encodeURIComponent(roomId)}`);
  }

  function handlePin() {
    pinChat(myUid, roomId, !pinned).catch(() => {});
    setMenuOpen(false);
  }

  function handleMute(duration: number | null) {
    const until = duration === null ? null : duration === -1 ? -1 : Date.now() + duration;
    muteChat(myUid, roomId, until).catch(() => {});
    setMenuOpen(false);
  }

  return (
    <div className={`chat-row-wrap${pinned ? " chat-row-pinned" : ""}`}>
      <button
        className="chat-row"
        onClick={openChat}
        aria-label={`Open chat with ${profile?.displayName ?? "…"}`}
      >
        <div className="chat-row-avatar">
          <span>{profile?.photoURL ?? "?"}</span>
          {profile?.online && <span className="online-dot" aria-label="Online" />}
        </div>
        <div className="chat-row-body">
          <div className="chat-row-top">
            <span className={`chat-row-name${unread > 0 ? " chat-row-name-unread" : ""}`}>
              {pinned && <span className="chat-pin-icon" aria-label="Pinned"><Icon name="pinFilled" size={12} /></span>}
              {muted && <span className="chat-mute-icon" aria-label="Muted"><Icon name="muteFilled" size={12} /></span>}
              {profile?.displayName ?? "…"}
            </span>
            <span className="chat-row-time">{timeAgo(lastMessageAt)}</span>
          </div>
          <div className="chat-row-bottom">
            <p className="chat-row-preview">
              <span className="chat-row-lock" aria-hidden="true"><Icon name="lock" size={11} /></span>
              {" "}New private message
            </p>
            {unread > 0 && !muted && (
              <span className="chat-unread-badge" aria-label={`${unread} unread`}>
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Context menu trigger */}
      <div className="relative" ref={menuRef}>
        <button
          className="chat-row-menu-btn"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          aria-label="Chat options"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <Icon name="more" size={17} />
        </button>
        {menuOpen && (
          <div className="chat-row-menu" role="menu" aria-label="Chat options">
            <button className="chat-row-menu-item" role="menuitem" onClick={handlePin}>
              <Icon name={pinned ? "pinFilled" : "pin"} size={15} />
              {pinned ? "Unpin" : "Pin chat"}
            </button>
            {muted ? (
              <button className="chat-row-menu-item" role="menuitem" onClick={() => handleMute(null)}>
                <Icon name="bell" size={15} />
                Unmute
              </button>
            ) : (
              <>
                <button className="chat-row-menu-item" role="menuitem" onClick={() => handleMute(3_600_000)}>
                  <Icon name="mute" size={15} />
                  Mute 1 hour
                </button>
                <button className="chat-row-menu-item" role="menuitem" onClick={() => handleMute(8 * 3_600_000)}>
                  <Icon name="mute" size={15} />
                  Mute 8 hours
                </button>
                <button className="chat-row-menu-item" role="menuitem" onClick={() => handleMute(7 * 86_400_000)}>
                  <Icon name="mute" size={15} />
                  Mute 1 week
                </button>
                <button className="chat-row-menu-item" role="menuitem" onClick={() => handleMute(-1)}>
                  <Icon name="muteFilled" size={15} />
                  Mute always
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HomeInner() {
  const { user } = useAuth();
  const router = useRouter();
  const [chats, setChats] = useState<Array<{
    roomId: string; otherUid: string; lastMessageAt: number;
    unread: number; pinned?: boolean; muteUntil?: number | null;
  }>>([]);
  const [profileChecked, setProfileChecked] = useState(false);
  const [profileError, setProfileError] = useState(false);

  useEffect(() => {
    if (!user) return;
    getProfile(user.uid)
      .then((p) => {
        if (!p) router.replace("/profile-setup");
        else setProfileChecked(true);
      })
      .catch(() => {
        // getProfile failed (network/permission error) — unblock the UI
        setProfileError(true);
        setProfileChecked(true);
      });
  }, [user, router]);

  useEffect(() => {
    if (!user || !profileChecked) return;
    return subscribeChatList(user.uid, setChats);
  }, [user, profileChecked]);

  if (!profileChecked) {
    return <main className="app-page"><p className="loading-text">Loading…</p></main>;
  }

  if (profileError) {
    return (
      <main className="app-page">
        <div className="empty-home">
          <span className="text-4xl">⚠️</span>
          <p>Unable to load your account.</p>
          <button className="action-btn action-btn-primary" onClick={() => window.location.reload()}>Retry</button>
        </div>
      </main>
    );
  }

  // Sort: pinned first, then by lastMessageAt desc
  const sorted = [...chats].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.lastMessageAt - a.lastMessageAt;
  });

  const totalUnread = chats.reduce((sum, c) => sum + (isMuted(c.muteUntil) ? 0 : c.unread), 0);

  return (
    <PresenceGuard>
      <main className="app-page">
        <header className="app-header app-header-brand">
          <div className="app-header-identity">
            <BrandMark size={26} withWordmark={false} />
            <div className="app-header-titles">
              <h1 className="app-header-title">Chats</h1>
              <p className="app-header-tagline">
                <Icon name="lock" size={10} />
                {" "}End-to-end encrypted
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {totalUnread > 0 && (
              <span className="app-header-badge-count">{totalUnread > 99 ? "99+" : totalUnread}</span>
            )}
            <button
              onClick={() => router.push("/friends")}
              className="header-icon-btn"
              aria-label="Start a new chat"
              title="New chat"
            >
              <Icon name="plus" size={19} />
            </button>
            <button
              onClick={() => router.push("/settings")}
              className="header-icon-btn"
              aria-label="Settings"
              title="Settings"
            >
              <Icon name="settings" size={19} />
            </button>
          </div>
        </header>

        <div className="chat-list">
          {chats.length === 0 && (
            <div className="empty-home">
              <span className="empty-home-mark"><Icon name="chat" size={30} /></span>
              <p className="empty-home-title">No chats yet</p>
              <p className="text-sm empty-home-sub">Find friends and start an encrypted conversation.</p>
              <button className="action-btn action-btn-primary" onClick={() => router.push("/friends")}>
                <Icon name="users" size={16} />
                Find friends
              </button>
            </div>
          )}
          {sorted.map((c) => (
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
