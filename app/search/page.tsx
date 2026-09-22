"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { BottomNav } from "@/components/BottomNav";
import { PresenceGuard } from "@/components/PresenceGuard";
import { useAuth } from "@/contexts/AuthContext";
import {
  getUidByUsername, getProfile, isFriend,
  sendFriendRequest, cancelFriendRequest,
} from "@/lib/userService";
import type { UserProfile } from "@/types/user";

type SearchResult = {
  profile: UserProfile;
  relation: "self" | "friend" | "request-sent" | "request-received" | "none";
  requestId?: string;
};

function SearchInner() {
  const { user } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [searching, setSearching] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState("");

  async function search() {
    if (!user || !query.trim()) return;
    setSearching(true);
    setResult(null);
    setNotFound(false);
    setError("");
    try {
      const username = query.trim().replace(/^@/, "").toLowerCase();
      const uid = await getUidByUsername(username);
      if (!uid) { setNotFound(true); return; }
      const profile = await getProfile(uid);
      if (!profile) { setNotFound(true); return; }

      if (uid === user.uid) {
        setResult({ profile, relation: "self" });
        return;
      }

      const friend = await isFriend(user.uid, uid);
      if (friend) { setResult({ profile, relation: "friend" }); return; }

      setResult({ profile, relation: "none" });
    } catch (error) {
      console.error("[Search] failed:", error);
      setError("Search failed. Please try again.");
    } finally {
      setSearching(false);
    }
  }

  async function handleAdd() {
    if (!user || !result) return;
    setActionBusy(true);
    try {
      await sendFriendRequest(user.uid, result.profile.uid);
      setResult({ ...result, relation: "request-sent" });
    } catch { setError("Could not send request."); }
    finally { setActionBusy(false); }
  }

  async function handleCancel() {
    if (!result?.requestId) return;
    setActionBusy(true);
    try {
      await cancelFriendRequest(result.requestId);
      setResult({ ...result, relation: "none", requestId: undefined });
    } catch { setError("Could not cancel request."); }
    finally { setActionBusy(false); }
  }

  const p = result?.profile;

  return (
    <PresenceGuard>
      <main className="app-page">
        <header className="app-header">
          <h1 className="app-header-title">Search</h1>
        </header>

        <div className="search-page-body">
          <div className="search-input-row">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
              placeholder="@username"
              className="search-page-input"
              aria-label="Search by username"
            />
            <button onClick={() => void search()} disabled={searching || !query.trim()} className="search-page-btn">
              {searching ? "…" : "Search"}
            </button>
          </div>

          {error && <p className="setup-error">{error}</p>}
          {notFound && <p className="search-not-found">No user found.</p>}

          {p && (
            <div className="profile-card">
              <div className="profile-card-avatar">{p.photoURL}</div>
              <div className="profile-card-info">
                <p className="profile-card-name">{p.displayName}</p>
                <p className="profile-card-username">@{p.username}</p>
                {p.bio && <p className="profile-card-bio">{p.bio}</p>}
                <p className="profile-card-status">
                  {p.online ? <span className="text-emerald-400">● Online</span> : <span className="text-slate-500">Last seen {timeAgo(p.lastSeen)}</span>}
                </p>
              </div>

              <div className="profile-card-actions">
                {result?.relation === "self" && (
                  <button onClick={() => router.push("/profile")} className="action-btn">Your Profile</button>
                )}
                {result?.relation === "friend" && (
                  <button onClick={() => router.push(`/chat/${encodeURIComponent(roomIdFor(user!.uid, p.uid))}`)} className="action-btn action-btn-primary">
                    💬 Message
                  </button>
                )}
                {result?.relation === "none" && (
                  <button onClick={() => void handleAdd()} disabled={actionBusy} className="action-btn action-btn-primary">
                    {actionBusy ? "…" : "+ Add Friend"}
                  </button>
                )}
                {result?.relation === "request-sent" && (
                  <button onClick={() => void handleCancel()} disabled={actionBusy} className="action-btn">
                    {actionBusy ? "…" : "Request Sent ✕"}
                  </button>
                )}
                {result?.relation === "request-received" && (
                  <button onClick={() => router.push("/notifications")} className="action-btn action-btn-primary">
                    Respond to Request →
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <BottomNav />
      </main>
    </PresenceGuard>
  );
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function roomIdFor(a: string, b: string): string {
  return [a, b].sort().join("__");
}

export default function SearchPage() {
  return <AuthGuard><SearchInner /></AuthGuard>;
}
