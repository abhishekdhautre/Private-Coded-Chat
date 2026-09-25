/**
 * Media MIME fidelity for the encrypted-media pipeline.
 *
 * The stored message row only ever carried a coarse `mediaType` of "image" |
 * "video", so the receiving side had to GUESS the real content type when it
 * rebuilt the decrypted bytes into a Blob:
 *
 *     const mime = row.mediaType === "image" ? "image/jpeg" : "video/mp4";
 *
 * That guess is correct for desktop-picked JPEG/MP4 files and wrong for
 * everything a phone produces: iPhone photos are `image/heic`, screenshots are
 * `image/png`, iPhone videos are `video/quicktime` (MOV/HEVC). WebKit selects
 * the decoder from the resource's declared MIME type, so a `blob:` URL that
 * claims `image/jpeg` while containing HEIC bytes fails to decode — the
 * `<img>`/`<video>` element renders nothing and the media message looks like
 * it was never delivered, even though encryption, the Firebase write and the
 * decryption all succeeded. The composer preview renders fine because it uses
 * the original `File` object (and therefore the original type).
 *
 * These helpers persist and restore the picked file's real MIME type end to
 * end, while keeping the historical guess as a backwards-compatible fallback
 * for rows written before `mediaMime` existed.
 */

const FALLBACK_IMAGE_MIME = "image/jpeg";
const FALLBACK_VIDEO_MIME = "video/mp4";

function isImageMime(mime: unknown): mime is string {
  return typeof mime === "string" && mime.toLowerCase().startsWith("image/");
}

function isVideoMime(mime: unknown): mime is string {
  return typeof mime === "string" && mime.toLowerCase().startsWith("video/");
}

/**
 * Real MIME type to persist alongside the encrypted payload.
 * Falls back to the legacy guess when the picked file reports nothing usable
 * (some mobile pickers return an empty `File.type`).
 */
export function outgoingMediaMime(
  fileType: string | null | undefined,
  mediaType: "image" | "video"
): string {
  const type = typeof fileType === "string" ? fileType.toLowerCase() : "";
  if (type.startsWith("image/") || type.startsWith("video/")) return type;
  return mediaType === "video" ? FALLBACK_VIDEO_MIME : FALLBACK_IMAGE_MIME;
}

export interface MediaRowLike {
  mediaType?: string | null;
  mediaMime?: string | null;
  mediaData?: string | null;
  mediaIv?: string | null;
}

/**
 * MIME type to declare on the reconstructed Blob.
 * Prefers the persisted real type; keeps the legacy guess for old rows, and
 * ignores a stored type whose top-level kind contradicts `mediaType`.
 */
export function mediaBlobMime(row: MediaRowLike | null | undefined): string {
  const mime = row?.mediaMime;
  const isVideo = row?.mediaType === "video";
  const kindOk = isVideo ? isVideoMime(mime) : isImageMime(mime);
  if (kindOk) return (mime as string).toLowerCase();
  return isVideo ? FALLBACK_VIDEO_MIME : FALLBACK_IMAGE_MIME;
}

/**
 * True when a stored row's media payload has produced a usable object URL.
 * Rows without a media payload are trivially "ready" so text-only messages
 * are never gated on this.
 *
 * Used so a message whose media failed to decrypt/decode is NOT treated as
 * permanently processed — it stays retryable when the row is delivered again.
 */
export function isMediaReady(
  row: MediaRowLike | null | undefined,
  blobUrl: string | null | undefined
): boolean {
  if (!row?.mediaData || !row?.mediaIv || !row?.mediaType) return true;
  return typeof blobUrl === "string" && blobUrl.length > 0;
}
