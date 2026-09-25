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
            <Toggle
              label="Messages"
              checked={settings.notif_messages}
              onChange={(v) => void patch({ notif_messages: v })}
            />
            <p className="settings-section-note">
              Plays a sound for new incoming messages. The in-chat mute switch silences sounds on this device only.
            </p>
            {/* Friend-request, reaction, reply, media and preview toggles were
                removed: no producer/consumer implements them, and showing them
                implied behaviour that does not exist. */}
          </section>

          {/* Privacy switches (online/last-seen visibility, read receipts,
              typing indicator) were removed: presence, receipts and typing are
              currently always-on protocol behaviour with no per-user gating, so
              the controls were placebo. They can return once a real gating
              implementation lands. */}
        </div>

        <BottomNav />
      </main>
    </PresenceGuard>
  );
}

export default function SettingsPage() {
  return <AuthGuard><SettingsInner /></AuthGuard>;
}
