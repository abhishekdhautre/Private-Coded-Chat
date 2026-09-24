/**
 * Icon system for Private Coded Chat.
 *
 * A single inline SVG set with consistent 24px grid and 1.6 stroke weight.
 * Emoji remain available for user content (avatars, messages, stickers) but are
 * deliberately NOT used for navigation or action affordances.
 */

export type IconName =
  | "lock"
  | "lockOpen"
  | "shield"
  | "search"
  | "more"
  | "send"
  | "plus"
  | "paperclip"
  | "image"
  | "video"
  | "sticker"
  | "camera"
  | "settings"
  | "back"
  | "close"
  | "check"
  | "checkDouble"
  | "pin"
  | "pinFilled"
  | "mute"
  | "muteFilled"
  | "users"
  | "bell"
  | "at"
  | "heart"
  | "reply"
  | "edit"
  | "trash"
  | "eye"
  | "eyeOff"
  | "clock"
  | "calendar"
  | "radio"
  | "sliders"
  | "ghost"
  | "chevronRight"
  | "chevronDown"
  | "logout"
  | "key"
  | "device"
  | "sparkle"
  | "info"
  | "chat"
  | "user";

const PATHS: Record<IconName, React.ReactNode> = {
  lock: (
    <>
      <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  lockOpen: (
    <>
      <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 7.5-2" />
    </>
  ),
  shield: <path d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 8.5-4.1-.9-7-4.3-7-8.5V6l7-3z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18.5" cy="12" r="1.4" />
    </>
  ),
  send: <path d="M3.2 20.8 21 12 3.2 3.2l.05 6.9L15.4 12 3.25 13.9z" fill="currentColor" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" />,
  plus: <path d="M12 5v14M5 12h14" />,
  paperclip: <path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.4 8.4a1.8 1.8 0 0 1-2.5-2.5l7.7-7.7" />,
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 17l4.5-4.5 3.5 3.5 3-3L20 17" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6" width="12.5" height="12" rx="2.5" />
      <path d="M15.5 10.5l5.5-3v9l-5.5-3" />
    </>
  ),
  sticker: (
    <>
      <path d="M14 3.5H7A3.5 3.5 0 0 0 3.5 7v10A3.5 3.5 0 0 0 7 20.5h4l9.5-9.5V7A3.5 3.5 0 0 0 17 3.5z" />
      <path d="M11 20.5v-4.5a2.5 2.5 0 0 1 2.5-2.5h4.5" />
    </>
  ),
  camera: (
    <>
      <path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h1.6l1.2-2h6.4l1.2 2H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 18H6a2.5 2.5 0 0 1-2.5-2.5v-7z" />
      <circle cx="12" cy="12" r="3.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M4.5 12.5l5 5 10-11" />,
  checkDouble: <path d="M2 12.5l4.5 4.5 8-9M11 16l1 1 8-9" />,
  pin: <path d="M12 15.5V21M8 3.5h8l-1 5 3 3.5H6l3-3.5-1-5z" />,
  pinFilled: (
    <>
      <path d="M8 3.5h8l-1 5 3 3.5H6l3-3.5-1-5z" fill="currentColor" stroke="none" />
      <path d="M12 12v9" />
    </>
  ),
  mute: (
    <>
      <path d="M11 5.5L6.5 9.5H3.5v5h3L11 18.5v-13z" />
      <path d="M16 9.5l4.5 5M20.5 9.5l-4.5 5" />
    </>
  ),
  muteFilled: (
    <>
      <path d="M11 5.5L6.5 9.5H3.5v5h3L11 18.5v-13z" fill="currentColor" stroke="none" />
      <path d="M16 9.5l4.5 5M20.5 9.5l-4.5 5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M17.5 20a6 6 0 0 0-2-4.4" />
    </>
  ),
  bell: <path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15L18 15.5zM10 20.5a2 2 0 0 0 4 0" />,
  at: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M15.5 12v1.8a2.2 2.2 0 0 0 4.4 0V12a8 8 0 1 0-3.2 6.4" />
    </>
  ),
  heart: <path d="M12 20s-7.5-4.6-7.5-9.4A4.1 4.1 0 0 1 12 8a4.1 4.1 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" />,
  reply: <path d="M9 8L4.5 12 9 16M4.5 12h9a6 6 0 0 1 6 6v1.5" />,
  edit: <path d="M4.5 19.5h4L20 8a2.5 2.5 0 0 0-3.5-3.5L5 16v3.5zM14.5 6.5l3.5 3.5" />,
  trash: <path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13M10 10v6M14 10v6" />,
  eye: (
    <>
      <path d="M2 12c1 1.8 5 6 10 6s9-4.2 10-6c-1-1.8-5-6-10-6s-9 4.2-10 6z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 9 4.2 10 6-.5.9-1.9 2.7-3.8 4.1M6.5 7.9C4.4 9.3 3 11.3 2 12c1 1.8 5 6 10 6 1.3 0 2.4-.3 3.4-.7" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  radio: (
    <>
      <circle cx="12" cy="12" r="2.2" />
      <path d="M8.1 8.1a5.5 5.5 0 0 0 0 7.8M15.9 15.9a5.5 5.5 0 0 0 0-7.8M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 18.7a9.5 9.5 0 0 0 0-13.4" />
    </>
  ),
  sliders: <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M8 14.5v5" />,
  ghost: (
    <>
      <path d="M5 20V10.5a7 7 0 0 1 14 0V20l-2.3-1.8L14.4 20l-2.4-1.8L9.6 20l-2.3-1.8L5 20z" />
      <circle cx="10" cy="10.5" r=".9" fill="currentColor" stroke="none" />
      <circle cx="14" cy="10.5" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  chevronRight: <path d="M9.5 5.5l6.5 6.5-6.5 6.5" />,
  chevronDown: <path d="M5.5 9.5L12 16l6.5-6.5" />,
  logout: <path d="M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h8a1.5 1.5 0 0 0 1.5-1.5V16M10 12h10M17 9l3 3-3 3" />,
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3.5M15 12v2.5" />
    </>
  ),
  device: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M10.5 5h3M12 18.5h.01" />
    </>
  ),
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8h.01" />
    </>
  ),
  chat: (
    <>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-5 4v-14.5z" />
      <path d="M8.5 9.5h7M8.5 12.5h4.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  className,
  strokeWidth = 1.6,
  title,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
  /** When omitted the icon is treated as decorative; pass a label to expose it. */
  title?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}

/** Wordmark used across auth, lock screens and headers. */
export function BrandMark({ size = 28, withWordmark = true }: { size?: number; withWordmark?: boolean }) {
  return (
    <span className="brand-mark" aria-label="Private Coded Chat">
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="30" height="30" rx="9" fill="currentColor" opacity="0.1" />
        <rect x="1" y="1" width="30" height="30" rx="9" stroke="currentColor" strokeWidth="1.4" opacity="0.35" />
        <path
          d="M16 7.5l6 2.6v4.7c0 3.6-2.5 6.5-6 7.3-3.5-.8-6-3.7-6-7.3v-4.7l6-2.6z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path d="M13.2 16.1l2 2 3.6-4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {withWordmark && <span className="brand-wordmark">Private Coded Chat</span>}
    </span>
  );
}
