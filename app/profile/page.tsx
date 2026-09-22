"use client";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { BottomNav } from "@/components/BottomNav";
import { PresenceGuard } from "@/components/PresenceGuard";
import { useAuth } from "@/contexts/AuthContext";
import { getProfile, updateProfile } from "@/lib/userService";
import type { UserProfile } from "@/types/user";

const AVATARS = ["🧑", "👩", "🧔", "👱", "🧕", "🧑‍💻", "🧑‍🎨", "🧑‍🚀", "🦊", "🐺", "🦁", "🐯"];

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function ProfileInner() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [avatar, setAvatar] = useState("🧑");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    getProfile(user.uid).then((p) => {
      if (!p) { router.replace("/profile-setup"); return; }
      setProfile(p);
      setDisplayName(p.displayName);
      setBio(p.bio);
      setAvatar(p.photoURL);
    });
  }, [user, router]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!user || !displayName.trim()) return;
    setBusy(true);
    setError("");
    try {
      await updateProfile(user.uid, { displayName: displayName.trim(), bio: bio.trim(), photoURL: avatar });
      setProfile((p) => p ? { ...p, displayName: displayName.trim(), bio: bio.trim(), photoURL: avatar } : p);
      setEditing(false);
    } catch { setError("Could not save changes."); }
    finally { setBusy(false); }
  }

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  if (!profile) return <main className="app-page"><p className="loading-text">Loading…</p></main>;

  return (
    <PresenceGuard>
      <main className="app-page">
        <header className="app-header">
          <h1 className="app-header-title">Profile</h1>
        </header>

        <div className="profile-page-body">
          {!editing ? (
            <div className="profile-view">
              <div className="profile-view-avatar">{profile.photoURL}</div>
              <h2 className="profile-view-name">{profile.displayName}</h2>
              <p className="profile-view-username">@{profile.username}</p>
              {profile.bio && <p className="profile-view-bio">{profile.bio}</p>}
              <p className="profile-view-status">
                {profile.online
                  ? <span className="text-emerald-400">● Online</span>
                  : <span className="text-slate-500">Last seen {timeAgo(profile.lastSeen)}</span>}
              </p>
              <div className="profile-view-actions">
                <button onClick={() => setEditing(true)} className="action-btn action-btn-primary">Edit Profile</button>
                <button onClick={() => router.push("/friends")} className="action-btn">Friends</button>
                <button onClick={() => void handleLogout()} className="action-btn action-btn-danger">Sign out</button>
              </div>
            </div>
          ) : (
            <form onSubmit={save} className="setup-form">
              <div className="avatar-picker">
                {AVATARS.map((a) => (
                  <button key={a} type="button" onClick={() => setAvatar(a)}
                    className={`avatar-option${avatar === a ? " avatar-selected" : ""}`}
                  >{a}</button>
                ))}
              </div>
              <label className="setup-field">
                <span>Display name</span>
                <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} className="setup-input" />
              </label>
              <label className="setup-field">
                <span>Bio</span>
                <input value={bio} onChange={(e) => setBio(e.target.value)} maxLength={120} className="setup-input" />
              </label>
              {error && <p className="setup-error">{error}</p>}
              <div className="profile-edit-actions">
                <button type="submit" disabled={busy} className="action-btn action-btn-primary">{busy ? "Saving…" : "Save"}</button>
                <button type="button" onClick={() => setEditing(false)} className="action-btn">Cancel</button>
              </div>
            </form>
          )}
        </div>

        <BottomNav />
      </main>
    </PresenceGuard>
  );
}

export default function ProfilePage() {
  return <AuthGuard><ProfileInner /></AuthGuard>;
}
