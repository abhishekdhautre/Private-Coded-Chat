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
import type { ConversationMode, DecryptedMessage, StoredMessage, RoomMeta } from "@/types/chat";

const MEDIA_EXPIRY_MS = 30_000;
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const DISAPPEARING_MS = 24 * 60 * 60 * 1000;

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
  m, isMine, revealed, keyword, onDelete, onDeleteForMe, onConsume, onReact, onReply, onEdit, onPin, onSelect, selected, myUid,
}: {
  m: DecryptedMessage;
  isMine: boolean;
  revealed: boolean;
  keyword: string;
  onDelete: (id: string) => void;
  onDeleteForMe: (id: string) => void;
  onConsume: (id: string) => void;
  onReact: (id: string, emoji: string) => void;
  onReply: (message: DecryptedMessage) => void;
  onEdit: (message: DecryptedMessage) => void;
  onPin: (id: string, pinned: boolean) => void;
  onSelect: (id: string) => void;
  selected: boolean;
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
          className={`chat-bubble ${selected ? "chat-bubble-selected" : ""} ${isMine ? "chat-bubble-outgoing" : "chat-bubble-incoming"} ${isSticker ? "chat-bubble-sticker" : ""}`}
          onDoubleClick={() => onReact(m.id, myEmoji === "❤️" ? "" : "❤️")}
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
                  onClick={() => { if (m.viewOnce && !m.consumedBy?.[myUid]) onConsume(m.id); }}
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
          {m.replyTo && <p className="mb-1 border-l-2 border-cyan-300/60 pl-2 text-[11px] text-slate-300">Replying to a message</p>}
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
              {m.editedAt && <span className="text-[10px] text-slate-500">edited</span>}
              {m.pinned && <span className="text-[10px] text-amber-300">pinned</span>}
              {m.readBy && Object.keys(m.readBy).length > 1 && <span className="text-[10px] text-cyan-300">read</span>}
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
              onClick={() => { onReply(m); setMenuOpen(false); }}
              className="msg-menu-item"
            >
              ↩ Reply
            </button>
            <button
              onClick={() => { void navigator.clipboard?.writeText(m.plaintext); setMenuOpen(false); }}
              className="msg-menu-item"
            >
              Copy message
            </button>
            <button
              onClick={() => { onSelect(m.id); setMenuOpen(false); }}
              className="msg-menu-item"
            >
              Select
            </button>
            <button
              onClick={() => { onPin(m.id, !m.pinned); setMenuOpen(false); }}
              className="msg-menu-item"
            >
              {m.pinned ? "Unpin" : "Pin message"}
            </button>
            {isMine && <button
              onClick={() => { onEdit(m); setMenuOpen(false); }}
              className="msg-menu-item"
            >
              Edit message
            </button>}
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
            <button
              onClick={() => { setMenuOpen(false); onDeleteForMe(m.id); }}
              className="msg-menu-item text-red-300"
            >
              Hide for me
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
  const [ghostLifetime, setGhostLifetime] = useState<number | null>(null);
  const [conversationMode, setConversationMode] = useState<ConversationMode>("NORMAL");
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [viewOnce, setViewOnce] = useState(false);
  const [momentInput, setMomentInput] = useState("");
  const [moments, setMoments] = useState<Array<{ id: string; text: string; senderId: string; expiresAt: number }>>([]);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [replyingTo, setReplyingTo] = useState<DecryptedMessage | null>(null);
  const [editing, setEditing] = useState<DecryptedMessage | null>(null);
  const [typing, setTyping] = useState(false);
  const [otherTyping, setOtherTyping] = useState(false);
  const [unread, setUnread] = useState(0);
  const [disappearingLoading, setDisappearingLoading] = useState(false);
  const [showStickers, setShowStickers] = useState(false);
  const [showGifs, setShowGifs] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [showPrivacySettings, setShowPrivacySettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showMomentsPanel, setShowMomentsPanel] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blobUrls = useRef<string[]>([]);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!showOverflowMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowOverflowMenu(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showOverflowMenu]);

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
      else { setBlurred(false); setPrivacyProtected(true); }
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
      if (meta) {
        setDisappearing(!!meta.disappearing);
        setGhostLifetime(meta.ghostLifetimeMs ?? null);
        setConversationMode(meta.mode ?? "NORMAL");
        setSessionExpiresAt(meta.sessionExpiresAt ?? null);
      }
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
        if (row.deletedFor?.[user.uid]) continue;
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
      setMessages((previous) => {
        if (document.visibilityState !== "visible") setUnread((count) => count + Math.max(0, next.length - previous.length));
        return next;
      });

      if (user) {
        const readUpdates: Record<string, unknown> = {};
        next.filter((message) => message.senderId !== user.uid).forEach((message) => {
          readUpdates[`rooms/${roomId}/messages/${message.id}/readBy/${user.uid}`] = Date.now();
        });
        if (Object.keys(readUpdates).length) update(ref(db), readUpdates).catch(() => {});
      }

      // Mark viewed for disappearing mode
      if (disappearing && user && next.length > 0) {
        const viewedUpdate: Record<string, unknown> = {};
        viewedUpdate[`rooms/${roomId}/meta/disappearingViewedAt/${user.uid}`] = Date.now();
        update(ref(db), viewedUpdate).catch(() => {});
      }
    });
  }, [key, user, roomId, disappearing]);

  // Presence is metadata only; message plaintext never enters Firebase.
  useEffect(() => {
    if (!key || !user) return;
    const typingRef = ref(db, `rooms/${roomId}/presence/${user.uid}`);
    if (!typing) {
      remove(typingRef).catch(() => {});
      return;
    }
    update(ref(db), { [`rooms/${roomId}/presence/${user.uid}`]: { typing: true, at: Date.now() } }).catch(() => {});
    const timeout = window.setTimeout(() => setTyping(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [key, roomId, typing, user]);

  useEffect(() => {
    if (!key || !user) return;
    return onValue(ref(db, `rooms/${roomId}/presence`), (snapshot) => {
      const presence = snapshot.val() as Record<string, { typing?: boolean; at?: number }> | null;
      const other = Object.entries(presence ?? {}).some(([uid, value]) => uid !== user.uid && value.typing && Date.now() - (value.at ?? 0) < 4000);
      setOtherTyping(other);
    });
  }, [key, roomId, user]);

  useEffect(() => {
    if (!key || !user) return;
    return onValue(ref(db, `rooms/${roomId}/moments`), async (snapshot) => {
      const rows = snapshot.val() as Record<string, { ciphertext: string; iv: string; senderId: string; expiresAt: number }> | null;
      const next = await Promise.all(Object.entries(rows ?? {}).map(async ([id, row]) => {
        if (row.expiresAt <= Date.now()) { remove(ref(db, `rooms/${roomId}/moments/${id}`)).catch(() => {}); return null; }
        try { return { id, senderId: row.senderId, expiresAt: row.expiresAt, text: await decrypt(row.ciphertext, row.iv, key) }; }
        catch { return null; }
      }));
      setMoments(next.filter((moment): moment is { id: string; text: string; senderId: string; expiresAt: number } => moment !== null));
    });
  }, [key, roomId, user]);

  useEffect(() => {
    if (!sessionExpiresAt) return;
    const remaining = sessionExpiresAt - Date.now();
    if (remaining <= 0) { lock(); return; }
    const timeout = window.setTimeout(lock, remaining);
    return () => window.clearTimeout(timeout);
  }, [lock, sessionExpiresAt]);

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

  const updateGhostLifetime = async (value: string) => {
    const lifetime = value === "keep" ? null : Number(value);
    setGhostLifetime(lifetime);
    try {
      await update(ref(db, `rooms/${roomId}/meta`), { ghostLifetimeMs: lifetime, mode: lifetime ? "GHOST" : conversationMode });
    } catch { setError("Could not update ghost mode."); }
  };

  const updateConversationMode = async (mode: ConversationMode) => {
    setConversationMode(mode);
    try { await update(ref(db, `rooms/${roomId}/meta`), { mode }); }
    catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as Error & { code?: unknown }).code) : "PERMISSION_DENIED";
      setError(`Could not update conversation mode (${code}). Deploy the current Firebase rules if this persists.`);
    }
  };

  const startGhostSession = async (duration: number) => {
    const expiresAt = Date.now() + duration;
    setSessionExpiresAt(expiresAt);
    try { await update(ref(db, `rooms/${roomId}/meta`), { mode: "LIVE", sessionExpiresAt: expiresAt }); }
    catch { setError("Could not start ghost session."); }
  };

  const sendMoment = async () => {
    if (!key || !user || !momentInput.trim()) return;
    try {
      const payload = await encrypt(momentInput.trim(), key);
      await push(ref(db, `rooms/${roomId}/moments`), { ...payload, senderId: user.uid, expiresAt: Date.now() + 86_400_000 });
      setMomentInput("");
    } catch { setError("Could not publish moment."); }
  };

  // Delete message
  const deleteMessage = useCallback(async (id: string) => {
    try {
      await remove(ref(db, `rooms/${roomId}/messages/${id}`));
    } catch {
      setError("Could not delete message.");
    }
  }, [roomId]);

  const deleteForMe = useCallback(async (id: string) => {
    if (!user) return;
    try {
      await update(ref(db, `rooms/${roomId}/messages/${id}/deletedFor`), { [user.uid]: true });
      setMessages((current) => current.filter((message) => message.id !== id));
    } catch { setError("Could not hide message."); }
  }, [roomId, user]);

  const consumeMedia = useCallback(async (id: string) => {
    if (!user) return;
    try {
      await update(ref(db, `rooms/${roomId}/messages/${id}/consumedBy`), { [user.uid]: Date.now() });
      setMessages((current) => current.map((message) => message.id === id ? { ...message, mediaBlobUrl: null, consumedBy: { ...(message.consumedBy ?? {}), [user.uid]: Date.now() } } : message));
    } catch { setError("Could not consume media."); }
  }, [roomId, user]);

  const editMessage = useCallback(async (message: DecryptedMessage) => {
    if (!key) return;
    const nextText = window.prompt("Edit message", message.plaintext);
    if (nextText === null || !nextText.trim()) return;
    try {
      const payload = await encrypt(nextText.trim(), key);
      await update(ref(db, `rooms/${roomId}/messages/${message.id}`), { ...payload, editedAt: Date.now() });
    } catch { setError("Could not edit message."); }
  }, [key, roomId]);

  const pinMessage = useCallback(async (id: string, pinned: boolean) => {
    try { await update(ref(db, `rooms/${roomId}/messages/${id}`), { pinned }); }
    catch { setError("Could not update pinned message."); }
  }, [roomId]);

  const selectMessage = useCallback((id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }, []);

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
      if (replyingTo) record.replyTo = replyingTo.id;
      if (ghostLifetime) record.expiresAt = Date.now() + ghostLifetime;
      if (conversationMode === "BURST") record.expiresAt = Date.now() + 60_000;
      if (mediaFile) {
        const bytes = new Uint8Array(await mediaFile.arrayBuffer());
        const { data, iv } = await encryptBytes(bytes, key);
        record.mediaData = data;
        record.mediaIv = iv;
        record.mediaType = mediaFile.type.startsWith("image/") ? "image" : "video";
        record.msgType = record.mediaType;
        record.expiresAt = Date.now() + MEDIA_EXPIRY_MS;
        record.viewOnce = viewOnce;
      }
      await push(ref(db, `rooms/${roomId}/messages`), record);
      setInput("");
      setReplyingTo(null);
      clearMedia();
    } catch {
      setError("Message could not be encrypted/sent.");
    } finally {
      setSending(false);
    }
  }

  const visibleMessages = messages.filter((message) => !search.trim() || message.plaintext.toLowerCase().includes(search.trim().toLowerCase()));

  if (!key) return null;

  return (
    <main
      className="chat-page"
      onPointerDown={(event) => {
        if (showOverflowMenu && overflowMenuRef.current && !overflowMenuRef.current.contains(event.target as Node)) {
          setShowOverflowMenu(false);
          setShowPrivacySettings(false);
          setShowMomentsPanel(false);
        }
      }}
      style={{ WebkitUserSelect: "none", userSelect: "none" } as React.CSSProperties}
    >
      {/* Header */}
      <header className="chat-header">
        <div className="header-info">
          <span className="chat-avatar">🔐</span>
          <div className="header-text">
            <h1 className="header-title">Private room</h1>
            <p className="header-subtitle">
              🔐 End-to-end encrypted
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => { lock(); router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`); }}
            className="header-icon-btn"
            title="Lock chat"
            aria-label="Lock chat"
          >
            🔒
          </button>
          <div className="relative" ref={overflowMenuRef}>
            <button
              type="button"
              onClick={() => setShowOverflowMenu((open) => !open)}
              className="header-icon-btn"
              title="Chat options"
              aria-label="Open chat options"
              aria-expanded={showOverflowMenu}
            >
              ⋮
            </button>
            {showOverflowMenu && (
              <div className="chat-overflow-menu" onPointerDown={(event) => event.stopPropagation()}>
                <button type="button" onClick={() => setShowPrivacySettings((open) => !open)} className="chat-menu-item">Privacy & disappearing</button>
                <button type="button" onClick={() => { setShowSearch(true); setShowOverflowMenu(false); }} className="chat-menu-item">Search messages</button>
                <button type="button" onClick={() => setShowOverflowMenu(false)} className="chat-menu-item">Pinned messages</button>
                <button type="button" onClick={() => setShowOverflowMenu(false)} className="chat-menu-item">Media</button>
                <button type="button" onClick={() => setShowMomentsPanel((open) => !open)} className="chat-menu-item">Moments</button>
                {selectedIds.length > 0 && <button type="button" onClick={() => { void Promise.all(selectedIds.map(deleteForMe)); setSelectedIds([]); setShowOverflowMenu(false); }} className="chat-menu-item">Hide selected ({selectedIds.length})</button>}
                {unread > 0 && <button type="button" onClick={() => { setUnread(0); setShowOverflowMenu(false); }} className="chat-menu-item">Mark {unread} unread as seen</button>}
                <button type="button" onClick={() => { lock(); router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`); }} className="chat-menu-item chat-menu-item-danger">Lock chat</button>
                {showPrivacySettings && (
                  <div className="privacy-settings">
                    <label>Disappearing messages
                      <select value={ghostLifetime === null ? "keep" : String(ghostLifetime)} onChange={(event) => void updateGhostLifetime(event.target.value)}>
                        <option value="keep">Off</option>
                        <option value="10000">10 seconds</option>
                        <option value="60000">1 minute</option>
                        <option value="600000">10 minutes</option>
                        <option value="3600000">1 hour</option>
                        <option value="86400000">24 hours</option>
                      </select>
                    </label>
                    <label>Conversation mode
                      <select value={conversationMode} onChange={(event) => void updateConversationMode(event.target.value as ConversationMode)}>
                        {(["NORMAL", "GHOST", "BURST", "VAULT", "STEALTH", "LIVE"] as ConversationMode[]).map((mode) => <option key={mode}>{mode}</option>)}
                      </select>
                    </label>
                    <label className="privacy-checkbox"><input type="checkbox" checked={viewOnce} onChange={(event) => setViewOnce(event.target.checked)} /> View once media</label>
                    <button type="button" onClick={() => void toggleDisappearing()} disabled={disappearingLoading} className="privacy-action">{disappearing ? "Turn off 24h chat" : "Turn on 24h chat"}</button>
                    <button type="button" onClick={() => void startGhostSession(60 * 60 * 1000)} className="privacy-action">Start 1h live session</button>
                  </div>
                )}
                {showMomentsPanel && (
                  <div className="privacy-settings moments-panel">
                    <div className="moments-heading"><strong>Moments</strong><span>expire after 24h</span></div>
                    <div className="moments-list">{moments.map((moment) => <article key={moment.id}><p>{moment.text}</p><small>{moment.senderId === user?.uid ? "You" : "Room member"}</small></article>)}</div>
                    <div className="moments-compose"><input value={momentInput} onChange={(event) => setMomentInput(event.target.value)} placeholder="Share a temporary text moment" /><button type="button" onClick={() => void sendMoment()} disabled={!momentInput.trim()}>Post</button></div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {showSearch && <div className="search-bar"><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search this room" aria-label="Search messages" /><button type="button" onClick={() => { setSearch(""); setShowSearch(false); }} aria-label="Close search">×</button></div>}

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
          {visibleMessages.map((m) => (
            <MessageBubble
              key={m.id}
              m={m}
              isMine={m.senderId === user?.uid}
              revealed={revealed}
              keyword={keyword}
              onDelete={deleteMessage}
              onDeleteForMe={deleteForMe}
              onConsume={consumeMedia}
              onReact={reactToMessage}
              onReply={(message) => { setReplyingTo(message); setEditing(null); }}
              onEdit={(message) => { setEditing(message); void editMessage(message); }}
              onPin={pinMessage}
              onSelect={selectMessage}
              selected={selectedIds.includes(m.id)}
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
          {(replyingTo || editing) && <div className="composer-context">{editing ? "Editing message" : `Replying to ${replyingTo?.plaintext.slice(0, 50)}`} <button type="button" onClick={() => { setReplyingTo(null); setEditing(null); }}>Cancel</button></div>}
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
              onChange={(e) => { setInput(e.target.value); setTyping(true); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(e as unknown as FormEvent); }
              }}
              rows={1}
              placeholder={mediaFile ? "Add a caption… (optional)" : "Write a message…"}
              className="composer-input"
              style={{ userSelect: "text" } as React.CSSProperties}
            />

            {/* One display-mode control shared by desktop and mobile */}
            <div className="mode-switch mode-switch-display" role="group" aria-label="Display mode">
              <button type="button" onClick={() => setRevealed(false)} className={!revealed ? "mode-active" : "mode-option"}>Coded</button>
              <button type="button" onClick={() => setRevealed(true)} className={revealed ? "mode-active" : "mode-option"}>Revealed</button>
            </div>

            {/* Send */}
            <button disabled={sending || (!input.trim() && !mediaFile)} className="btn-send">
              {sending ? "…" : "Send"}
            </button>
          </div>

          {otherTyping && <div className="typing-status" role="status">Someone is typing</div>}
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
