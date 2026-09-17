"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { onValue, push, ref, remove, update, get } from "firebase/database";
import { AuthGuard } from "@/components/AuthGuard";
import { useAuth } from "@/contexts/AuthContext";
import { useCrypto } from "@/contexts/CryptoContext";
import { db } from "@/lib/firebase";
import { decrypt, decryptBytes, encrypt, encryptBytes } from "@/lib/crypto";
import { encodeText } from "@/lib/cipher";
import { ReactionPicker } from "@/components/ReactionPicker";
import { StickerPicker } from "@/components/StickerPicker";
import { GifPicker } from "@/components/GifPicker";
import { CameraCapture } from "@/components/CameraCapture";
import type { DecryptedMessage, StoredMessage, RoomMeta } from "@/types/chat";

const MEDIA_EXPIRY_MS = 30_000;
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const DISAPPEARING_MS = 24 * 60 * 60 * 1000;

// ── Screenshot prevention ────────────────────────────────────────────────────
function useScreenshotPrevention(active: boolean, onProtectedChange: (v: boolean) => void) {
  useEffect(() => {
    if (!active) return;
    const blockKey = (e: KeyboardEvent) => {
      if (
        e.key === "PrintScreen" ||
        e.code === "PrintScreen" ||
        (e.metaKey && e.shiftKey && (e.key === "3" || e.key === "4" || e.key === "5"))
      ) {
        e.preventDefault();
        onProtectedChange(true);
        window.setTimeout(() => onProtectedChange(false), 700);
      }
    };
    const onVis = () => onProtectedChange(document.visibilityState === "hidden");
    const onBP = () => onProtectedChange(true);
    const onAP = () => { if (document.visibilityState === "visible") onProtectedChange(false); };
    const blockCtx = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("keydown", blockKey, true);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeprint", onBP);
    window.addEventListener("afterprint", onAP);
    document.addEventListener("contextmenu", blockCtx);
    return () => {
      window.removeEventListener("keydown", blockKey, true);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeprint", onBP);
      window.removeEventListener("afterprint", onAP);
      document.removeEventListener("contextmenu", blockCtx);
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
  return <span className="text-[10px] text-amber-400 font-mono">⏱ {Math.ceil(remaining / 1000)}s</span>;
}

// ── Message Bubble ───────────────────────────────────────────────────────────
function MessageBubble({
  m, isMine, revealed, keyword, onDelete, onReact, myUid,
}: {
  m: DecryptedMessage;
  isMine: boolean;
  revealed: boolean;
  keyword: string;
  onDelete: (id: string) => void;
  onReact: (id: string, emoji: string) => void;
  myUid: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactionOpen, setReactionOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const display = revealed ? m.plaintext : encodeText(m.plaintext, keyword);
  const isMedia = !!m.mediaType;
  const isSticker = m.msgType === "sticker";
  const isGif = m.msgType === "gif";

  // Aggregate reactions: { emoji: count, myEmoji }
  const reactionEntries = m.reactions ? Object.entries(m.reactions) : [];
  const reactionCounts: Record<string, number> = {};
  let myEmoji = "";
  for (const [uid, emoji] of reactionEntries) {
    reactionCounts[emoji] = (reactionCounts[emoji] ?? 0) + 1;
    if (uid === myUid) myEmoji = emoji;
  }

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const startLongPress = () => {
    longPressTimer.current = setTimeout(() => {
      setReactionOpen(true);
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  const handleReact = (emoji: string) => {
    // Toggle off if same emoji
    onReact(m.id, myEmoji === emoji ? "" : emoji);
  };

  return (
    <div className={`message-row ${isMine ? "items-end" : "items-start"}`}>
      <div className="relative group">
        {/* Hover reaction trigger (desktop) */}
        <button
          onClick={() => setReactionOpen((v) => !v)}
          className={`reaction-trigger ${isMine ? "reaction-trigger-left" : "reaction-trigger-right"}`}
          aria-label="Add reaction"
          tabIndex={0}
        >
          😊
        </button>

        {reactionOpen && (
          <ReactionPicker
            isMine={isMine}
            onPick={handleReact}
            onClose={() => setReactionOpen(false)}
          />
        )}

        <div
          className={`chat-bubble select-none ${isMine ? "chat-bubble-outgoing" : "chat-bubble-incoming"} ${isSticker ? "chat-bubble-sticker" : ""}`}
          onMouseDown={startLongPress}
          onMouseUp={cancelLongPress}
          onMouseLeave={cancelLongPress}
          onTouchStart={startLongPress}
          onTouchEnd={cancelLongPress}
        >
          {/* Sticker */}
          {isSticker && m.stickerUrl && (
            <span className="sticker-display" role="img" aria-label="sticker">{m.stickerUrl}</span>
          )}

          {/* GIF */}
          {isGif && m.gifUrl && (
            <div className="mb-1">
              <img
                src={m.gifUrl}
                alt="GIF"
                className="max-w-[220px] rounded-xl"
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                loading="lazy"
              />
            </div>
          )}

          {/* Media (image/video) */}
          {isMedia && m.mediaBlobUrl && (
            <div className="mb-2">
              {m.mediaType === "image" ? (
                <img
                  src={m.mediaBlobUrl}
                  alt="shared media"
                  className="max-w-[260px] rounded-xl object-cover"
                  draggable={false}
                  onContextMenu={(e) => e.preventDefault()}
                />
              ) : (
                <video
                  src={m.mediaBlobUrl}
                  controls
                  className="max-w-[260px] rounded-xl"
                  controlsList="nodownload"
                  onContextMenu={(e) => e.preventDefault()}
                />
              )}
            </div>
          )}
          {isMedia && !m.mediaBlobUrl && (
            <p className="text-xs text-slate-500 italic">Media expired or unavailable.</p>
          )}

          {/* Text */}
          {!isSticker && m.plaintext && m.plaintext.trim() !== "" && (
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{display}</p>
          )}

          {/* Meta row */}
          {!isSticker && (
            <div className="chat-meta mt-1 flex items-center justify-end gap-2">
              <span className="text-[10px] text-slate-500">
                {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              {isMedia && m.expiresAt && m.expiresAt > Date.now() && <MediaTimer expiresAt={m.expiresAt} />}
              {isMedia && m.expiresAt && <span className="text-[10px] text-slate-600">· disappears</span>}
            </div>
          )}
        </div>

        {/* Reactions display */}
        {Object.keys(reactionCounts).length > 0 && (
          <div className={`reactions-row ${isMine ? "justify-end" : "justify-start"}`}>
            {Object.entries(reactionCounts).map(([emoji, count]) => (
              <button
                key={emoji}
                onClick={() => handleReact(emoji)}
                className={`reaction-chip ${myEmoji === emoji ? "reaction-chip-mine" : ""}`}
                aria-label={`${emoji} ${count}`}
              >
                {emoji}{count > 1 && <span className="reaction-count">{count}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Options menu */}
      <div className="relative mt-1" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="msg-options-btn"
          aria-label="Message options"
        >
          ⋯
        </button>
        {menuOpen && (
          <div className={`msg-menu ${isMine ? "right-0" : "left-0"}`}>
            <button
              onClick={() => { setReactionOpen(true); setMenuOpen(false); }}
              className="msg-menu-item"
            >
              😊 React
            </button>
            <button
              onClick={() => { setMenuOpen(false); onDelete(m.id); }}
              className="msg-menu-item text-red-400"
            >
              🗑 Delete for everyone
            </button>
          </div>
        )}
      </div>
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
  const [disappearing, setDisappearing] = useState(false);
  const [disappearingLoading, setDisappearingLoading] = useState(false);
  const [showStickers, setShowStickers] = useState(false);
  const [showGifs, setShowGifs] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blobUrls = useRef<string[]>([]);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  const handlePrivacyProtection = useCallback((v: boolean) => setPrivacyProtected(v), []);
  useScreenshotPrevention(true, handlePrivacyProtection);

  // Close attach menu on outside click
  useEffect(() => {
    if (!showAttachMenu) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) setShowAttachMenu(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [showAttachMenu]);

  // Redirect if locked
  useEffect(() => {
    if (!key) {
      setMessages([]);
      blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
      blobUrls.current = [];
      setPrivacyProtected(true);
      router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`);
    }
  }, [key, router, roomId]);

  // Lock on tab hidden (not on blur — blur fires on tab switch which is not a security event)
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") { setBlurred(true); setPrivacyProtected(true); lock(); }
      else { setBlurred(false); setPrivacyProtected(false); }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [lock]);

  // Revoke blobs on unmount
  useEffect(() => {
    return () => {
      blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
      lock();
    };
  }, [lock]);

  // Load room meta (disappearing mode)
  useEffect(() => {
    if (!key || !user) return;
    const metaRef = ref(db, `rooms/${roomId}/meta`);
    return onValue(metaRef, (snap) => {
      const meta = snap.val() as RoomMeta | null;
      if (meta) setDisappearing(!!meta.disappearing);
    });
  }, [key, user, roomId]);

  // Subscribe to messages
  useEffect(() => {
    if (!key || !user) return;
    const messagesRef = ref(db, `rooms/${roomId}/messages`);
    return onValue(messagesRef, async (snapshot) => {
      const rows = snapshot.val() as Record<string, StoredMessage> | null;
      if (!rows) { setMessages([]); return; }
      const now = Date.now();
      const next: DecryptedMessage[] = [];

      for (const [id, row] of Object.entries(rows)) {
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
              const mime = row.mediaType === "image" ? "image/jpeg" : "video/mp4";
              const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
              const blob = new Blob([buf], { type: mime });
              mediaBlobUrl = URL.createObjectURL(blob);
              blobUrls.current.push(mediaBlobUrl);
            } catch { mediaBlobUrl = null; }
          }
          next.push({ ...row, id, plaintext, mediaBlobUrl });
        } catch {
          next.push({ ...row, id, plaintext: "Unable to decrypt message.", mediaBlobUrl: null });
        }
      }

      next.sort((a, b) => a.timestamp - b.timestamp);
      setMessages(next);

      // Mark viewed for disappearing mode
      if (disappearing && user && next.length > 0) {
        const viewedUpdate: Record<string, unknown> = {};
        viewedUpdate[`rooms/${roomId}/meta/disappearingViewedAt/${user.uid}`] = Date.now();
        update(ref(db), viewedUpdate).catch(() => {});
      }
    });
  }, [key, user, roomId, disappearing]);

  // Auto-scroll
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  // Client-side expiry sweep
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setMessages((prev) => {
        const expired = prev.filter((m) => m.expiresAt && m.expiresAt <= now);
        expired.forEach((m) => {
          remove(ref(db, `rooms/${roomId}/messages/${m.id}`)).catch(() => {});
          if (m.mediaBlobUrl) URL.revokeObjectURL(m.mediaBlobUrl);
        });
        return prev.filter((m) => !m.expiresAt || m.expiresAt > now);
      });
    }, 1000);
    return () => clearInterval(id);
  }, [roomId]);

  // Disappearing chat: check if conversation should be deleted
  useEffect(() => {
    if (!disappearing || !user) return;
    const id = setInterval(async () => {
      try {
        const snap = await get(ref(db, `rooms/${roomId}/meta`));
        const meta = snap.val() as RoomMeta | null;
        if (!meta?.disappearingViewedAt) return;
        const viewedTimes = Object.values(meta.disappearingViewedAt);
        if (viewedTimes.length < 2) return;
        const earliestView = Math.min(...viewedTimes);
        if (Date.now() - earliestView >= DISAPPEARING_MS) {
          // Delete all messages
          const msgsSnap = await get(ref(db, `rooms/${roomId}/messages`));
          if (msgsSnap.exists()) {
            await remove(ref(db, `rooms/${roomId}/messages`));
          }
          // Reset viewedAt
          await update(ref(db, `rooms/${roomId}/meta`), { disappearingViewedAt: null });
        }
      } catch { /* silent */ }
    }, 60_000);
    return () => clearInterval(id);
  }, [disappearing, user, roomId]);

  // Toggle disappearing mode
  const toggleDisappearing = async () => {
    if (!user) return;
    setDisappearingLoading(true);
    try {
      await update(ref(db, `rooms/${roomId}/meta`), {
        disappearing: !disappearing,
        disappearingViewedAt: null,
      });
    } catch {
      setError("Could not update disappearing mode.");
    } finally {
      setDisappearingLoading(false);
    }
  };

  // Delete message
  const deleteMessage = useCallback(async (id: string) => {
    try {
      await remove(ref(db, `rooms/${roomId}/messages/${id}`));
    } catch {
      setError("Could not delete message.");
    }
  }, [roomId]);

  // React to message
  const reactToMessage = useCallback(async (msgId: string, emoji: string) => {
    if (!user) return;
    try {
      if (emoji === "") {
        await remove(ref(db, `rooms/${roomId}/messages/${msgId}/reactions/${user.uid}`));
      } else {
        await update(ref(db, `rooms/${roomId}/messages/${msgId}/reactions`), { [user.uid]: emoji });
      }
    } catch {
      setError("Could not update reaction.");
    }
  }, [roomId, user]);

  // File select
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_MEDIA_BYTES) { setError("File too large (max 5 MB)."); return; }
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      setError("Only images and videos are supported."); return;
    }
    setMediaFile(file);
    setMediaPreview(URL.createObjectURL(file));
    setError("");
    e.target.value = "";
  };

  const clearMedia = () => {
    if (mediaPreview) URL.revokeObjectURL(mediaPreview);
    setMediaFile(null);
    setMediaPreview(null);
  };

  // Send sticker
  const sendSticker = async (emoji: string) => {
    if (!key || !user) return;
    setSending(true);
    try {
      const payload = await encrypt(" ", key);
      await push(ref(db, `rooms/${roomId}/messages`), {
        ...payload,
        senderId: user.uid,
        timestamp: Date.now(),
        msgType: "sticker",
        stickerUrl: emoji,
      });
    } catch { setError("Could not send sticker."); }
    finally { setSending(false); }
  };

  // Send GIF
  const sendGif = async (url: string, preview: string) => {
    if (!key || !user) return;
    setSending(true);
    try {
      const payload = await encrypt(" ", key);
      await push(ref(db, `rooms/${roomId}/messages`), {
        ...payload,
        senderId: user.uid,
        timestamp: Date.now(),
        msgType: "gif",
        gifUrl: url,
        gifPreview: preview,
      });
    } catch { setError("Could not send GIF."); }
    finally { setSending(false); }
  };

  // Send message
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
        msgType: "text",
      };
      if (mediaFile) {
        const bytes = new Uint8Array(await mediaFile.arrayBuffer());
        const { data, iv } = await encryptBytes(bytes, key);
        record.mediaData = data;
        record.mediaIv = iv;
        record.mediaType = mediaFile.type.startsWith("image/") ? "image" : "video";
        record.msgType = record.mediaType;
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
    <main className="chat-page" style={{ WebkitUserSelect: "none", userSelect: "none" } as React.CSSProperties}>
      {/* Header */}
      <header className="chat-header">
        <div className="header-info">
          <span className="chat-avatar">🔐</span>
          <div className="header-text">
            <h1 className="header-title">Private room</h1>
            <p className="header-subtitle">
              {disappearing && <span className="disappearing-badge">⏳ 24h · </span>}
              <span className="hidden sm:inline">End-to-end encrypted · </span>
              <span className="sm:hidden">Encrypted · </span>
              <span className="font-mono">{roomId}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Disappearing toggle */}
          <button
            onClick={toggleDisappearing}
            disabled={disappearingLoading}
            className={`header-icon-btn ${disappearing ? "header-icon-btn-active" : ""}`}
            title={disappearing ? "Disappearing chat ON — click to disable" : "Enable 24h disappearing chat"}
            aria-label="Toggle disappearing chat"
          >
            ⏳
          </button>
          <button
            onClick={() => { lock(); router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`); }}
            className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-200 hover:bg-white/5 transition flex-shrink-0"
          >
            Lock
          </button>
        </div>
      </header>

      {/* Disappearing mode banner */}
      {disappearing && (
        <div className="disappearing-banner" role="status">
          ⏳ Disappearing messages on · Messages delete 24h after both participants view them
        </div>
      )}

      {/* Message list */}
      <section
        className={`sensitive-chat-content messages-container chat-messages ${blurred ? "blur-xl pointer-events-none" : ""}`}
        aria-label="Message list"
      >
        <div className="messages-inner">
          {messages.length === 0 && (
            <div className="empty-state">
              <span className="text-4xl">🔐</span>
              <p className="text-sm text-slate-500 mt-2">No messages yet. Say hello!</p>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              m={m}
              isMine={m.senderId === user?.uid}
              revealed={revealed}
              keyword={keyword}
              onDelete={deleteMessage}
              onReact={reactToMessage}
              myUid={user?.uid ?? ""}
            />
          ))}
          <div ref={bottom} />
        </div>
      </section>

      {/* Media preview strip */}
      {mediaPreview && mediaFile && (
        <div className="media-preview-strip">
          <div className="media-preview-inner">
            {mediaFile.type.startsWith("image/") ? (
              <img src={mediaPreview} alt="preview" className="h-16 w-16 rounded-lg object-cover" />
            ) : (
              <video src={mediaPreview} className="h-16 w-16 rounded-lg object-cover" muted />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-300 truncate">{mediaFile.name}</p>
              <p className="text-[10px] text-amber-400">⏱ Expires 30s after sending</p>
            </div>
            <button onClick={clearMedia} className="text-slate-500 hover:text-red-400 text-lg" aria-label="Remove media">✕</button>
          </div>
        </div>
      )}

      {/* Pickers (rendered above composer) */}
      <div className="pickers-anchor">
        {showStickers && <StickerPicker onPick={(s) => { sendSticker(s); setShowStickers(false); }} onClose={() => setShowStickers(false)} />}
        {showGifs && <GifPicker onPick={(url, preview) => { sendGif(url, preview); setShowGifs(false); }} onClose={() => setShowGifs(false)} />}
      </div>

      {/* Composer */}
      <form onSubmit={send} className="message-composer chat-composer">
        <div className="composer-container">
          <div className="composer-main">
            <input ref={fileInputRef} type="file" accept="image/*,video/*" className="hidden" onChange={handleFileSelect} />

            {/* Attach menu */}
            <div className="relative" ref={attachMenuRef}>
              <button
                type="button"
                onClick={() => setShowAttachMenu((v) => !v)}
                className="btn-attachment"
                title="Attach"
                aria-label="Attach media"
                aria-expanded={showAttachMenu}
              >
                📎
              </button>
              {showAttachMenu && (
                <div className="attach-menu">
                  <button type="button" onClick={() => { fileInputRef.current?.click(); setShowAttachMenu(false); }} className="attach-menu-item">
                    🖼️ <span>Photo / Video</span>
                  </button>
                  <button type="button" onClick={() => { setShowCamera(true); setShowAttachMenu(false); }} className="attach-menu-item">
                    📷 <span>Camera</span>
                  </button>
                  <button type="button" onClick={() => { setShowStickers((v) => !v); setShowGifs(false); setShowAttachMenu(false); }} className="attach-menu-item">
                    🎭 <span>Sticker</span>
                  </button>
                  <button type="button" onClick={() => { setShowGifs((v) => !v); setShowStickers(false); setShowAttachMenu(false); }} className="attach-menu-item">
                    🎞️ <span>GIF</span>
                  </button>
                </div>
              )}
            </div>

            {/* Text input */}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(e as unknown as FormEvent); }
              }}
              rows={1}
              placeholder={mediaFile ? "Add a caption… (optional)" : "Write a message…"}
              className="composer-input"
              style={{ userSelect: "text" } as React.CSSProperties}
            />

            {/* Coded/Revealed toggle — desktop */}
            <div className="mode-switch mode-switch-desktop" role="group" aria-label="Display mode">
              <button type="button" onClick={() => setRevealed(false)} className={!revealed ? "mode-active" : "mode-option"}>Coded</button>
              <button type="button" onClick={() => setRevealed(true)} className={revealed ? "mode-active" : "mode-option"}>Revealed</button>
            </div>

            {/* Send */}
            <button disabled={sending || (!input.trim() && !mediaFile)} className="btn-send">
              {sending ? "…" : "Send"}
            </button>
          </div>

          {/* Coded/Revealed toggle — mobile */}
          <div className="mode-switch mode-switch-mobile" role="group" aria-label="Display mode mobile">
            <button type="button" onClick={() => setRevealed(false)} className={!revealed ? "mode-active" : "mode-option"}>Coded</button>
            <button type="button" onClick={() => setRevealed(true)} className={revealed ? "mode-active" : "mode-option"}>Revealed</button>
          </div>
        </div>
        {error && <p className="mx-auto mt-2 max-w-3xl text-xs text-red-300">{error}</p>}
      </form>

      {/* Camera */}
      {showCamera && (
        <CameraCapture
          onCapture={(file) => {
            if (file.size > MAX_MEDIA_BYTES) { setError("Captured file too large (max 5 MB)."); return; }
            setMediaFile(file);
            setMediaPreview(URL.createObjectURL(file));
          }}
          onClose={() => setShowCamera(false)}
        />
      )}

      {/* Privacy overlay */}
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
