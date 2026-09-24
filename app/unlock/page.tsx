"use client";
import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { BrandMark, Icon } from "@/components/Icon";
import { AuthError, Field, PasswordVisibilityToggle } from "@/components/auth/AuthShell";
import { useCrypto } from "@/contexts/CryptoContext";
import { db } from "@/lib/firebase";
import { decrypt, deriveKey } from "@/lib/crypto";
import { get, ref } from "firebase/database";

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code.toUpperCase() : "";
  }
  return "";
}

function UnlockInner() {
  const router = useRouter();
  const params = useSearchParams();
  const roomId = params.get("roomId") || "";
  const { key, unlock, unlockV2 } = useCrypto();
  const [passphrase, setPassphrase] = useState("");
  const [keyword, setKeyword] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [isV2, setIsV2] = useState(false);

  useEffect(() => {
    if (key && roomId) {
      router.replace(`/chat/${encodeURIComponent(roomId)}`);
      return;
    }
    if (!roomId) return;

    let mounted = true;
    (async () => {
      try {
        const metaSnap = await get(ref(db, `rooms/${roomId}/meta`));
        if (!metaSnap.exists()) return;
        const meta = metaSnap.val();
        if (meta?.version === "v2_e2ee") {
          if (mounted) {
            setIsV2(true);
            setBusy(true);
          }
          try {
            const { acquireV2RoomKey } = await import("@/lib/roomKeyService");
            const res = await acquireV2RoomKey(roomId, meta.currentEpoch || 1);
            if (mounted) {
              unlockV2?.(res);
              router.replace(`/chat/${encodeURIComponent(roomId)}`);
            }
          } catch {
            if (mounted) {
              setError("Unable to unlock this encrypted conversation on this device.");
            }
          } finally {
            if (mounted) setBusy(false);
          }
        }
      } catch {
        // Network or permission check failure — fallback to manual if applicable
      }
    })();

    return () => {
      mounted = false;
    };
  }, [key, roomId, router, unlockV2]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!roomId) {
      setError("Missing room ID.");
      return;
    }
    setBusy(true);
    setError("");
    let stage = "room verifier read";
    try {
      const snapshot = await get(ref(db, `rooms/${roomId}/meta/keyCheck`));
      const keyCheck = snapshot.val() as { ciphertext?: string; iv?: string } | null;
      if (!keyCheck?.ciphertext || !keyCheck.iv) throw new Error("Room verifier is missing");
      stage = "passphrase verification";
      const derivedKey = await deriveKey(passphrase, roomId);
      await decrypt(keyCheck.ciphertext, keyCheck.iv, derivedKey);
      unlock(derivedKey, keyword);
      router.replace(`/chat/${encodeURIComponent(roomId)}`);
    } catch (error) {
      const code = errorCode(error);
      if (code.includes("PERMISSION_DENIED") || code.includes("PERMISSION-DENIED")) {
        setError("This Firebase account is not one of the two room participants. Sign in with the participant UID used during room setup.");
      } else if (code.includes("NETWORK") || code.includes("DISCONNECTED")) {
        setError("Firebase could not be reached. Check the database connection.");
      } else if (stage === "passphrase verification") {
        setError("Incorrect encryption passphrase.");
      } else {
        setError(`Unlock failed during ${stage}. Check the room ID and Firebase configuration.`);
      }
    } finally {
      setBusy(false);
    }
  }

  if (isV2) {
    return (
      <main className="lock-page">
        <div className="lock-card">
          <div className="lock-mark">
            <Icon name="lock" size={26} />
          </div>
          <h1 className="lock-title">End-to-end encrypted room</h1>
          {busy ? (
            <p className="lock-copy">Unwrapping this device&apos;s room key and initialising the message ratchet…</p>
          ) : error ? (
            <p className="lock-copy" role="alert">{error}</p>
          ) : (
            <p className="lock-copy">Opening encrypted conversation…</p>
          )}
          <div className="lock-brand">
            <BrandMark size={22} withWordmark={false} />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card">
        <div className="setup-brand">
          <BrandMark size={30} withWordmark={false} />
        </div>
        <p className="setup-eyebrow">Private by design</p>
        <h1 className="setup-title">Unlock room</h1>
        <p className="setup-sub">
          The passphrase and display keyword stay in this device&apos;s memory only. They are never sent to Firebase.
        </p>
        <form className="setup-form" onSubmit={submit} noValidate>
          <Field
            id="unlock-passphrase"
            label="Shared encryption passphrase"
            type={showSecrets ? "text" : "password"}
            value={passphrase}
            onChange={setPassphrase}
            autoComplete="off"
            required
            trailing={
              <PasswordVisibilityToggle
                visible={showSecrets}
                onToggle={() => setShowSecrets((v) => !v)}
                inputId="unlock-passphrase"
              />
            }
          />
          <Field
            id="unlock-keyword"
            label="Shared display keyword"
            type={showSecrets ? "text" : "password"}
            value={keyword}
            onChange={setKeyword}
            autoComplete="off"
            required
          />
          <AuthError message={error} />
          <button type="submit" className="setup-btn" disabled={busy} aria-busy={busy}>
            {busy ? "Deriving key…" : "Unlock"}
          </button>
        </form>
      </div>
    </main>
  );
}
export default function UnlockPage(){return <AuthGuard><UnlockInner/></AuthGuard>}
