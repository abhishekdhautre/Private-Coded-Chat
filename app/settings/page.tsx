"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { BottomNav } from "@/components/BottomNav";
import { PresenceGuard } from "@/components/PresenceGuard";
import { useAuth } from "@/contexts/AuthContext";
import { subscribeUserSettings, saveUserSettings } from "@/lib/userService";
import type { UserSettings } from "@/lib/userService";
import { Icon } from "@/components/Icon";

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="settings-toggle-row">
      <span className="settings-toggle-label">{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`settings-toggle${checked ? " settings-toggle-on" : ""}`}
        aria-label={label}
      >
        <span className="settings-toggle-thumb" />
      </button>
    </label>
  );
}

function Select<T extends string>({
  value, onChange, options, label,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <label className="settings-select-row">
      <span className="settings-toggle-label">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="settings-select"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function SettingsInner() {
  const { user } = useAuth();
  const router = useRouter();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    return subscribeUserSettings(user.uid, setSettings);
  }, [user]);

  async function patch(partial: Partial<UserSettings>) {
    if (!user || !settings) return;
    const next = { ...settings, ...partial };
    setSettings(next);
    setSaving(true);
    try { await saveUserSettings(user.uid, partial); }
    catch { /* silent */ }
    finally { setSaving(false); }
  }

  if (!settings) return <main className="app-page"><p className="loading-text">Loading…</p></main>;

  const visibilityOpts = [
    { value: "everyone" as const, label: "Everyone" },
    { value: "friends" as const, label: "Friends only" },
    { value: "nobody" as const, label: "Nobody" },
  ];

  return (
    <PresenceGuard>
      <main className="app-page">
        <header className="app-header">
          <button onClick={() => router.back()} className="settings-back-btn" aria-label="Go back">
            <Icon name="back" size={17} />
            Back
          </button>
          <h1 className="app-header-title">Settings</h1>
          {saving && <span className="settings-saving">Saving…</span>}
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h2 className="settings-section-title">Notifications</h2>
            <Toggle label="Messages" checked={settings.notif_messages} onChange={(v) => void patch({ notif_messages: v })} />
            <Toggle label="Friend Requests" checked={settings.notif_friendRequests} onChange={(v) => void patch({ notif_friendRequests: v })} />
            <Toggle label="Reactions" checked={settings.notif_reactions} onChange={(v) => void patch({ notif_reactions: v })} />
            <Toggle label="Replies" checked={settings.notif_replies} onChange={(v) => void patch({ notif_replies: v })} />
            <Toggle label="Media" checked={settings.notif_media} onChange={(v) => void patch({ notif_media: v })} />
            <Toggle label="Show message preview" checked={settings.notif_preview} onChange={(v) => void patch({ notif_preview: v })} />
          </section>

          <section className="settings-section">
            <h2 className="settings-section-title">Privacy</h2>
            <Select
              label="Online status visible to"
              value={settings.privacy_onlineStatus}
              onChange={(v) => void patch({ privacy_onlineStatus: v })}
              options={visibilityOpts}
            />
            <Select
              label="Last seen visible to"
              value={settings.privacy_lastSeen}
              onChange={(v) => void patch({ privacy_lastSeen: v })}
              options={visibilityOpts}
            />
            <Toggle label="Read receipts" checked={settings.privacy_readReceipts} onChange={(v) => void patch({ privacy_readReceipts: v })} />
            <Toggle label="Typing indicator" checked={settings.privacy_typingIndicator} onChange={(v) => void patch({ privacy_typingIndicator: v })} />
          </section>
        </div>

        <BottomNav />
      </main>
    </PresenceGuard>
  );
}

export default function SettingsPage() {
  return <AuthGuard><SettingsInner /></AuthGuard>;
}
