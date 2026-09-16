"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { onValue, push, ref, remove } from "firebase/database";
import { AuthGuard } from "@/components/AuthGuard";
import { useAuth } from "@/contexts/AuthContext";
import { useCrypto } from "@/contexts/CryptoContext";
import { db } from "@/lib/firebase";
import { decrypt, decryptBytes, encrypt, encryptBytes } from "@/lib/crypto";
import { encodeText } from "@/lib/cipher";
import type { DecryptedMessage, StoredMessage } from "@/types/chat";

const MEDIA_EXPIRY_MS = 30_000;
const MAX_MEDIA_BYTES = 5 * 1024 * 1024; // 5 MB hard cap

// ── Screenshot prevention ────────────────────────────────────────────────────
function useScreenshotPrevention(active: boolean, onProtectedChange: (protectedState: boolean) => void) {
  useEffect(() => {
    if (!active) return;

    // 1. Block PrintScreen / Meta+Shift+3/4 key combos
    const blockKey = (e: KeyboardEvent) => {
      if (
        e.key === "PrintScreen" ||
        e.code === "PrintScreen" ||
        (e.metaKey && e.shiftKey && (e.key === "3" || e.key === "4" || e.key === "5"))
      ) {
        e.preventDefault();
        // Briefly blank the page so any OS-level capture gets nothing
        onProtectedChange(true);
        window.setTimeout(() => onProtectedChange(false), 700);
      }
    };

    // 2. Detect when the window loses focus (screenshot tool, screen recorder)
    const onBlur = () => {
      onProtectedChange(true);
    };
    const onFocus = () => {
      if (document.visibilityState === "visible") onProtectedChange(false);
    };
    const onVisibilityChange = () => {
      onProtectedChange(document.visibilityState === "hidden");
    };
    const onBeforePrint = () => {
      onProtectedChange(true);
    };
    const onAfterPrint = () => {
      if (document.visibilityState === "visible") onProtectedChange(false);
    };
    const blockContextMenu = (event: MouseEvent) => event.preventDefault();

    window.addEventListener("keydown", blockKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);
    document.addEventListener("contextmenu", blockContextMenu);

    return () => {
      window.removeEventListener("keydown", blockKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("beforeprint", onBeforePrint);
      window.removeEventListener("afterprint", onAfterPrint);
      document.removeEventListener("contextmenu", blockContextMenu);
    };
  }, [active, onProtectedChange]);
}

// ── Media expiry countdown ───────────────────────────────────────────────────
function MediaTimer({ expiresAt }: { expiresAt: number }) {
  const [remaining, setRemaining] = useState(Math.max(0, expiresAt - Date.now()));
  useEffect(() => {
    const id = setInterval(() => {
      const r = Math.max(0, expiresAt - Date.now());
      setRemaining(r);
      if (r === 0) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [expiresAt]);
  const secs = Math.ceil(remaining / 1000);
  return (
    <span className="text-[10px] text-amber-400 font-mono">
      ⏱ {secs}s
    </span>
  );
}

// ── Message bubble ───────────────────────────────────────────────────────────
function MessageBubble({
  m, isMine, revealed, keyword, onDelete,
}: {
  m: DecryptedMessage;
  isMine: boolean;
  revealed: boolean;
  keyword: string;
  onDelete: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const display = revealed ? m.plaintext : encodeText(m.plaintext, keyword);
  const isMedia = !!m.mediaType;

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const startLongPress = () => {
    if (!isMine) return;
    longPressTimer.current = setTimeout(() => setMenuOpen(true), 500);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  return (
    <div className={`chat-row relative flex w-full flex-col ${isMine ? "items-end" : "items-start"}`}>
      <div
        className={`chat-bubble max-w-[85%] select-none ${
          isMine ? "chat-bubble-outgoing" : "chat-bubble-incoming"
        }`}
        onMouseDown={startLongPress}
        onMouseUp={cancelLongPress}
        onMouseLeave={cancelLongPress}
        onTouchStart={startLongPress}
        onTouchEnd={cancelLongPress}
      >
        {/* Media content */}
        {isMedia && m.mediaBlobUrl && (
          <div className="mb-2">
            {m.mediaType === "image" ? (
              <img
                src={m.mediaBlobUrl}
                alt="shared media"
                className="max-w-[260px] rounded-xl object-cover"
                draggable={false}
                onContextMenu={e => e.preventDefault()}
              />
            ) : (
              <video
                src={m.mediaBlobUrl}
                controls
                className="max-w-[260px] rounded-xl"
                controlsList="nodownload"
                onContextMenu={e => e.preventDefault()}
              />
            )}
          </div>
        )}
        {isMedia && !m.mediaBlobUrl && (
          <p className="text-xs text-slate-500 italic">Media expired or unavailable.</p>
        )}

        {/* Text content (caption or message) */}
        {m.plaintext && (
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{display}</p>
        )}

        <div className="chat-meta mt-1 flex items-center justify-end gap-2">
          <span className="text-[10px] text-slate-500">
            {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          {isMedia && m.expiresAt && m.expiresAt > Date.now() && (
            <MediaTimer expiresAt={m.expiresAt} />
          )}
          {isMedia && m.expiresAt && (
            <span className="text-[10px] text-slate-600">· disappears</span>
          )}
        </div>
      </div>

      {/* Three-dot menu button (own messages only) */}
      {isMine && (
        <div className="relative mt-1" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="text-slate-600 hover:text-slate-300 px-1 text-xs"
            aria-label="Message options"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className={`absolute z-50 mt-1 rounded-xl border border-white/10 bg-[#0d1117] shadow-xl ${isMine ? "right-0" : "left-0"}`}>
              <button
                onClick={() => { setMenuOpen(false); onDelete(m.id); }}
                className="flex items-center gap-2 px-4 py-2 text-sm text-red-400 hover:bg-white/5 rounded-xl whitespace-nowrap"
              >
                🗑 Delete for everyone
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main chat component ──────────────────────────────────────────────────────
function ChatInner() {
  const params = useParams<{ roomId: string }>();
  const roomId = decodeURIComponent(params.roomId);
  const router = useRouter();
  const { user } = useAuth();
  const { key, keyword, lock } = useCrypto();

  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [input, setInput] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [blurred, setBlurred] = useState(false);
  const [error, setError] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [privacyProtected, setPrivacyProtected] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Track blob URLs to revoke on unmount
  const blobUrls = useRef<string[]>([]);

  const handlePrivacyProtection = useCallback((protectedState: boolean) => {
    setPrivacyProtected(protectedState);
  }, []);

  useScreenshotPrevention(true, handlePrivacyProtection);

  // Redirect if locked
  useEffect(() => {
    if (!key) { setMessages([]); router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`); }
  }, [key, router, roomId]);

  // Blur on window focus loss (message list only)
  useEffect(() => {
    const onBlur = () => { setBlurred(true); setPrivacyProtected(true); };
    const onFocus = () => { setBlurred(false); setPrivacyProtected(false); };
    const onVis = () => { if (document.visibilityState === "hidden") lock(); };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [lock]);

  // Revoke blob URLs on unmount
  useEffect(() => {
    return () => { blobUrls.current.forEach(u => URL.revokeObjectURL(u)); };
  }, []);

  // Subscribe to messages
  useEffect(() => {
    if (!key || !user) return;
    const messagesRef = ref(db, `rooms/${roomId}/messages`);
    return onValue(messagesRef, async snapshot => {
      const rows = snapshot.val() as Record<string, StoredMessage> | null;
      if (!rows) { setMessages([]); return; }
      const now = Date.now();
      const next: DecryptedMessage[] = [];

      for (const [id, row] of Object.entries(rows)) {
        // Server-side expiry enforcement on client read
        if (row.expiresAt && row.expiresAt <= now) {
          remove(ref(db, `rooms/${roomId}/messages/${id}`)).catch(() => {});
          continue;
        }
        try {
          const plaintext = await decrypt(row.ciphertext, row.iv, key);
          let mediaBlobUrl: string | null = null;

          if (row.mediaData && row.mediaIv && row.mediaType) {
            try {
              const bytes = await decryptBytes(row.mediaData, row.mediaIv, key);
              const mimeType = row.mediaType === "image" ? "image/jpeg" : "video/mp4";
              const mediaBuffer = new ArrayBuffer(bytes.byteLength);
              new Uint8Array(mediaBuffer).set(bytes);
              const blob = new Blob([mediaBuffer], { type: mimeType });
              mediaBlobUrl = URL.createObjectURL(blob);
              blobUrls.current.push(mediaBlobUrl);
            } catch {
              mediaBlobUrl = null;
            }
          }

          next.push({ ...row, id, plaintext, mediaBlobUrl });
        } catch {
          next.push({ ...row, id, plaintext: "Unable to decrypt message.", mediaBlobUrl: null });
        }
      }

      next.sort((a, b) => a.timestamp - b.timestamp);
      setMessages(next);
    });
  }, [key, user, roomId]);

  // Auto-scroll
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  // Client-side expiry sweep (removes expired media from local state + Firebase)
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setMessages(prev => {
        const expired = prev.filter(m => m.expiresAt && m.expiresAt <= now);
        expired.forEach(m => {
          remove(ref(db, `rooms/${roomId}/messages/${m.id}`)).catch(() => {});
          if (m.mediaBlobUrl) URL.revokeObjectURL(m.mediaBlobUrl);
        });
        return prev.filter(m => !m.expiresAt || m.expiresAt > now);
      });
    }, 1000);
    return () => clearInterval(id);
  }, [roomId]);

  // Delete message
  const deleteMessage = useCallback(async (id: string) => {
    try {
      await remove(ref(db, `rooms/${roomId}/messages/${id}`));
    } catch {
      setError("Could not delete message.");
    }
  }, [roomId]);

  // Media file selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_MEDIA_BYTES) { setError("File too large (max 5 MB)."); return; }
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    if (!isImage && !isVideo) { setError("Only images and videos are supported."); return; }
    setMediaFile(file);
    const url = URL.createObjectURL(file);
    setMediaPreview(url);
    setError("");
    // Reset input so same file can be re-selected
    e.target.value = "";
  };

  const clearMedia = () => {
    if (mediaPreview) URL.revokeObjectURL(mediaPreview);
    setMediaFile(null);
    setMediaPreview(null);
  };

  // Send message (text and/or media)
  async function send(e: FormEvent) {
    e.preventDefault();
    if ((!input.trim() && !mediaFile) || !key || !user) return;
    setSending(true);
    setError("");
    try {
      const payload = await encrypt(input.trim() || " ", key);
      const record: Record<string, unknown> = {
        ...payload,
        senderId: user.uid,
        timestamp: Date.now(),
      };

      if (mediaFile) {
        const bytes = new Uint8Array(await mediaFile.arrayBuffer());
        const { data, iv } = await encryptBytes(bytes, key);
        record.mediaData = data;
        record.mediaIv = iv;
        record.mediaType = mediaFile.type.startsWith("image/") ? "image" : "video";
        record.expiresAt = Date.now() + MEDIA_EXPIRY_MS;
      }

      await push(ref(db, `rooms/${roomId}/messages`), record);
      setInput("");
      clearMedia();
    } catch {
      setError("Message could not be encrypted/sent.");
    } finally {
      setSending(false);
    }
  }

  if (!key) return null;

  return (
    <main
      className="chat-shell flex min-h-[100dvh] flex-col bg-[#05070b]"
      // CSS-level screenshot deterrence: disable selection and drag
      style={{ WebkitUserSelect: "none", userSelect: "none" } as React.CSSProperties}
    >
      {/* Header */}
      <header className="chat-header flex items-center justify-between border-b border-white/10 px-4 py-4 md:px-8">
        <div>
          <div className="flex items-center gap-2">
            <span className="chat-avatar">🔐</span>
            <span className="font-semibold">Private room</span>
          </div>
          <p className="text-xs text-slate-500">End-to-end encrypted · {roomId}</p>
        </div>
        <div className="chat-header-actions flex items-center gap-2">
          <button
            onClick={() => { lock(); router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`); }}
            className="rounded-lg border border-white/10 px-3 py-2 text-sm"
          >
            Lock
          </button>
        </div>
      </header>

      {/* Message list */}
      <section
        className={`chat-messages flex-1 overflow-y-auto p-4 transition duration-100 md:p-8 ${blurred ? "blur-xl pointer-events-none" : ""}`}
        aria-label="Message list"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {messages.map(m => (
            <MessageBubble
              key={m.id}
              m={m}
              isMine={m.senderId === user?.uid}
              revealed={revealed}
              keyword={keyword}
              onDelete={deleteMessage}
            />
          ))}
          <div ref={bottom} />
        </div>
      </section>

      {/* Media preview strip */}
      {mediaPreview && mediaFile && (
        <div className="border-t border-white/10 bg-black/20 px-4 py-3 md:px-8">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            {mediaFile.type.startsWith("image/") ? (
              <img src={mediaPreview} alt="preview" className="h-16 w-16 rounded-lg object-cover" />
            ) : (
              <video src={mediaPreview} className="h-16 w-16 rounded-lg object-cover" muted />
            )}
            <div className="flex-1">
              <p className="text-xs text-slate-300 truncate">{mediaFile.name}</p>
              <p className="text-[10px] text-amber-400">⏱ Expires 30s after sending</p>
            </div>
            <button onClick={clearMedia} className="text-slate-500 hover:text-red-400 text-lg">✕</button>
          </div>
        </div>
      )}

      {/* Input bar */}
      <form onSubmit={send} className="chat-composer border-t border-white/10 p-4 md:px-8">
        <div className="composer-layout mx-auto flex max-w-3xl flex-wrap gap-2 items-end">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            className="hidden"
            onChange={handleFileSelect}
          />
          {/* Attachment button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="order-1 rounded-xl border border-white/10 px-3 py-3 text-slate-400 hover:text-cyan-400 hover:border-cyan-400/40 transition-colors"
            title="Attach photo or video (expires in 30s)"
            aria-label="Attach media"
          >
            📎
          </button>

          <div className="mode-switch order-3 flex rounded-xl border border-white/10 bg-white/[.04] p-1" role="group" aria-label="Message display mode">
            <button type="button" onClick={() => setRevealed(false)} className={!revealed ? "mode-active" : "mode-option"}>
              Coded
            </button>
            <button type="button" onClick={() => setRevealed(true)} className={revealed ? "mode-active" : "mode-option"}>
              Revealed
            </button>
          </div>

          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(e as unknown as FormEvent); }
            }}
            rows={1}
            placeholder={mediaFile ? "Add a caption… (optional)" : "Write a message…"}
            className="order-2 min-h-12 flex-1 resize-none rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-cyan-400"
            style={{ userSelect: "text" } as React.CSSProperties}
          />

          <button
            disabled={sending || (!input.trim() && !mediaFile)}
            className="composer-send order-4 rounded-xl bg-cyan-400 px-5 py-3 font-semibold text-slate-950 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
        {error && <p className="mx-auto mt-2 max-w-3xl text-xs text-red-300">{error}</p>}
      </form>
      {privacyProtected && (
        <div className="privacy-overlay" role="status" aria-live="polite">
          <div className="privacy-overlay-card">
            <span className="privacy-overlay-icon" aria-hidden="true">🔒</span>
            <strong>Chat Protected</strong>
            <span>Return to continue</span>
          </div>
        </div>
      )}
    </main>
  );
}

export default function ChatPage() { return <AuthGuard><ChatInner /></AuthGuard>; }
