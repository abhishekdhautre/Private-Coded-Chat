"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { onChildAdded, onChildChanged, onChildRemoved, onValue, push, ref, remove, update, get, set } from "firebase/database";
import { AuthGuard } from "@/components/AuthGuard";
import { useAuth } from "@/contexts/AuthContext";
import { useCrypto } from "@/contexts/CryptoContext";
import { db } from "@/lib/firebase";
import { decrypt, decryptBytes, encrypt, encryptBytes } from "@/lib/crypto";
import { encodeText, resolveDisplayKeyword } from "@/lib/cipher";
import { isDuplicateDelivery } from "@/lib/messageDedupe";
import { singleFlight } from "@/lib/singleFlight";
import type { InFlightRun } from "@/lib/singleFlight";
import { mergeIncomingMessage, partitionExpired } from "@/lib/chatMerge";
import {
  loadNotifyMuted,
  saveNotifyMuted,
  loadBrowserNotifyEnabled,
  saveBrowserNotifyEnabled,
  shouldNotifyMessage,
  unlockNotifyAudio,
  playNotifyTone,
  canUseBrowserNotifications,
  browserNotificationPermission,
  requestBrowserNotificationPermission,
  showChatNotification,
} from "@/lib/notify";
import { isMediaReady, mediaBlobMime, outgoingMediaMime } from "@/lib/mediaMime";
import { ReactionPicker } from "@/components/ReactionPicker";
import { StickerPicker } from "@/components/StickerPicker";
import { GifPicker } from "@/components/GifPicker";
import { CameraCapture } from "@/components/CameraCapture";
import { BrandMark, Icon } from "@/components/Icon";
import type { ConversationMode, DecryptedMessage, StoredMessage, RoomMeta } from "@/types/chat";
import { markChatRead, touchChatMeta, subscribeProfile } from "@/lib/userService";
import type { UserProfile } from "@/types/user";
import {
  receiveMessageV3,
  receiveMessageV2,
  encryptMessageV3,
  MessageDTOV3,
} from "@/lib/messageCryptoV2";
import { acquireV2RoomKey, ensureRoomKeyEnvelopesForMembers } from "@/lib/roomKeyService";

const MEDIA_EXPIRY_MS = 30_000;
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const DISAPPEARING_MS = 24 * 60 * 60 * 1000;

/** Panels opened from the chat settings menu. */
type SheetKind = "search" | "pinned" | "media" | "moments" | "privacy";

/** Existing disappearing-message lifetimes. This is the real supported set. */
const DISAPPEARING_OPTIONS: { value: string; label: string }[] = [
  { value: "keep", label: "Off" },
  { value: "10000", label: "10 seconds" },
  { value: "60000", label: "1 minute" },
  { value: "600000", label: "10 minutes" },
  { value: "3600000", label: "1 hour" },
  { value: "86400000", label: "24 hours" },
];

/**
 * Conversation modes already persisted in room meta.
 * Only modes with real send/receive behaviour are described as such below.
 */
const MODE_HINTS: Record<ConversationMode, string> = {
  NORMAL: "Standard messaging",
  GHOST: "Room label; messages persist normally",
  BURST: "New messages auto-expire after 1 minute",
  VAULT: "Room label; messages persist normally",
  STEALTH: "Room label; messages persist normally",
  LIVE: "Used by live sessions",
};

