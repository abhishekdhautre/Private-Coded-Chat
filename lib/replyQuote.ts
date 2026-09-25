/**
 * Pure reply-quote helpers for WhatsApp-style quoted replies.
 *
 * The quoted message is ALWAYS resolved from this device's already-decrypted
 * local message list — never from the network, never decrypted again — so a
 * quote can only ever show plaintext the current user has already decrypted.
 * When the original is missing (deleted, expired, not yet loaded), the caller
 * renders an honest "unavailable" fallback instead of guessing.
 *
 * No React, no Firebase, no crypto in this module.
 */

export interface QuotableMessage {
  senderId: string;
  plaintext: string;
  msgType?: string | null;
  mediaType?: string | null;
}

export interface ReplyQuote {
  /** "You", the peer's display name, or a fallback label. */
  author: string;
  /** Quoted text, media label, or the unavailable fallback. Never null. */
  text: string;
  /** False when the original message could not be resolved locally. */
  available: boolean;
  /** True only when `text` is real message content (encodable in Coded mode). */
  isContent: boolean;
}

export const REPLY_QUOTE_MAX_LENGTH = 80;
export const REPLY_QUOTE_UNAVAILABLE = "Message unavailable";

/**
 * Builds the compact quote for a reply target resolved from the local list.
 * Pass `null` when the target id has no local message (deleted/expired).
 */
export function describeReplyQuote(
  target: QuotableMessage | null,
  opts: { myUid: string; peerLabel: string }
): ReplyQuote {
  if (!target) {
    return {
      author: "Original message",
      text: REPLY_QUOTE_UNAVAILABLE,
      available: false,
      isContent: false,
    };
  }

  const author = target.senderId === opts.myUid ? "You" : opts.peerLabel;

  if (target.msgType === "sticker") {
    return { author, text: "Sticker", available: true, isContent: false };
  }
  if (target.msgType === "gif") {
    return { author, text: "GIF", available: true, isContent: false };
  }
  if (target.mediaType === "video" || target.mediaType === "image") {
    const caption = target.plaintext.trim();
    if (caption) {
      return { author, text: truncateQuote(caption), available: true, isContent: true };
    }
    return {
      author,
      text: target.mediaType === "video" ? "Video" : "Photo",
      available: true,
      isContent: false,
    };
  }

  return { author, text: truncateQuote(target.plaintext), available: true, isContent: true };
}

function truncateQuote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= REPLY_QUOTE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, REPLY_QUOTE_MAX_LENGTH).trimEnd()}…`;
}
