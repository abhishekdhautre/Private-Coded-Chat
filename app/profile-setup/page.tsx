"use client";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useAuth } from "@/contexts/AuthContext";
import { claimUsername, createProfile, getProfile, isUsernameAvailable, isValidUsername } from "@/lib/userService";
import { BrandMark } from "@/components/Icon";

const AVATARS = ["🧑", "👩", "🧔", "👱", "🧕", "🧑‍💻", "🧑‍🎨", "🧑‍🚀", "🦊", "🐺", "🦁", "🐯"];

function ProfileSetupInner() {
  const { user } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [avatar, setAvatar] = useState("🧑");
  const [usernameStatus, setUsernameStatus] = useState<"idle" | "checking" | "available" | "taken" | "invalid">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Redirect if profile already exists
  useEffect(() => {
    if (!user) return;
    getProfile(user.uid).then((p) => { if (p) router.replace("/home"); });
  }, [user, router]);

  // Debounced username check
  useEffect(() => {
    if (!username) { setUsernameStatus("idle"); return; }
    if (!isValidUsername(username)) { setUsernameStatus("invalid"); return; }
    setUsernameStatus("checking");
    const t = setTimeout(async () => {
      const avail = await isUsernameAvailable(username);
      setUsernameStatus(avail ? "available" : "taken");
    }, 500);
    return () => clearTimeout(t);
  }, [username]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!displayName.trim()) { setError("Display name is required."); return; }
    if (usernameStatus !== "available") { setError("Choose a valid, available username."); return; }
    setBusy(true);
    setError("");
    try {
      const claimed = await claimUsername(username, user.uid);
      if (!claimed) { setUsernameStatus("taken"); setError("Username was just taken. Try another."); return; }
      await createProfile({
        uid: user.uid,
        username,
        displayName: displayName.trim(),
        photoURL: avatar,
        bio: bio.trim(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastSeen: Date.now(),
        online: true,
      });
      router.replace("/home");
    } catch {
      setError("Could not save profile. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const usernameHint =
    usernameStatus === "checking" ? "Checking…" :
    usernameStatus === "available" ? "✓ Available" :
    usernameStatus === "taken" ? "✕ Already taken" :
    usernameStatus === "invalid" ? "3–20 chars, lowercase letters, numbers, underscore" : "";

  const hintColor =
    usernameStatus === "available" ? "setup-hint-ok" :
    usernameStatus === "taken" || usernameStatus === "invalid" ? "setup-hint-bad" : "";

  return (
    <main className="setup-page">
      <div className="setup-card">
        <div className="setup-brand">
          <BrandMark size={30} withWordmark={false} />
        </div>
        <p className="setup-eyebrow">Private by design</p>
        <h1 className="setup-title">Complete your profile</h1>
        <p className="setup-sub">This is how others will find and recognise you.</p>

        <form onSubmit={submit} className="setup-form">
          {/* Avatar picker */}
          <div className="avatar-picker">
            {AVATARS.map((a) => (
              <button key={a} type="button" onClick={() => setAvatar(a)}
                className={`avatar-option${avatar === a ? " avatar-selected" : ""}`}
                aria-label={`Select avatar ${a}`}
              >{a}</button>
            ))}
          </div>
          <p className="setup-field-label">Selected: <span className="text-2xl">{avatar}</span></p>

          <label className="setup-field">
            <span>Display name</span>
            <input
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              maxLength={40}
              className="setup-input"
            />
          </label>

          <label className="setup-field">
            <span>@Username</span>
            <input
              required
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              placeholder="e.g. rahul_123"
              maxLength={20}
              className="setup-input"
            />
            {usernameHint && <span className={`setup-hint ${hintColor}`}>{usernameHint}</span>}
          </label>

          <label className="setup-field">
            <span>Bio <span className="text-slate-500">(optional)</span></span>
            <input
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A short bio…"
              maxLength={120}
              className="setup-input"
            />
          </label>

          {error && <p className="setup-error">{error}</p>}

          <button
            type="submit"
            disabled={busy || usernameStatus !== "available" || !displayName.trim()}
            className="setup-btn"
          >
            {busy ? "Saving…" : "Continue →"}
          </button>
        </form>
      </div>
    </main>
  );
}

export default function ProfileSetupPage() {
  return <AuthGuard><ProfileSetupInner /></AuthGuard>;
}