function timeAgoChat(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Human-readable countdown for a future timestamp. */
function timeUntilChat(ts: number): string {
  const d = ts - Date.now();
  if (d <= 0) return "now";
  if (d < 60_000) return `in ${Math.max(1, Math.ceil(d / 1000))}s`;
  if (d < 3_600_000) return `in ${Math.ceil(d / 60_000)}m`;
  if (d < 86_400_000) return `in ${Math.ceil(d / 3_600_000)}h`;
  return `in ${Math.ceil(d / 86_400_000)}d`;
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
  m, isMine, revealed, keyword, onDelete, onDeleteForMe, onConsume, onReact, onReply, onEdit, onPin, onSelect, selected, myUid,
  highlighted = false, groupStart = true, groupEnd = true, rowRef,
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
  highlighted?: boolean;
  /** True when this message starts a new visual group (new sender / long gap). */
  groupStart?: boolean;
  /** True when this is the final message of its group; controls the timestamp. */
  groupEnd?: boolean;
  rowRef?: (el: HTMLElement | null) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactionOpen, setReactionOpen] = useState(false);
  // Set when the browser fails to decode the decrypted media object URL.
  // Without this a failed <img>/<video> collapses to nothing and the message
  // looks like it never arrived; with it we show the honest placeholder.
  const [mediaDecodeFailed, setMediaDecodeFailed] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const display = revealed ? m.plaintext : encodeText(m.plaintext, keyword);
  const isMedia = !!m.mediaType;
  const isSticker = m.msgType === "sticker";
  const isGif = m.msgType === "gif";

  // A new (or newly decrypted) object URL deserves a fresh decode attempt.
  useEffect(() => { setMediaDecodeFailed(false); }, [m.mediaBlobUrl]);

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
    <div
      ref={rowRef}
      data-message-id={m.id}
      className={`message-row ${isMine ? "items-end" : "items-start"}${groupStart ? "" : " is-group-cont"}${highlighted ? " message-row-highlight" : ""}`}
    >
      <div className={`relative group${groupStart ? " is-group-start" : " is-group-cont"}`}>
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
          {isMedia && m.mediaBlobUrl && !mediaDecodeFailed && (
            <div className="mb-2 sensitive-media">
              {m.mediaType === "image" ? (
                <img
                  src={m.mediaBlobUrl}
                  alt="shared media"
                  className="max-w-[260px] rounded-xl object-cover"
                  draggable={false}
                  onContextMenu={(e) => e.preventDefault()}
                  onClick={() => { if (m.viewOnce && !m.consumedBy?.[myUid]) onConsume(m.id); }}
                  onError={() => {
                    // Safe metadata only: never the payload or the URL contents.
                    console.warn("[chat:media:decode-failed]", {
                      messageId: m.id,
                      mediaType: m.mediaType,
                      mediaMime: m.mediaMime ?? null,
                      hasBlobUrl: !!m.mediaBlobUrl,
                    });
                    setMediaDecodeFailed(true);
                  }}
                />
              ) : (
                <video
                  src={m.mediaBlobUrl}
                  controls
                  className="max-w-[260px] rounded-xl"
                  controlsList="nodownload"
                  draggable={false}
                  onContextMenu={(e) => e.preventDefault()}
                  onError={() => {
                    console.warn("[chat:media:decode-failed]", {
                      messageId: m.id,
                      mediaType: m.mediaType,
                      mediaMime: m.mediaMime ?? null,
                      hasBlobUrl: !!m.mediaBlobUrl,
                    });
                    setMediaDecodeFailed(true);
                  }}
                />
              )}
            </div>
          )}
          {isMedia && (!m.mediaBlobUrl || mediaDecodeFailed) && (
            <p className="text-xs text-slate-500 italic">Media expired or unavailable.</p>
          )}

          {/* Text */}
          {m.replyTo && <p className="mb-1 border-l-2 border-cyan-300/60 pl-2 text-[11px] text-slate-300">Replying to a message</p>}
          {!isSticker && m.plaintext && m.plaintext.trim() !== "" && (
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{display}</p>
          )}

          {/* Meta row — timestamp only on the last message of a group keeps the
              transcript calm without losing context. */}
          {!isSticker && (groupEnd || m.expiresAt || m.pinned) && (
            <div className="chat-meta">
              {groupEnd && (
                <span>{new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              )}
              {isMedia && m.expiresAt && m.expiresAt > Date.now() && <MediaTimer expiresAt={m.expiresAt} />}
              {isMedia && m.expiresAt && <span>· disappears</span>}
              {/* Honest privacy note: a web page cannot block OS screenshots —
                  this states the limitation instead of pretending otherwise. */}
              {isMedia && (m.expiresAt || m.viewOnce) && (
                <span className="privacy-note">For your privacy, screenshots may not be preventable on this device.</span>
              )}
              {m.editedAt && <span>edited</span>}
              {m.pinned && <span>· pinned</span>}
              {m.readBy && Object.keys(m.readBy).length > 1 && <span>· read</span>}
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
  const { key, keyword, lock, isV2, epoch, deviceId, identityPrivateKey, unlockV2 } = useCrypto();
  const [unlockingV2, setUnlockingV2] = useState(false);

  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [input, setInput] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [blurred, setBlurred] = useState(false);
  const [error, setError] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [privacyProtected, setPrivacyProtected] = useState(false);
  const dismissPrivacy = () => setPrivacyProtected(false);
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
  const [notifyMuted, setNotifyMuted] = useState(false);
  const [browserNotifyOn, setBrowserNotifyOn] = useState(false);
  const [disappearingLoading, setDisappearingLoading] = useState(false);
  const [showStickers, setShowStickers] = useState(false);
  const [showGifs, setShowGifs] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [showPrivacySettings, setShowPrivacySettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showMomentsPanel, setShowMomentsPanel] = useState(false);
  // Settings-menu overlay sheet (search / pinned / media / moments / privacy)
  const [activeSheet, setActiveSheet] = useState<SheetKind | null>(null);
  // Message currently flashed after jumping to it from search or pinned panels
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // Transient confirmation for persisted setting changes
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  // Full-screen media viewer
  const [lightbox, setLightbox] = useState<{ url: string; kind: string; viewOnce: boolean } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Map<messageId, blobUrl> — lets us revoke individual URLs without touching others
  const blobUrls = useRef<Map<string, string>>(new Map());
  // In-memory cache of decrypted messages — avoids re-decrypting on metadata-only changes
  const messageCache = useRef<Map<string, DecryptedMessage>>(new Map());
  // UI-level idempotency: messageIds that already decrypted successfully AND
  // were added to the UI for the lifetime of this chat session. A duplicate
  // Firebase delivery of such an id is skipped BEFORE any crypto runs, so a
  // normal redelivery is never misclassified as a cryptographic replay attack.
  // Failed decryptions are deliberately never added (they stay retryable).
  // Keyed by messageId only — never by sequenceNumber.
  const decryptedOkIds = useRef<Set<string>>(new Set());
  // Tracks which roomId the suppression set belongs to (the page component is
  // reused across rooms without remounting, so the set must reset per room).
  const dedupeRoomId = useRef<string>("");
  // Single-flight guard for decryptRow(): at most ONE receive path per
  // messageId at a time. Firebase can deliver the same row twice while the
  // first decrypt is still in flight (child_added racing a peer's read-receipt
  // child_changed, or a listener re-subscription replaying history). Two
  // concurrent receives for one id advance that sender's ratchet chain twice
  // and let the LOSING attempt overwrite an already-decrypted bubble with
  // "Unable to decrypt message." — both callers now await the same promise.
  const inFlightDecrypts = useRef<
    Map<string, InFlightRun<{ msg: DecryptedMessage; decryptOk: boolean; fresh: boolean }>>
  >(new Map());
  // Plaintext of messages THIS device has sent in the current session, recorded
  // just before the row is written to Firebase: the plaintext as sealed, plus
  // every row field that participates in the V3 signature / AAD (ciphertext, iv,
  // sequenceNumber, timestamp) so the echo can be matched against the row.
  // The sender's own local echo therefore renders from the send result instead
  // of re-entering the receive path (a redundant sender-bundle fetch plus a
  // second ratchet step). The stored row is untouched: it stays a normal signed,
  // sequenced V3 message that the other device decrypts through the full
  // verification path. A row that differs in any checked byte falls through to
  // it, where full verification applies.
  const localEchoes = useRef<
    Map<
      string,
      {
        plaintext: string;
        ciphertext: string;
        iv: string;
        sequenceNumber: number;
        timestamp: number;
      }
    >
  >(new Map());
  // Highest V3 sequence number this device has already used in the current
  // (roomId, epoch), taken from row METADATA the moment a row arrives — before
  // any crypto runs. The ratchet chain itself only lives in memory, so after a
  // page load / mobile tab eviction the send chain must be resumed past this
  // floor instead of restarting at 0: reusing a sequence number is rejected by
  // every receiver ("already passed"), including our own Firebase echo.
  // See ensureRatchetSequenceFloor() in lib/ratchetV2.ts.
  const sendSeqFloor = useRef<{ roomId: string; epoch: number; value: number }>({
    roomId: "",
    epoch: 0,
    value: 0,
  });
  // Stable ref so the message listener never needs to re-subscribe when disappearing toggles
  const disappearingRef = useRef(false);
  // Realtime + notification refs. The listener effect subscribes once per
  // (key, roomId, uid) and these mirrors let its callbacks read fresh UI state
  // without re-subscribing.
  // Wall-clock moment THIS subscription attached. Rows older than this are the
  // listener's initial history replay (never notification-worthy); rows at or
  // newer are live arrivals. Reset on every (re)subscribe.
  const subscribedAtRef = useRef(0);
  // MessageIds that already triggered an incoming-message alert this session —
  // guarantees one alert per message even when added + changed handlers share
  // a single-flight decrypt result.
  const notifiedIds = useRef<Set<string>>(new Set());
  // Mirrors of component state for the realtime callbacks (see mirror effect).
  const sendingRef = useRef(false);
  const composingRef = useRef(false);
  const notifyMutedRef = useRef(false);
  const browserNotifyRef = useRef(false);
  const roomLabelRef = useRef("Private room");
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  // Anchors for scroll-to-message from the search / pinned panels
  const messageAnchors = useRef<Map<string, HTMLElement>>(new Map());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Friend profile for header ──────────────────────────────────────────────
  const [friendProfile, setFriendProfile] = useState<UserProfile | null>(null);
  const otherUid = roomId.includes("__")
    ? roomId.split("__").find((id) => id !== user?.uid) ?? null
    : null;

  // ── Display-cipher keyword (cosmetic only, no crypto involvement) ──────────
  // V1 rooms supply a passphrase keyword; V2 rooms do not, and an empty keyword
  // makes encodeText() a no-op, which would leak plaintext in "Coded" mode.
  // Resolve a stable keyword so V2/V3 rows get the same display transformation
  // as V1 rows. Recomputed on every render, so toggling Coded <-> Revealed
  // re-renders already-loaded messages without any re-fetch or re-decryption.
  const displayKeyword = resolveDisplayKeyword(keyword, !!isV2, roomId);

  // Subscribe to friend's profile for live name/avatar/online status
  useEffect(() => {
    if (!otherUid) return;
    return subscribeProfile(otherUid, setFriendProfile);
  }, [otherUid]);

  // Mark chat as read and ensure user's own userChats entry exists
  useEffect(() => {
    if (!user?.uid || !roomId) return;
    const initializeAndMarkRead = async () => {
      if (otherUid) {
        await update(ref(db, `userChats/${user.uid}/${roomId}`), {
          roomId,
          otherUid,
          lastMessageAt: Date.now(),
          unread: 0,
        });
      }
      await markChatRead(roomId, user.uid);
    };
    initializeAndMarkRead();
  }, [user?.uid, roomId, otherUid]);

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

  // ── Overlay management: Escape closes lightbox → sheet → menu (in order) ──
  useEffect(() => {
    if (!showOverflowMenu && !activeSheet && !lightbox) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (lightbox) {
        setLightbox(null);
        return;
      }
      if (activeSheet) {
        setActiveSheet(null);
        setShowSearch(false);
        setSearch("");
        setShowMomentsPanel(false);
        setShowPrivacySettings(false);
        return;
      }
      setShowOverflowMenu(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showOverflowMenu, activeSheet, lightbox]);

  // Lock body scroll while a sheet or lightbox is open
  useEffect(() => {
    if (!activeSheet && !lightbox) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [activeSheet, lightbox]);

  // Clear pending highlight/toast timers on unmount
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const closeOverflowMenu = useCallback(() => {
    setShowOverflowMenu(false);
  }, []);

  const openSheet = useCallback((kind: SheetKind) => {
    setShowOverflowMenu(false);
    setActiveSheet(kind);
    if (kind === "search") setShowSearch(true);
    if (kind === "moments") setShowMomentsPanel(true);
    if (kind === "privacy") setShowPrivacySettings(true);
  }, []);

  const closeSheet = useCallback(() => {
    setActiveSheet(null);
    setShowSearch(false);
    setSearch("");
    setShowMomentsPanel(false);
    setShowPrivacySettings(false);
  }, []);

  const showToast = useCallback((message: string) => {
    setToastMsg(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(null), 2600);
  }, []);

  /** Scroll a message into view and flash it. Uses existing decrypted messages only. */
  const jumpToMessage = useCallback(
    (id: string) => {
      setHighlightedId(id);
      const node = messageAnchors.current.get(id);
      if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 2200);
      // Close the panel so the flashed message is actually visible.
      setActiveSheet(null);
      setShowSearch(false);
      setSearch("");
    },
    []
  );

  // ── Derived collections (all from already-decrypted local messages) ────────
  const pinnedMessages = useMemo(
    () => messages.filter((m) => m.pinned).slice().reverse(),
    [messages]
  );

  const mediaItems = useMemo(
    () => messages.filter((m) => !!m.mediaBlobUrl && (m.mediaType === "image" || m.mediaType === "video")),
    [messages]
  );
  const mediaImages = useMemo(() => mediaItems.filter((m) => m.mediaType === "image"), [mediaItems]);
  const mediaVideos = useMemo(() => mediaItems.filter((m) => m.mediaType === "video"), [mediaItems]);

  // Client-side search only — plaintext is never sent anywhere.
  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return messages.filter((m) => m.plaintext.toLowerCase().includes(query));
  }, [messages, search]);

  const openMediaViewer = useCallback(
    (item: DecryptedMessage) => {
      if (!item.mediaBlobUrl) return;
      // Preserve the existing view-once consumption flow.
      if (item.viewOnce && !item.consumedBy?.[user?.uid ?? ""]) {
        void consumeMedia(item.id);
      }
      setLightbox({ url: item.mediaBlobUrl, kind: item.mediaType === "video" ? "video" : "image", viewOnce: !!item.viewOnce });
    },
    [user?.uid]
  );

  // Automatic unlock for V2 rooms or redirect to unlock for V1 rooms
  useEffect(() => {
    if (key) return;

    let mounted = true;
    (async () => {
      try {
        const metaSnap = await get(ref(db, `rooms/${roomId}/meta`));
        if (!metaSnap.exists()) {
          router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`);
          return;
        }
        const meta = metaSnap.val();
        if (meta?.version === "v2_e2ee") {
          if (mounted) setUnlockingV2(true);
          try {
            const res = await acquireV2RoomKey(roomId, meta.currentEpoch || 1);
            if (mounted) {
              unlockV2?.(res);
            }
          } catch {
            if (mounted) {
              setError("Unable to unlock this encrypted conversation on this device.");
            }
          } finally {
            if (mounted) setUnlockingV2(false);
          }
        } else {
          setMessages([]);
          messageCache.current.clear();
          decryptedOkIds.current.clear();
          for (const u of blobUrls.current.values()) URL.revokeObjectURL(u);
          blobUrls.current.clear();
          router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`);
        }
      } catch {
        router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [key, router, roomId, unlockV2]);

  // Sync envelopes for other room participants in the background
  useEffect(() => {
    if (!isV2 || !key || !user || !otherUid) return;
    console.info("[page:ensureEnvelopes:start]", { roomId, myUid: user.uid, otherUid, epoch: epoch || 1 });
    ensureRoomKeyEnvelopesForMembers({
      roomId,
      roomMasterKey: key,
      currentEpoch: epoch || 1,
      myUid: user.uid,
      otherUid,
    })
      .then(() => console.info("[page:ensureEnvelopes:complete]", { roomId }))
      .catch((err) => console.warn("[page:ensureEnvelopes:error]", { roomId, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
  }, [isV2, key, user, otherUid, roomId, epoch]);

  // Lock on tab hidden
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") { setBlurred(true); setPrivacyProtected(true); lock(); }
      else { setBlurred(false); }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [lock]);

  // Revoke blobs on unmount
  useEffect(() => {
    return () => {
      for (const u of blobUrls.current.values()) URL.revokeObjectURL(u);
      blobUrls.current.clear();
      messageCache.current.clear();
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

  // Keep disappearingRef in sync so the message listener can read it without being in its deps
  useEffect(() => { disappearingRef.current = disappearing; }, [disappearing]);

  // Load notification preferences once (local only — never message data).
  useEffect(() => {
    setNotifyMuted(loadNotifyMuted());
    setBrowserNotifyOn(loadBrowserNotifyEnabled());
  }, []);

  // Unlock the Web Audio notification tone on first user interaction so later
  // incoming-message sounds comply with browser autoplay policies.
  useEffect(() => {
    window.addEventListener("pointerdown", unlockNotifyAudio);
    window.addEventListener("keydown", unlockNotifyAudio);
    window.addEventListener("touchstart", unlockNotifyAudio);
    return () => {
      window.removeEventListener("pointerdown", unlockNotifyAudio);
      window.removeEventListener("keydown", unlockNotifyAudio);
      window.removeEventListener("touchstart", unlockNotifyAudio);
    };
  }, []);

  // Mirror render state into refs so the realtime listener callbacks (which
  // must NOT re-subscribe on every keystroke) always read fresh values.
  useEffect(() => {
    sendingRef.current = sending;
    composingRef.current = input.trim().length > 0;
    notifyMutedRef.current = notifyMuted;
    browserNotifyRef.current = browserNotifyOn;
    roomLabelRef.current = friendProfile?.displayName ?? "Private room";
  });

  // Subscribe to messages — incremental onChild* listeners, exactly ONE active
  // subscription per room/user/key while mounted.
  // - Deps use the stable `user?.uid` STRING, not the `user` object: Firebase
  //   re-emits new User object identities (and any parent re-render does too),
  //   and each re-subscription replays the FULL message history through
  //   decryptRow. That replay is what produced repeated "Replay attack
  //   detected" console errors for already-processed messageIds.
  // - `disappearing` intentionally excluded — read via disappearingRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!key || !user) return;
    // Stable string identity for everything below. (`user` itself is read here
    // for narrowing only; the effect dep is `user?.uid` so object churn can't
    // re-subscribe the listener.)
    const uid = user.uid;
    const cryptoKey = key; // capture non-null for use inside async callbacks
    const msgsPath = `rooms/${roomId}/messages`;

    // New room (the page component is reused across rooms without remounting):
    // reset UI-level suppression so the new room's messages always decrypt.
    if (dedupeRoomId.current !== roomId) {
      dedupeRoomId.current = roomId;
      decryptedOkIds.current.clear();
      localEchoes.current.clear();
      notifiedIds.current.clear();
      sendSeqFloor.current = { roomId: "", epoch: 0, value: 0 };
    }

    // Cutover between history replay and live arrivals for THIS subscription.
    // Rows predating this instant are the listener's initial replay and must
    // never fire incoming-message alerts; rows at/after it are live.
    subscribedAtRef.current = Date.now();
    // Safe diagnostics: identifiers only — proves exactly one active realtime
    // subscription per open room (setup runs once per key/room/uid).
    console.info("[chat:realtime:subscribed]", { roomId, uid });

    // Decrypt a single stored row. Concurrent deliveries of the SAME row (see
    // inFlightDecrypts) are coalesced onto one in-flight run so the receive path
    // — and with it the sender's ratchet chain — is never executed twice at once.
    // Returns whether this call actually ran the decrypt pipeline (`fresh`):
    // a cached/coalesced result is a duplicate delivery for notification purposes.
    function decryptRow(id: string, row: StoredMessage): Promise<{ msg: DecryptedMessage; decryptOk: boolean; fresh: boolean }> {
      const rowAny = row as any;
      // Payload identity: a row whose ciphertext or media payload differs is a
      // genuine edit and must re-decrypt instead of sharing the running result.
      const fingerprint = `${rowAny.ciphertext ?? ""}|${rowAny.mediaData ?? ""}`;
      return singleFlight(inFlightDecrypts.current, id, fingerprint, () =>
        decryptRowPayload(id, row)
      );
    }

    // Decrypt a single stored row, reuse cached blob URL if media payload unchanged
    async function decryptRowPayload(id: string, row: StoredMessage): Promise<{ msg: DecryptedMessage; decryptOk: boolean; fresh: boolean }> {
      const rowAny = row as any;

      // ── Sequence floor (metadata only, runs before any crypto) ────────────
      // Count this device's OWN highest V3 sequence number from the row as
      // soon as it is delivered, so a send issued while the listener is still
      // replaying history already resumes above it. Rows from other devices
      // have their own chain; rows from another epoch have their own key space.
      if (
        rowAny.cryptoVersion === "v3_ratchet" &&
        rowAny.senderId === uid &&
        rowAny.senderDeviceId === deviceId &&
        typeof rowAny.sequenceNumber === "number" &&
        Number.isFinite(rowAny.sequenceNumber)
      ) {
        const rowEpoch = typeof rowAny.epoch === "number" ? rowAny.epoch : 1;
        const current = sendSeqFloor.current;
        const sameScope = current.roomId === roomId && current.epoch === rowEpoch;
        const base = sameScope ? current.value : 0;
        sendSeqFloor.current = {
          roomId,
          epoch: rowEpoch,
          value: Math.max(base, rowAny.sequenceNumber + 1),
        };
      }

      const now = Date.now();
      if (row.expiresAt && row.expiresAt <= now) {
        // Safe diagnostics: identifiers/timings only — tells us whether the row
        // arrived after its disappearing window (slow upload / late delivery).
        console.info("[chat:message-expired]", {
          messageId: id,
          mediaType: row.mediaType ?? null,
          hasMedia: !!row.mediaData,
          sentAt: row.timestamp ?? null,
          expiresAt: row.expiresAt,
          latenessMs: now - row.expiresAt,
        });
        remove(ref(db, `${msgsPath}/${id}`)).catch(() => {});
        throw new Error("expired");
      }
      if (row.deletedFor?.[uid]) throw new Error("deleted-for-me");

      // Idempotency gate: this messageId already decrypted successfully and is
      // in the UI cache with identical ciphertext/media — a duplicate delivery
      // (listener re-attach, StrictMode remount). Return the cache WITHOUT
      // touching crypto, so it is never misreported as a replay attack.
      // Failures are never in decryptedOkIds, so they stay retryable; edits
      // (changed ciphertext/media) always re-decrypt. A row whose media never
      // produced an object URL is also NOT considered processed, so the media
      // pipeline is retried on redelivery instead of being stuck forever.
      const preCached = messageCache.current.get(id);
      if (
        preCached &&
        isDuplicateDelivery({
          cached: preCached,
          decryptedSuccessfully:
            decryptedOkIds.current.has(id) &&
            isMediaReady(preCached, preCached.mediaBlobUrl),
          row: rowAny,
        })
      ) {
        // Served from the already-decrypted UI cache: a duplicate delivery, not
        // a fresh decrypt — callers must not treat this as a new arrival.
        return { msg: preCached, decryptOk: false, fresh: false };
      }

      let plaintext: string;
      let decryptOk = false;
      // ── Local echo: this device sealed this exact message moments ago ─────
      // The plaintext we just encrypted is still in memory, so the sender's own
      // Firebase echo renders from the SEND RESULT instead of running the
      // receive path again (a redundant sender-bundle fetch plus a second
      // ratchet step on a row we already know). Nothing is bypassed for anyone
      // else: the stored row stays an ordinary signed + sequenced V3 message and
      // the PEER still verifies signature, sequence, replay and the AES-GCM tag
      // before rendering it. The row must match what we sealed on every field
      // covered by the signature and AAD — if any of it differs we fall through
      // to the normal path, where full verification applies.
      const echo =
        typeof rowAny.messageId === "string" &&
        rowAny.senderId === uid &&
        rowAny.senderDeviceId === deviceId
          ? localEchoes.current.get(rowAny.messageId)
          : undefined;
      if (
        echo &&
        echo.ciphertext === rowAny.ciphertext &&
        echo.iv === rowAny.iv &&
        echo.sequenceNumber === rowAny.sequenceNumber &&
        echo.timestamp === rowAny.timestamp
      ) {
        console.info("[chat:v3:local-echo]", {
          messageId: rowAny.messageId,
          epoch: rowAny.epoch ?? null,
          sequenceNumber: rowAny.sequenceNumber ?? null,
          senderDeviceId: rowAny.senderDeviceId,
        });
        plaintext = echo.plaintext;
        decryptOk = true;
      } else if (rowAny.cryptoVersion === "v3_ratchet") {
        try {
          plaintext = await receiveMessageV3({
            message: rowAny,
            epochKey: cryptoKey,
          });
          decryptOk = true;
        } catch (err) {
          // Safe diagnostics: identifiers and stage markers only, never secrets.
          console.warn("[chat:v3-decrypt-failed]", {
            messageId: rowAny.messageId ?? id,
            senderUid: rowAny.senderUid,
            senderDeviceId: rowAny.senderDeviceId,
            currentUid: uid,
            currentDeviceId: deviceId,
            epoch: rowAny.epoch,
            sequenceNumber: rowAny.sequenceNumber,
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          });
          plaintext = "Unable to decrypt message.";
        }
      } else if (rowAny.cryptoVersion === "v2" || (rowAny.senderDeviceId && rowAny.signature)) {
        try {
          plaintext = await receiveMessageV2({
            message: rowAny,
            roomMasterKey: cryptoKey,
          });
          decryptOk = true;
        } catch {
          plaintext = "Unable to decrypt message.";
        }
      } else {
        try {
          plaintext = await decrypt(row.ciphertext, row.iv, cryptoKey);
          decryptOk = true;
        } catch {
          plaintext = "Unable to decrypt message.";
        }
      }

      const cached = messageCache.current.get(id);
      let mediaBlobUrl: string | null = cached?.mediaBlobUrl ?? null;
      if (row.mediaData && row.mediaIv && row.mediaType) {
        // Re-run when the payload changed OR when a previous attempt never
        // produced a usable object URL — a media failure must stay retryable.
        const mediaChanged = !cached || cached.mediaData !== row.mediaData || !cached.mediaBlobUrl;
        if (mediaChanged) {
          const old = blobUrls.current.get(id);
          if (old) { URL.revokeObjectURL(old); blobUrls.current.delete(id); }
          // Rebuild the Blob with the file's REAL MIME type (image/heic,
          // video/quicktime, …). The legacy "image/jpeg"/"video/mp4" guess made
          // WebKit fail to decode phone-originated media, so the message
          // rendered as nothing at all.
          const blobMime = mediaBlobMime(row);
          try {
            const bytes = await decryptBytes(row.mediaData, row.mediaIv, cryptoKey);
            const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            const url = URL.createObjectURL(new Blob([buf], { type: blobMime }));
            mediaBlobUrl = url;
            blobUrls.current.set(id, url);
            console.info("[chat:media:blob-ok]", {
              messageId: id,
              mediaType: row.mediaType,
              mediaMime: row.mediaMime ?? null,
              blobMime,
              encryptedBase64Length: row.mediaData.length,
              plainByteLength: bytes.byteLength,
            });
          } catch (err) {
            mediaBlobUrl = null;
            console.warn("[chat:media:decrypt-failed]", {
              messageId: id,
              mediaType: row.mediaType,
              mediaMime: row.mediaMime ?? null,
              blobMime,
              encryptedBase64Length: row.mediaData.length,
              error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            });
          }
        } else {
          console.info("[chat:media:reused-blob]", { messageId: id, mediaType: row.mediaType });
        }
      }

      const msg: DecryptedMessage = { ...row, id, plaintext, mediaBlobUrl };
      messageCache.current.set(id, msg);
      // Only a message that decrypted AND produced its media object URL
      // suppresses future duplicate deliveries. Otherwise a transient media
      // failure would be cached as "processed" and the photo could never be
      // rendered on a later redelivery.
      if (decryptOk && isMediaReady(row, mediaBlobUrl)) decryptedOkIds.current.add(id);
      return { msg, decryptOk, fresh: true };
    }

    // Only write readBy if this user hasn't already marked it
    function markRead(msg: DecryptedMessage) {
      if (msg.senderId === uid || msg.readBy?.[uid]) return;
      update(ref(db), { [`${msgsPath}/${msg.id}/readBy/${uid}`]: Date.now() }).catch(() => {});
    }

    const unsubAdded = onChildAdded(ref(db, msgsPath), async (snap) => {
      const id = snap.key!;
      const row = snap.val() as StoredMessage;
      const rowAnyDiag = row as any;
      // Safe diagnostics: delivery identifiers only — never content or keys.
      console.info("[chat:realtime:child-added]", {
        messageId: id,
        senderUid: rowAnyDiag.senderUid ?? rowAnyDiag.senderId ?? null,
        timestamp: row.timestamp ?? null,
        hasMedia: !!row.mediaData,
      });
      // Already decrypted + rendered with identical payload: duplicate delivery
      // from a listener re-attach. Ignore silently (no crypto, no console noise).
      // A row whose media never produced an object URL is not "processed", so
      // it falls through and the media pipeline is retried.
      const already = messageCache.current.get(id);
      if (
        already &&
        isDuplicateDelivery({
          cached: already,
          decryptedSuccessfully: decryptedOkIds.current.has(id) && isMediaReady(already, already.mediaBlobUrl),
          row: row as any,
        })
      ) {
        return;
      }
      try {
        const { msg, decryptOk, fresh } = await decryptRow(id, row);
        markRead(msg);
        if (disappearingRef.current) {
          update(ref(db), { [`rooms/${roomId}/meta/disappearingViewedAt/${uid}`]: Date.now() }).catch(() => {});
        }
        if (row.mediaData) {
          // Safe metadata: confirms the row reached React state and whether
          // the object URL survived reconstruction.
          console.info("[chat:message:added]", {
            messageId: id,
            mediaType: row.mediaType ?? null,
            mediaMime: row.mediaMime ?? null,
            hasBlobUrl: !!msg.mediaBlobUrl,
            viewOnce: !!row.viewOnce,
            expiresAt: row.expiresAt ?? null,
          });
        }
        setMessages((prev) => {
          // Pure merge: insert-or-ignore by messageId, timestamp-sorted. The
          // same reference comes back for duplicates, so React bails out and
          // no duplicate bubble is ever created — whether this row arrived as
          // history replay, live realtime, or both interleaved.
          const next = mergeIncomingMessage(prev, msg);
          if (next === prev) return prev;
          if (document.visibilityState !== "visible") setUnread((c) => c + 1);
          return next;
        });
        console.info("[chat:realtime:state-add]", {
          messageId: id,
          messageCount: messageCache.current.size,
        });
        // Incoming-message alerts: remote + decrypt-ok + live + first delivery
        // only. History replay (predates this subscription), own echoes,
        // duplicates and failures stay silent.
        const isHistorical = !(
          typeof row.timestamp === "number" &&
          row.timestamp >= subscribedAtRef.current
        );
        if (fresh && !isHistorical) {
          const decision = shouldNotifyMessage({
            isOwnMessage: msg.senderId === uid,
            decryptOk,
            isDuplicateDelivery: notifiedIds.current.has(id),
            isHistorical: false,
            muted: notifyMutedRef.current,
            isSending: sendingRef.current || composingRef.current,
            alreadyNotified: false,
          });
          let played = false;
          if (decision.notify) {
            notifiedIds.current.add(id);
            played = playNotifyTone();
            try {
              navigator.vibrate?.(60);
            } catch {
              // Haptics unavailable — sound already handled above.
            }
            // Browser notification only when the chat isn't visible, only when
            // the user opted in, and only with content-free text (never the
            // message body). Clicking focuses/opens the room.
            if (
              browserNotifyRef.current &&
              browserNotificationPermission() === "granted" &&
              typeof document !== "undefined" &&
              document.visibilityState !== "visible"
            ) {
              showChatNotification({
                roomId,
                onOpen: (rid) => {
                  try {
                    window.focus();
                  } catch {
                    // Focusing is best-effort.
                  }
                  router.push(`/chat/${encodeURIComponent(rid)}`);
                },
              });
            }
          }
          // Safe diagnostics: identifiers and outcome only — never content.
          console.info("[chat:notification]", {
            messageId: id,
            played,
            reason: decision.reason,
          });
        }
      } catch (err) {
        // Never swallow silently: distinguish the intentional skips
        // (expired / deleted-for-me) from anything unexpected.
        const reason = err instanceof Error ? err.message : String(err);
        if (reason !== "expired" && reason !== "deleted-for-me") {
          console.warn("[chat:message:add-failed]", {
            messageId: id,
            mediaType: row.mediaType ?? null,
            hasMedia: !!row.mediaData,
            reason,
          });
        }
      }
    });

    const unsubChanged = onChildChanged(ref(db, msgsPath), async (snap) => {
      const id = snap.key!;
      const row = snap.val() as StoredMessage;

      if (row.deletedFor?.[uid]) {
        messageCache.current.delete(id);
        decryptedOkIds.current.delete(id);
        const old = blobUrls.current.get(id);
        if (old) { URL.revokeObjectURL(old); blobUrls.current.delete(id); }
        setMessages((prev) => prev.filter((m) => m.id !== id));
        return;
      }

      const cached = messageCache.current.get(id);
      // Metadata-only change (readBy, reactions, pinned…) — patch without decrypting.
      // Only when the cached media object URL is usable; otherwise fall through
      // and retry the media pipeline.
      if (
        cached &&
        cached.ciphertext === row.ciphertext &&
        cached.mediaData === row.mediaData &&
        isMediaReady(cached, cached.mediaBlobUrl)
      ) {
        const updated: DecryptedMessage = { ...cached, ...row, id, plaintext: cached.plaintext, mediaBlobUrl: cached.mediaBlobUrl };
        messageCache.current.set(id, updated);
        setMessages((prev) => prev.map((m) => m.id === id ? updated : m));
        return;
      }

      try {
        const { msg } = await decryptRow(id, row);
        setMessages((prev) => prev.map((m) => m.id === id ? msg : m));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (reason !== "expired" && reason !== "deleted-for-me") {
          console.warn("[chat:message:change-failed]", {
            messageId: id,
            mediaType: row.mediaType ?? null,
            hasMedia: !!row.mediaData,
            reason,
          });
        }
        messageCache.current.delete(id);
        decryptedOkIds.current.delete(id);
        setMessages((prev) => prev.filter((m) => m.id !== id));
      }
    });

    const unsubRemoved = onChildRemoved(ref(db, msgsPath), (snap) => {
      const id = snap.key!;
      messageCache.current.delete(id);
      decryptedOkIds.current.delete(id);
      const old = blobUrls.current.get(id);
      if (old) { URL.revokeObjectURL(old); blobUrls.current.delete(id); }
      setMessages((prev) => prev.filter((m) => m.id !== id));
    });

    return () => {
      // Safe diagnostics: cleanup runs only when the room/user/key genuinely
      // changes or the component unmounts — never on renders or keystrokes.
      console.info("[chat:realtime:unsubscribed]", { roomId });
      unsubAdded();
      unsubChanged();
      unsubRemoved();
    };
  // `disappearing` deliberately omitted — read via disappearingRef.
  // `user` deliberately omitted in favour of the stable `user?.uid` string —
  // the User object identity churns and must not re-subscribe the listener.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, roomId, user?.uid]);

  // Typing presence — debounced. Does NOT re-subscribe on every keystroke.
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!key || !user) return;
    const presencePath = `rooms/${roomId}/presence/${user.uid}`;
    if (typing) {
      update(ref(db), { [presencePath]: { typing: true, at: Date.now() } }).catch(() => {});
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => setTyping(false), 2000);
    } else {
      remove(ref(db, presencePath)).catch(() => {});
    }
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [key, roomId, typing, user]);

  // Clear typing presence on unmount (leaving chat)
  useEffect(() => {
    if (!key || !user) return;
    const presencePath = `rooms/${roomId}/presence/${user.uid}`;
    return () => { remove(ref(db, presencePath)).catch(() => {}); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

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

  // Client-side expiry sweep (disappearing / 30s media). This interval only
  // enforces expiry of rows ALREADY in state — it never fetches messages and
  // is not a realtime mechanism; realtime delivery stays purely event-driven.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setMessages((prev) => {
        const { kept, expired } = partitionExpired(prev, now);
        expired.forEach((m) => {
          remove(ref(db, `rooms/${roomId}/messages/${m.id}`)).catch(() => {});
          // Revoke the decrypted object URL so expired media bytes are
          // released and can never be rendered again from a stale URL.
          const u = blobUrls.current.get(m.id);
          if (u) { URL.revokeObjectURL(u); blobUrls.current.delete(m.id); }
          messageCache.current.delete(m.id);
          decryptedOkIds.current.delete(m.id);
        });
        return kept;
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

  // Toggle 24h disappearing chat
  const toggleDisappearing = async () => {
    if (!user) return;
    setDisappearingLoading(true);
    const next = !disappearing;
    try {
      await update(ref(db, `rooms/${roomId}/meta`), {
        disappearing: next,
        disappearingViewedAt: null,
      });
      showToast(next ? "24h chat enabled" : "24h chat turned off");
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
      const label = DISAPPEARING_OPTIONS.find((o) => o.value === value)?.label ?? "Off";
      showToast(lifetime ? `Messages will disappear after ${label}` : "Disappearing messages off");
    } catch { setError("Could not update ghost mode."); }
  };

  const updateConversationMode = async (mode: ConversationMode) => {
    setConversationMode(mode);
    try {
      await update(ref(db, `rooms/${roomId}/meta`), { mode });
      showToast(`Conversation mode set to ${mode}`);
    }
    catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as Error & { code?: unknown }).code) : "PERMISSION_DENIED";
      setError(`Could not update conversation mode (${code}). Deploy the current Firebase rules if this persists.`);
    }
  };

  const startGhostSession = async (duration: number) => {
    const expiresAt = Date.now() + duration;
    setSessionExpiresAt(expiresAt);
    try {
      await update(ref(db, `rooms/${roomId}/meta`), { mode: "LIVE", sessionExpiresAt: expiresAt });
      showToast("1h live session started");
    }
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
      if (otherUid) await touchChatMeta(roomId, [user.uid, otherUid], user.uid);
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
      if (otherUid) await touchChatMeta(roomId, [user.uid, otherUid], user.uid);
    } catch { setError("Could not send GIF."); }
    finally { setSending(false); }
  };

  // Send message
  async function send(e: FormEvent) {
    e.preventDefault();
    // Guard against duplicate sends (Enter key + click, or rapid Enter presses)
    if (sending) return;
    if ((!input.trim() && !mediaFile) || !key || !user) return;
    setSending(true);
    setError("");
    try {
      if (isV2 && identityPrivateKey && deviceId) {
        let dto: MessageDTOV3;
        // Sequence floor from this device's own room rows (metadata only).
        // Only trusted when it belongs to the room/epoch we are sending into;
        // otherwise 0 — the ratchet chain key space is per (room, epoch).
        const floor = sendSeqFloor.current;
        const minSequenceNumber =
          floor.roomId === roomId && floor.epoch === (epoch || 1) ? floor.value : 0;
        // Exactly the bytes handed to the encryptor — reused for the local-echo
        // entry so the sender's own bubble renders the identical string.
        const outgoingText = input.trim() || " ";
        try {
          dto = await encryptMessageV3({
            roomId,
            epoch: epoch || 1,
            senderUid: user.uid,
            senderDeviceId: deviceId,
            plaintext: outgoingText,
            epochKey: key,
            senderIdentityPrivateKey: identityPrivateKey,
            minSequenceNumber,
          });
          // Safe diagnostics only (no keys/plaintext ever logged)
          console.info("[send:v3:ratchet-ok]", {
            roomId,
            epoch: epoch || 1,
            senderDeviceId: deviceId,
            sequenceNumber: dto.sequenceNumber,
            sequenceFloor: minSequenceNumber,
          });
        } catch (err) {
          console.warn("[send:v3:failed]", {
            roomId,
            isV2: true,
            epoch: epoch || 1,
            deviceId,
            identityPrivateKeyAvailable: !!identityPrivateKey,
            epochRoomKeyAvailable: !!key,
            ratchetInit: "failed",
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          });
          throw err;
        }
        const record: Record<string, unknown> = {
          ...dto,
          senderId: user.uid,
          msgType: "text",
        };
        if (replyingTo) record.replyTo = replyingTo.id;
        if (ghostLifetime) record.expiresAt = Date.now() + ghostLifetime;
        if (conversationMode === "BURST") record.expiresAt = Date.now() + 60_000;
        if (mediaFile) {
          // Same encrypted-media pipeline as V1 rooms: media bytes are sealed
          // with the room key both sides already hold, and the recipient's
          // decryptRow() already decrypts mediaData/mediaIv with that key.
          const mediaKind: "image" | "video" = mediaFile.type.startsWith("image/") ? "image" : "video";
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(await mediaFile.arrayBuffer());
          } catch (err) {
            console.warn("[send:media:read-failed]", {
              roomId,
              mediaType: mediaKind,
              mediaMime: mediaFile.type || null,
              fileByteLength: mediaFile.size,
              error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            });
            throw err;
          }
          let encrypted: { data: string; iv: string };
          try {
            encrypted = await encryptBytes(bytes, key);
          } catch (err) {
            console.warn("[send:media:encrypt-failed]", {
              roomId,
              mediaType: mediaKind,
              mediaMime: mediaFile.type || null,
              plainByteLength: bytes.byteLength,
              error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            });
            throw err;
          }
          record.mediaData = encrypted.data;
          record.mediaIv = encrypted.iv;
          record.mediaType = mediaKind;
          // Persist the picked file's REAL type (image/heic, video/quicktime…)
          // so the receiver rebuilds the Blob with a MIME that actually matches
          // its bytes — otherwise WebKit fails to decode phone-originated media.
          record.mediaMime = outgoingMediaMime(mediaFile.type, mediaKind);
          record.msgType = mediaKind;
          record.expiresAt = Date.now() + MEDIA_EXPIRY_MS;
          record.viewOnce = viewOnce;
          console.info("[send:media:sealed]", {
            roomId,
            messageId: dto.messageId,
            mediaType: mediaKind,
            mediaMime: record.mediaMime,
            plainByteLength: bytes.byteLength,
            encryptedBase64Length: encrypted.data.length,
            expiresAt: record.expiresAt,
            viewOnce: record.viewOnce,
          });
        }
        // Record the sealed payload BEFORE writing: Firebase fires the local
        // `child_added` echo while `set()` is still awaiting, and that echo
        // must find this entry (see the local-echo branch in decryptRow).
        localEchoes.current.set(dto.messageId, {
          plaintext: outgoingText,
          ciphertext: dto.ciphertext,
          iv: dto.iv,
          sequenceNumber: dto.sequenceNumber,
          timestamp: dto.timestamp,
        });
        try {
          await set(ref(db, `rooms/${roomId}/messages/${dto.messageId}`), record);
          // Safe metadata: proves which optional fields actually reached the
          // record that was handed to Firebase (checklist: mediaData, mediaIv,
          // mediaType, expiresAt, viewOnce + the new mediaMime).
          console.info("[send:v3:write-ok]", {
            roomId,
            messageId: dto.messageId,
            hasMediaData: !!record.mediaData,
            hasMediaIv: !!record.mediaIv,
            hasMediaType: !!record.mediaType,
            hasMediaMime: !!record.mediaMime,
            hasExpiresAt: typeof record.expiresAt === "number",
            hasViewOnce: typeof record.viewOnce === "boolean",
          });
        } catch (err) {
          console.warn("[send:v3:write-failed]", {
            roomId,
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          });
          // No row will ever arrive for this id — drop the echo entry so it
          // can't be matched against an unrelated future delivery.
          localEchoes.current.delete(dto.messageId);
          throw err;
        }
        if (otherUid) {
          await touchChatMeta(roomId, [user.uid, otherUid], user.uid);
        }
        setInput("");
        setTyping(false);
        setReplyingTo(null);
        clearMedia();
        return;
      }

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
        const mediaKind: "image" | "video" = mediaFile.type.startsWith("image/") ? "image" : "video";
        const bytes = new Uint8Array(await mediaFile.arrayBuffer());
        const { data, iv } = await encryptBytes(bytes, key);
        record.mediaData = data;
        record.mediaIv = iv;
        record.mediaType = mediaKind;
        // Real MIME type of the picked file — same fidelity fix as V3 rooms so
        // phone-originated HEIC/QuickTime media renders on every device.
        record.mediaMime = outgoingMediaMime(mediaFile.type, mediaKind);
        record.msgType = mediaKind;
        record.expiresAt = Date.now() + MEDIA_EXPIRY_MS;
        record.viewOnce = viewOnce;
        console.info("[send:media:sealed]", {
          roomId,
          mediaType: mediaKind,
          mediaMime: record.mediaMime,
          plainByteLength: bytes.byteLength,
          encryptedBase64Length: data.length,
          expiresAt: record.expiresAt,
          viewOnce: record.viewOnce,
        });
      }
      await push(ref(db, `rooms/${roomId}/messages`), record);
      // Update chat metadata for chat list
      if (otherUid) {
        await touchChatMeta(roomId, [user.uid, otherUid], user.uid);
      }
      setInput("");
      setTyping(false);
      setReplyingTo(null);
      clearMedia();
    } catch (err) {
      // Safe diagnostics only (no keys/plaintext ever logged)
      console.warn("[send:failed]", {
        roomId,
        isV2,
        epoch: epoch || 1,
        deviceId,
        identityPrivateKeyAvailable: !!identityPrivateKey,
        epochRoomKeyAvailable: !!key,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      setError("Message could not be encrypted/sent.");
    } finally {
      setSending(false);
    }
  }

  const visibleMessages = messages.filter((message) => !search.trim() || message.plaintext.toLowerCase().includes(search.trim().toLowerCase()));

  /**
   * Consecutive messages from the same sender within a short window are grouped
   * so the transcript reads as a rhythm rather than a stack of separate blocks.
   */
  const isGroupStart = useCallback((message: DecryptedMessage, index: number): boolean => {
    if (index === 0) return true;
    const previous = visibleMessages[index - 1];
    if (!previous) return true;
    if (previous.senderId !== message.senderId) return true;
    // Break the group across a long silence, or when either side is a sticker.
    if (message.timestamp - previous.timestamp > 5 * 60_000) return true;
    if (message.msgType === "sticker" || previous.msgType === "sticker") return true;
    return false;
  }, [visibleMessages]);

  // Show a proper privacy lock screen instead of a bare icon + error string.
  if (!key) {
    return (
      <main className="lock-page">
        <div className="lock-card">
          <div className="lock-mark">
            <Icon name="lock" size={26} />
          </div>
          {error ? (
            <>
              <h1 className="lock-title">Conversation locked</h1>
              <p className="lock-copy" role="status">{error}</p>
              <button
                type="button"
                className="action-btn action-btn-primary"
                onClick={() => router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`)}
              >
                <Icon name="lockOpen" size={17} />
                Unlock conversation
              </button>
            </>
          ) : unlockingV2 ? (
            <>
              <h1 className="lock-title">Unlocking…</h1>
              <p className="lock-copy">Unwrapping this device&apos;s room key and initialising the message ratchet.</p>
            </>
          ) : (
            <>
              <h1 className="lock-title">Conversation locked</h1>
              <p className="lock-copy">
                Your messages remain encrypted and unavailable until this chat is unlocked on this device.
              </p>
            </>
          )}
          <div className="lock-brand">
            <BrandMark size={22} withWordmark={false} />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main
      className="chat-page"
      onPointerDown={(event) => {
        if (showOverflowMenu && overflowMenuRef.current && !overflowMenuRef.current.contains(event.target as Node)) {
          closeOverflowMenu();
          setShowPrivacySettings(false);
          setShowMomentsPanel(false);
        }
      }}
      style={{ WebkitUserSelect: "none", userSelect: "none" } as React.CSSProperties}
    >
      {/* Header */}
      <header className="chat-header">
        <div className="header-info">
          <span className="chat-avatar">{friendProfile?.photoURL ?? "🔐"}</span>
          <div className="header-text">
            <h1 className="header-title">{friendProfile?.displayName ?? "Private room"}</h1>
            <p className="header-subtitle">
              {isV2 ? (
                friendProfile?.online ? "🟢 Online · 🔒 E2EE" : "🔒 End-to-end encrypted"
              ) : friendProfile
                ? friendProfile.online
                  ? "🟢 Online"
                  : friendProfile.lastSeen
                    ? `Last seen ${timeAgoChat(friendProfile.lastSeen)}`
                    : "🔐 End-to-end encrypted"
                : "🔐 End-to-end encrypted"}
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
            <Icon name="lock" size={19} />
          </button>
          <div className="relative" ref={overflowMenuRef}>
            <button
              type="button"
              onClick={() => setShowOverflowMenu((open) => !open)}
              className={`header-icon-btn${showOverflowMenu ? " header-icon-btn-active" : ""}`}
              title="Chat options"
              aria-label="Open chat options"
              aria-expanded={showOverflowMenu}
              aria-haspopup="menu"
            >
              <Icon name="more" size={19} />
            </button>
            {showOverflowMenu && (
              <div
                className="chat-menu-panel"
                role="menu"
                aria-label="Chat settings"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <div className="chat-menu-head">
                  <h2>Chat settings</h2>
                  <span className="chat-menu-e2ee">
                    <span aria-hidden="true">🔒</span>
                    {isV2 ? "E2EE" : "Encrypted"}
                  </span>
                </div>

                {/* ── CHAT ── */}
                <div className="chat-menu-section" role="group" aria-label="Chat">
                  <p className="chat-menu-section-label">Chat</p>

                  <button type="button" role="menuitem" className="chat-menu-btn" onClick={() => openSheet("search")}>
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name="search" size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">Search messages</span>
                      <span className="chat-menu-hint">Find text in this conversation</span>
                    </span>
                  </button>

                  <button type="button" role="menuitem" className="chat-menu-btn" onClick={() => openSheet("pinned")}>
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name="pin" size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">Pinned messages</span>
                      <span className="chat-menu-hint">
                        {pinnedMessages.length > 0 ? `${pinnedMessages.length} pinned` : "Nothing pinned yet"}
                      </span>
                    </span>
                    {pinnedMessages.length > 0 && <span className="chat-menu-tail">{pinnedMessages.length}</span>}
                  </button>

                  <button type="button" role="menuitem" className="chat-menu-btn" onClick={() => openSheet("media")}>
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name="image" size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">Media</span>
                      <span className="chat-menu-hint">
                        {mediaItems.length > 0 ? `${mediaItems.length} item${mediaItems.length === 1 ? "" : "s"}` : "No media yet"}
                      </span>
                    </span>
                  </button>

                  <button type="button" role="menuitem" className="chat-menu-btn" onClick={() => openSheet("moments")}>
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name="sparkle" size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">Moments</span>
                      <span className="chat-menu-hint">Temporary posts, expire after 24h</span>
                    </span>
                    {moments.length > 0 && <span className="chat-menu-tail">{moments.length}</span>}
                  </button>

                  {selectedIds.length > 0 && (
                    <button type="button" role="menuitem" className="chat-menu-btn" onClick={() => { void Promise.all(selectedIds.map(deleteForMe)); setSelectedIds([]); closeOverflowMenu(); }}>
                      <span className="chat-menu-icon" aria-hidden="true"><Icon name="eyeOff" size={18} /></span>
                      <span className="chat-menu-text">
                        <span className="chat-menu-label">Hide selected</span>
                        <span className="chat-menu-hint">Removes {selectedIds.length} message{selectedIds.length === 1 ? "" : "s"} for you only</span>
                      </span>
                      <span className="chat-menu-tail">{selectedIds.length}</span>
                    </button>
                  )}

                  {unread > 0 && (
                    <button type="button" role="menuitem" className="chat-menu-btn" onClick={() => { setUnread(0); closeOverflowMenu(); showToast("Marked as seen"); }}>
                      <span className="chat-menu-icon" aria-hidden="true"><Icon name="check" size={18} /></span>
                      <span className="chat-menu-text">
                        <span className="chat-menu-label">Mark unread as seen</span>
                        <span className="chat-menu-hint">Clears the unread counter</span>
                      </span>
                      <span className="chat-menu-tail">{unread}</span>
                    </button>
                  )}
                </div>

                {/* ── NOTIFICATIONS ── */}
                <div className="chat-menu-section" role="group" aria-label="Notifications">
                  <p className="chat-menu-section-label">Notifications</p>

                  <button
                    type="button"
                    role="menuitem"
                    className="chat-menu-btn"
                    aria-pressed={!notifyMuted}
                    onClick={() => {
                      const next = !notifyMuted;
                      setNotifyMuted(next);
                      saveNotifyMuted(next);
                      showToast(next ? "Message sounds off" : "Message sounds on");
                    }}
                  >
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name={notifyMuted ? "mute" : "muteFilled"} size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">Message sounds</span>
                      <span className="chat-menu-hint">
                        {notifyMuted ? "Off — new messages stay silent" : "On — plays once for new messages"}
                      </span>
                    </span>
                    <span className="chat-menu-tail">{notifyMuted ? "Off" : "On"}</span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className="chat-menu-btn"
                    aria-pressed={browserNotifyOn}
                    onClick={async () => {
                      // Permission is requested ONLY here, from this intentional
                      // tap — never on page load.
                      if (!canUseBrowserNotifications()) {
                        showToast("Browser notifications not supported here");
                        return;
                      }
                      if (browserNotificationPermission() === "denied") {
                        showToast("Notifications blocked — allow them in browser settings");
                        return;
                      }
                      if (!browserNotifyOn) {
                        const perm = await requestBrowserNotificationPermission();
                        if (perm !== "granted") {
                          showToast("Notification permission not granted");
                          return;
                        }
                        setBrowserNotifyOn(true);
                        saveBrowserNotifyEnabled(true);
                        showToast("Browser notifications on");
                      } else {
                        setBrowserNotifyOn(false);
                        saveBrowserNotifyEnabled(false);
                        showToast("Browser notifications off");
                      }
                    }}
                  >
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name="bell" size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">Notifications</span>
                      <span className="chat-menu-hint">
                        {!canUseBrowserNotifications()
                          ? "Not supported in this browser"
                          : browserNotificationPermission() === "denied"
                            ? "Blocked in browser settings"
                            : browserNotifyOn
                              ? "On — alerts for new messages when hidden"
                              : "Off — alert when the chat is hidden"}
                      </span>
                    </span>
                    <span className="chat-menu-tail">{browserNotifyOn ? "On" : "Off"}</span>
                  </button>
                </div>

                {/* ── PRIVACY ── */}
                <div className="chat-menu-section" role="group" aria-label="Privacy">
                  <p className="chat-menu-section-label">Privacy</p>

                  <button type="button" role="menuitem" className="chat-menu-btn" onClick={() => openSheet("privacy")}>
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name="clock" size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">Disappearing messages</span>
                      <span className="chat-menu-hint">
                        {ghostLifetime === null ? "Off" : `New messages expire in ${DISAPPEARING_OPTIONS.find((o) => o.value === String(ghostLifetime))?.label ?? "custom time"}`}
                      </span>
                    </span>
                    <span className="chat-menu-tail" aria-hidden="true">›</span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className="chat-menu-btn"
                    aria-pressed={viewOnce}
                    aria-current={viewOnce}
                    onClick={() => {
                      setViewOnce((on) => !on);
                      showToast(viewOnce ? "View Once off for this session" : "View Once on for this session");
                    }}
                  >
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name="eye" size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">View once media</span>
                      <span className="chat-menu-hint">
                        {viewOnce ? "On — new media self-destructs after viewing" : "Applies to media sent in this session"}
                      </span>
                    </span>
                    {viewOnce && <span className="chat-menu-tail">On</span>}
                  </button>

                  <button type="button" role="menuitem" className="chat-menu-btn chat-menu-btn-danger" onClick={() => { lock(); router.replace(`/unlock?roomId=${encodeURIComponent(roomId)}`); }}>
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name="lock" size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">Lock chat</span>
                      <span className="chat-menu-hint">Clears keys and hides this conversation</span>
                    </span>
                  </button>
                </div>

                {/* ── CONVERSATION ── */}
                <div className="chat-menu-section" role="group" aria-label="Conversation">
                  <p className="chat-menu-section-label">Conversation</p>

                  <button type="button" role="menuitem" className="chat-menu-btn" onClick={() => openSheet("privacy")}>
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name="sliders" size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">Conversation mode</span>
                      <span className="chat-menu-hint">{MODE_HINTS[conversationMode] ?? conversationMode}</span>
                    </span>
                    <span className="chat-menu-tail" aria-hidden="true">›</span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className="chat-menu-btn"
                    disabled={disappearingLoading}
                    aria-pressed={disappearing}
                    onClick={() => {
                      const next = !disappearing;
                      if (next && !window.confirm("Turn on 24h chat? Once both participants open the chat, all messages in this room are deleted after 24 hours. This cannot be undone.")) return;
                      void toggleDisappearing();
                    }}
                  >
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name="calendar" size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">{disappearing ? "24h chat is on" : "Turn on 24h chat"}</span>
                      <span className="chat-menu-hint">
                        {disappearing ? "Messages are purged 24h after both participants open" : "Deletes room messages after 24h"}
                      </span>
                    </span>
                    {disappearing && <span className="chat-menu-tail">On</span>}
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className="chat-menu-btn"
                    aria-current={!!sessionExpiresAt && sessionExpiresAt > Date.now()}
                    onClick={() => {
                      if (sessionExpiresAt && sessionExpiresAt > Date.now()) {
                        showToast("A live session is already active");
                        return;
                      }
                      void startGhostSession(60 * 60 * 1000);
                    }}
                  >
                    <span className="chat-menu-icon" aria-hidden="true"><Icon name="radio" size={18} /></span>
                    <span className="chat-menu-text">
                      <span className="chat-menu-label">
                        {sessionExpiresAt && sessionExpiresAt > Date.now() ? "Live session active" : "Start 1h live session"}
                      </span>
                      <span className="chat-menu-hint">
                        {sessionExpiresAt && sessionExpiresAt > Date.now()
                          ? `Chat locks ${timeUntilChat(sessionExpiresAt)}`
                          : "Sets a 1 hour session and locks the chat at the end"}
                      </span>
                    </span>
                    {sessionExpiresAt && sessionExpiresAt > Date.now() && <span className="chat-menu-tail">Active</span>}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

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
          {visibleMessages.map((m, index) => (
            <MessageBubble
              key={m.id}
              m={m}
              isMine={m.senderId === user?.uid}
              groupStart={isGroupStart(m, index)}
              groupEnd={index === visibleMessages.length - 1 || isGroupStart(visibleMessages[index + 1], index + 1)}
              revealed={revealed}
              keyword={displayKeyword}
              onDelete={deleteMessage}
              onDeleteForMe={deleteForMe}
              onConsume={consumeMedia}
              onReact={reactToMessage}
              onReply={(message) => { setReplyingTo(message); setEditing(null); }}
              onEdit={(message) => { setEditing(message); void editMessage(message); }}
              onPin={pinMessage}
              onSelect={selectMessage}
              selected={selectedIds.includes(m.id)}
              highlighted={highlightedId === m.id}
              rowRef={(el) => {
                if (el) messageAnchors.current.set(m.id, el);
                else messageAnchors.current.delete(m.id);
              }}
              myUid={user?.uid ?? ""}
            />
          ))}
          <div ref={bottom} />
        </div>
      </section>

      {/* ── Overlay sheets ─────────────────────────────────────────────────── */}
      {activeSheet && (
        <>
          <div
            className="sheet-backdrop"
            onPointerDown={() => closeSheet()}
            aria-hidden="true"
          />
          <div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={
              activeSheet === "search" ? "Search messages"
                : activeSheet === "pinned" ? "Pinned messages"
                : activeSheet === "media" ? "Media"
                : activeSheet === "moments" ? "Moments"
                : "Privacy and conversation settings"
            }
          >
            {/* SEARCH */}
            {activeSheet === "search" && (
              <>
                <div className="sheet-head">
                  <h2 className="sheet-title">
                    Search messages
                    <span className="sheet-sub">
                      {search.trim() === ""
                        ? "Type to search decrypted messages on this device"
                        : `${searchResults.length} match${searchResults.length === 1 ? "" : "es"}`}
                    </span>
                  </h2>
                  <button type="button" className="sheet-close" onClick={closeSheet} aria-label="Close search">×</button>
                </div>
                <div className="sheet-body">
                  <div className="search-bar" style={{ padding: 0, background: "transparent", border: 0 }}>
                    <span aria-hidden="true" style={{ color: "#64748b" }}>🔍</span>
                    <input
                      autoFocus
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search this room"
                      aria-label="Search messages in this conversation"
                    />
                    {search && (
                      <button type="button" onClick={() => setSearch("")} aria-label="Clear search">×</button>
                    )}
                  </div>

                  {search.trim() === "" ? (
                    <div className="sheet-empty">
                      <strong>Search stays on this device</strong>
                      <span>Messages are decrypted locally, so search never sends your plaintext anywhere.</span>
                    </div>
                  ) : searchResults.length === 0 ? (
                    <div className="sheet-empty">
                      <strong>No messages found</strong>
                      <span>Nothing in this conversation matches “{search.trim()}”.</span>
                    </div>
                  ) : (
                    <div className="sheet-list">
                      {searchResults.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="sheet-hit"
                          onClick={() => jumpToMessage(m.id)}
                        >
                          <span className="sheet-hit-text">{m.plaintext}</span>
                          <span className="sheet-hit-meta">
                            <span>{m.senderId === user?.uid ? "You" : (friendProfile?.displayName ?? "Them")}</span>
                            <span aria-hidden="true">·</span>
                            <span>{new Date(m.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* PINNED */}
            {activeSheet === "pinned" && (
              <>
                <div className="sheet-head">
                  <h2 className="sheet-title">
                    Pinned messages
                    <span className="sheet-sub">{pinnedMessages.length} pinned</span>
                  </h2>
                  <button type="button" className="sheet-close" onClick={closeSheet} aria-label="Close pinned messages">×</button>
                </div>
                <div className="sheet-body">
                  {pinnedMessages.length === 0 ? (
                    <div className="sheet-empty">
                      <strong>No pinned messages yet</strong>
                      <span>Open a message’s ⋯ menu and choose “Pin message”.</span>
                    </div>
                  ) : (
                    <div className="sheet-list">
                      {pinnedMessages.map((m) => (
                        <div key={m.id} style={{ display: "grid", gap: "0.3rem" }}>
                          <button type="button" className="sheet-hit" onClick={() => jumpToMessage(m.id)}>
                            <span className="sheet-hit-text">{m.plaintext}</span>
                            <span className="sheet-hit-meta">
                              <span>{m.senderId === user?.uid ? "You" : (friendProfile?.displayName ?? "Them")}</span>
                              <span aria-hidden="true">·</span>
                              <span>{new Date(m.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                            </span>
                          </button>
                          <button
                            type="button"
                            className="chat-menu-btn"
                            style={{ minHeight: "36px" }}
                            onClick={() => { void pinMessage(m.id, false); showToast("Message unpinned"); }}
                          >
                            <span className="chat-menu-icon" aria-hidden="true"><Icon name="pin" size={18} /></span>
                            <span className="chat-menu-text"><span className="chat-menu-label">Unpin</span></span>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* MEDIA */}
            {activeSheet === "media" && (
              <>
                <div className="sheet-head">
                  <h2 className="sheet-title">
                    Media
                    <span className="sheet-sub">{mediaItems.length} item{mediaItems.length === 1 ? "" : "s"} in this chat</span>
                  </h2>
                  <button type="button" className="sheet-close" onClick={closeSheet} aria-label="Close media">×</button>
                </div>
                <div className="sheet-body">
                  {mediaItems.length === 0 ? (
                    <div className="sheet-empty">
                      <strong>No media yet</strong>
                      <span>Images and videos you receive in this chat will appear here.</span>
                    </div>
                  ) : (
                    <>
                      {mediaImages.length > 0 && (
                        <>
                          <p className="sheet-section-label">Images ({mediaImages.length})</p>
                          <div className="media-grid">
                            {mediaImages.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                className="media-tile"
                                onClick={() => openMediaViewer(m)}
                                aria-label={`View image from ${m.senderId === user?.uid ? "you" : "this chat"}`}
                              >
                                <img
                                  src={m.mediaBlobUrl ?? ""}
                                  alt=""
                                  loading="lazy"
                                  draggable={false}
                                  onContextMenu={(e) => e.preventDefault()}
                                />
                                {m.viewOnce && <span className="media-tile-badge">View once</span>}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                      {mediaVideos.length > 0 && (
                        <>
                          <p className="sheet-section-label">Videos ({mediaVideos.length})</p>
                          <div className="media-grid">
                            {mediaVideos.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                className="media-tile"
                                onClick={() => openMediaViewer(m)}
                                aria-label={`Play video from ${m.senderId === user?.uid ? "you" : "this chat"}`}
                              >
                                <video
                                  src={m.mediaBlobUrl ?? ""}
                                  muted
                                  preload="metadata"
                                  draggable={false}
                                  onContextMenu={(e) => e.preventDefault()}
                                />
                                {m.viewOnce && <span className="media-tile-badge">View once</span>}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              </>
            )}

            {/* MOMENTS */}
            {activeSheet === "moments" && (
              <>
                <div className="sheet-head">
                  <h2 className="sheet-title">
                    Moments
                    <span className="sheet-sub">Temporary posts · expire after 24h</span>
                  </h2>
                  <button type="button" className="sheet-close" onClick={closeSheet} aria-label="Close moments">×</button>
                </div>
                <div className="sheet-body">
                  {moments.length === 0 ? (
                    <div className="sheet-empty">
                      <strong>No moments yet</strong>
                      <span>Post a short-lived note below. Moments disappear after 24 hours.</span>
                    </div>
                  ) : (
                    <div className="sheet-list">
                      {moments.map((moment) => (
                        <div key={moment.id} className="sheet-hit" style={{ cursor: "default" }}>
                          <span className="sheet-hit-text">{moment.text}</span>
                          <span className="sheet-hit-meta">
                            <span>{moment.senderId === user?.uid ? "You" : (friendProfile?.displayName ?? "Room member")}</span>
                            <span aria-hidden="true">·</span>
                            <span>expires {timeUntilChat(moment.expiresAt)}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="moments-compose" style={{ marginTop: "0.75rem" }}>
                    <input
                      value={momentInput}
                      onChange={(event) => setMomentInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && momentInput.trim()) {
                          event.preventDefault();
                          void sendMoment();
                        }
                      }}
                      placeholder="Share a temporary text moment"
                      aria-label="Write a moment"
                    />
                    <button type="button" onClick={() => void sendMoment()} disabled={!momentInput.trim()}>Post</button>
                  </div>
                </div>
              </>
            )}

            {/* PRIVACY / CONVERSATION SETTINGS */}
            {activeSheet === "privacy" && (
              <>
                <div className="sheet-head">
                  <h2 className="sheet-title">
                    Privacy &amp; conversation
                    <span className="sheet-sub">Saved to room settings</span>
                  </h2>
                  <button type="button" className="sheet-close" onClick={closeSheet} aria-label="Close settings">×</button>
                </div>
                <div className="sheet-body">
                  <div className="privacy-settings" style={{ margin: 0, padding: 0, borderTop: 0 }}>
                    <label htmlFor="disappear-select">
                      Disappearing messages
                      <select
                        id="disappear-select"
                        value={ghostLifetime === null ? "keep" : String(ghostLifetime)}
                        onChange={(event) => void updateGhostLifetime(event.target.value)}
                      >
                        {DISAPPEARING_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <p className="chat-menu-hint" style={{ marginTop: "-0.35rem" }}>
                      Applies to messages you send. Only the durations listed above are supported.
                    </p>

                    <label htmlFor="mode-select">
                      Conversation mode
                      <select
                        id="mode-select"
                        value={conversationMode}
                        onChange={(event) => void updateConversationMode(event.target.value as ConversationMode)}
                      >
                        {(["NORMAL", "GHOST", "BURST", "VAULT", "STEALTH", "LIVE"] as ConversationMode[]).map((mode) => (
                          <option key={mode} value={mode}>{mode} — {MODE_HINTS[mode]}</option>
                        ))}
                      </select>
                    </label>

                    <label className="privacy-checkbox" htmlFor="view-once-toggle">
                      <input
                        id="view-once-toggle"
                        type="checkbox"
                        checked={viewOnce}
                        onChange={(event) => {
                          setViewOnce(event.target.checked);
                          showToast(event.target.checked ? "View Once on for this session" : "View Once off");
                        }}
                      />
                      View once media
                    </label>
                    <p className="chat-menu-hint" style={{ marginTop: "-0.35rem" }}>
                      Applies to media sent in this session. View-once media is consumed on first view.
                    </p>

                    <button
                      type="button"
                      onClick={() => {
                        const next = !disappearing;
                        if (next && !window.confirm("Turn on 24h chat? Once both participants open the chat, all messages in this room are deleted after 24 hours. This cannot be undone.")) return;
                        void toggleDisappearing();
                      }}
                      disabled={disappearingLoading}
                      className="privacy-action"
                    >
                      {disappearing ? "Turn off 24h chat" : "Turn on 24h chat"}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        if (sessionExpiresAt && sessionExpiresAt > Date.now()) {
                          showToast("A live session is already active");
                          return;
                        }
                        void startGhostSession(60 * 60 * 1000);
                      }}
                      disabled={!!sessionExpiresAt && sessionExpiresAt > Date.now()}
                      className="privacy-action"
                      title={sessionExpiresAt && sessionExpiresAt > Date.now() ? "A live session is already running" : undefined}
                    >
                      {sessionExpiresAt && sessionExpiresAt > Date.now() ? "Live session active" : "Start 1h live session"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* ── Media lightbox ── */}
      {lightbox && (
        <div
          className="lightbox sensitive-media"
          role="dialog"
          aria-modal="true"
          aria-label="Media viewer"
          onPointerDown={() => setLightbox(null)}
          onContextMenu={(e) => e.preventDefault()}
        >
          {lightbox.kind === "video" ? (
            <video
              src={lightbox.url}
              controls
              autoPlay
              playsInline
              controlsList="nodownload"
              draggable={false}
              onPointerDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            />
          ) : (
            <img
              src={lightbox.url}
              alt="Shared media"
              draggable={false}
              onPointerDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}
          <div className="lightbox-bar" onPointerDown={(e) => e.stopPropagation()}>
            {lightbox.viewOnce && <span>🔒 View once — already consumed · screenshots may not be preventable on this device</span>}
            <button type="button" className="sheet-close" onClick={() => setLightbox(null)} aria-label="Close media viewer">×</button>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toastMsg && (
        <div className="chat-toast" role="status" aria-live="polite">{toastMsg}</div>
      )}

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
                <Icon name="plus" size={20} />
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
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(e as unknown as FormEvent);
                }
              }}
              rows={1}
              placeholder={mediaFile ? "Add a caption… (optional)" : "Write a message…"}
              className="composer-input"
              aria-label="Message"
              style={{ userSelect: "text" } as React.CSSProperties}
            />

            {/* One display-mode control shared by desktop and mobile */}
            <div className="mode-switch mode-switch-display" role="group" aria-label="Display mode">
              <button
                type="button"
                onClick={() => setRevealed(false)}
                className={!revealed ? "mode-active" : "mode-option"}
                aria-pressed={!revealed}
                title="Display messages using the privacy display cipher"
              >Coded</button>
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className={revealed ? "mode-active" : "mode-option"}
                aria-pressed={revealed}
                title="Display decrypted message text"
              >Revealed</button>
            </div>

            {/* Send */}
            <button
              type="button"
              disabled={sending || (!input.trim() && !mediaFile)}
              className="btn-send"
              aria-label={sending ? "Sending message" : "Send message"}
              aria-busy={sending}
              title="Send (Enter)"
            >
              {sending ? "…" : <Icon name="send" size={18} />}
            </button>
          </div>

          {otherTyping && <div className="typing-status" role="status">{friendProfile?.displayName ?? "Someone"} is typing…</div>}
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
        <div
          className="privacy-overlay"
          role="button"
          aria-label="Dismiss privacy screen"
          tabIndex={0}
          onClick={dismissPrivacy}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") dismissPrivacy(); }}
        >
          <div className="privacy-overlay-card">
            <span className="privacy-overlay-icon" aria-hidden="true">🔒</span>
            <strong>Chat Protected</strong>
            <span>Tap to continue</span>
          </div>
        </div>
      )}
    </main>
  );
}

export default function ChatPage() { return <AuthGuard><ChatInner /></AuthGuard>; }
