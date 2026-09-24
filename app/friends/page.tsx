"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { BottomNav } from "@/components/BottomNav";
import { PresenceGuard } from "@/components/PresenceGuard";
import { useAuth } from "@/contexts/AuthContext";
import { useCrypto } from "@/contexts/CryptoContext";
import {
  subscribeFriends,
  subscribeIncomingRequests,
  subscribeOutgoingRequests,
  subscribeProfile,
  removeFriend,
  acceptFriendRequest,
  declineFriendRequest,
  cancelFriendRequest,
  privateRoomId,
  ensurePrivateRoom,
} from "@/lib/userService";
import type { UserProfile, FriendRequest } from "@/types/user";

type Tab = "friends" | "incoming" | "outgoing";

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

// ── Friend row ────────────────────────────────────────────────────────────────

function FriendRow({ uid, myUid, filter }: { uid: string; myUid: string; filter: string }) {
  const router = useRouter();
  const { key } = useCrypto();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [removing, setRemoving] = useState(false);
  const [opening, setOpening] = useState(false);

  // Live subscription so online status updates in real-time
  useEffect(() => subscribeProfile(uid, setProfile), [uid]);

  // Filter by display name or username — hide if doesn't match
  if (filter.trim() && profile) {
    const q = filter.trim().toLowerCase();
    const nameMatch = profile.displayName.toLowerCase().includes(q);
    const userMatch = profile.username.toLowerCase().includes(q);
    if (!nameMatch && !userMatch) return null;
  }

  async function handleMessage() {
    setOpening(true);
    try {
      const roomId = await ensurePrivateRoom(myUid, uid, key ?? undefined);
      router.push(`/chat/${encodeURIComponent(roomId)}`);
    } catch (err) {
      console.error('Failed to create private room:', err);
      alert('Could not start encrypted chat. Ensure Firebase rules allow room creation and your device is registered.');
    } finally {
      setOpening(false);
    }
  }

  async function handleRemove() {
    if (!confirm(`Remove ${profile?.displayName ?? uid} from friends?`)) return;
    setRemoving(true);
    try { await removeFriend(myUid, uid); }
    catch { /* silent */ }
    finally { setRemoving(false); }
  }

  if (!profile) return <div className="friend-row-skeleton" />;

  return (
    <div className="friend-row">
      <div className="friend-row-avatar">
        <span>{profile.photoURL}</span>
        {profile.online && <span className="online-dot" />}
      </div>
      <div className="friend-row-info">
        <p className="friend-row-name">{profile.displayName}</p>
        <p className="friend-row-username">
          @{profile.username}
          {" · "}
          {profile.online
            ? <span className="text-emerald-400 text-xs">● Online</span>
            : <span className="text-slate-500 text-xs">Last seen {timeAgo(profile.lastSeen)}</span>}
        </p>
      </div>
      <div className="friend-row-actions">
        <button
          onClick={() => void handleMessage()}
          disabled={opening}
          className="action-btn action-btn-primary action-btn-sm"
          aria-label={`Message ${profile.displayName}`}
        >
          {opening ? "…" : "💬"}
        </button>
        <button
          onClick={() => void handleRemove()}
          disabled={removing}
          className="action-btn action-btn-sm action-btn-danger"
          aria-label={`Remove ${profile.displayName}`}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// ── Incoming request row ──────────────────────────────────────────────────────

function IncomingRow({ req, myUid }: { req: FriendRequest; myUid: string }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"accepted" | "declined" | null>(null);

  useEffect(() => subscribeProfile(req.fromUid, setProfile), [req.fromUid]);

  async function accept() {
    setBusy(true);
    try {
      await acceptFriendRequest(req.id, req.fromUid, myUid);
      setDone("accepted");
    } catch (err) {
      console.error("[IncomingRow.accept] error:", err);
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await declineFriendRequest(req.id);
      setDone("declined");
    } catch (err) {
      console.error("[IncomingRow.decline] error:", err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="notif-row notif-row-done">
        <span>{done === "accepted" ? "✓ Friend added" : "✕ Declined"}</span>
        {profile && <span className="text-slate-400 text-sm"> — {profile.displayName}</span>}
      </div>
    );
  }

  return (
    <div className="notif-row">
      <div className="notif-avatar">{profile?.photoURL ?? "👤"}</div>
      <div className="notif-body">
        <p className="notif-title">
          🤝 <strong>{profile?.displayName ?? "Someone"}</strong> wants to be friends
        </p>
        <p className="notif-sub">@{profile?.username ?? "…"}</p>
      </div>
      <div className="notif-actions">
        <button onClick={() => void accept()} disabled={busy} className="action-btn action-btn-primary action-btn-sm">
          Accept
        </button>
        <button onClick={() => void decline()} disabled={busy} className="action-btn action-btn-sm">
          Decline
        </button>
      </div>
    </div>
  );
}

// ── Outgoing request row ──────────────────────────────────────────────────────

function OutgoingRow({ req }: { req: FriendRequest }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => subscribeProfile(req.toUid, setProfile), [req.toUid]);

  async function cancel() {
    setCancelling(true);
    try { await cancelFriendRequest(req.id); setCancelled(true); }
    catch { /* silent */ }
    finally { setCancelling(false); }
  }

  if (cancelled) {
    return (
      <div className="notif-row notif-row-done">
        <span className="text-slate-400 text-sm">Request cancelled</span>
      </div>
    );
  }

  return (
    <div className="notif-row">
      <div className="notif-avatar">{profile?.photoURL ?? "👤"}</div>
      <div className="notif-body">
        <p className="notif-title">
          <strong>{profile?.displayName ?? "…"}</strong>
        </p>
        <p className="notif-sub">@{profile?.username ?? "…"} · Pending</p>
      </div>
      <div className="notif-actions">
        <button
          onClick={() => void cancel()}
          disabled={cancelling}
          className="action-btn action-btn-sm"
        >
          {cancelling ? "…" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function FriendsInner() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("friends");
  const [friendUids, setFriendUids] = useState<string[]>([]);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!user) return;
    const unsub1 = subscribeFriends(user.uid, setFriendUids);
    const unsub2 = subscribeIncomingRequests(user.uid, setIncoming);
    const unsub3 = subscribeOutgoingRequests(user.uid, setOutgoing);
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [user]);

  const incomingCount = incoming.length;
  const outgoingCount = outgoing.length;

  return (
    <PresenceGuard>
      <main className="app-page">
        <header className="app-header">
          <h1 className="app-header-title">Friends</h1>
          {incomingCount > 0 && (
            <span className="app-header-badge-count">{incomingCount}</span>
          )}
        </header>

        {/* Tabs */}
        <div className="friends-tabs">
          <button
            className={`friends-tab${tab === "friends" ? " friends-tab-active" : ""}`}
            onClick={() => setTab("friends")}
            id="tab-friends"
          >
            Friends {friendUids.length > 0 && <span className="friends-tab-count">{friendUids.length}</span>}
          </button>
          <button
            className={`friends-tab${tab === "incoming" ? " friends-tab-active" : ""}`}
            onClick={() => setTab("incoming")}
            id="tab-requests"
          >
            Requests {incomingCount > 0 && <span className="friends-tab-badge">{incomingCount}</span>}
          </button>
          <button
            className={`friends-tab${tab === "outgoing" ? " friends-tab-active" : ""}`}
            onClick={() => setTab("outgoing")}
            id="tab-sent"
          >
            Sent {outgoingCount > 0 && <span className="friends-tab-count">{outgoingCount}</span>}
          </button>
        </div>

        {/* Friends tab */}
        {tab === "friends" && (
          <>
            {friendUids.length > 0 && (
              <div className="friends-search-bar">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search friends…"
                  className="friends-search-input"
                  aria-label="Search friends by name"
                  id="friends-search"
                />
              </div>
            )}
            <div className="friends-list">
              {friendUids.length === 0 && (
                <div className="empty-home">
                  <span className="text-4xl">🤝</span>
                  <p>No friends yet.</p>
                  <p className="text-slate-500 text-sm">Search for users to add them.</p>
                </div>
              )}
              {friendUids.map((uid) => (
                <FriendRow key={uid} uid={uid} myUid={user!.uid} filter={filter} />
              ))}
            </div>
          </>
        )}

        {/* Incoming requests tab */}
        {tab === "incoming" && (
          <div className="notif-list">
            {incoming.length === 0 && (
              <div className="empty-home">
                <span className="text-4xl">🔔</span>
                <p>No pending requests.</p>
              </div>
            )}
            {incoming.map((r) => (
              <IncomingRow key={r.id} req={r} myUid={user!.uid} />
            ))}
          </div>
        )}

        {/* Outgoing requests tab */}
        {tab === "outgoing" && (
          <div className="notif-list">
            {outgoing.length === 0 && (
              <div className="empty-home">
                <span className="text-4xl">📤</span>
                <p>No sent requests.</p>
              </div>
            )}
            {outgoing.map((r) => (
              <OutgoingRow key={r.id} req={r} />
            ))}
          </div>
        )}

        <BottomNav />
      </main>
    </PresenceGuard>
  );
}

export default function FriendsPage() {
  return <AuthGuard><FriendsInner /></AuthGuard>;
}
