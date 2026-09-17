"use client";
import { useEffect, useRef } from "react";
import { ALL_REACTION_EMOJIS } from "@/lib/stickers";

export function ReactionPicker({
  onPick,
  onClose,
  isMine,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  isMine: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={`reaction-picker ${isMine ? "reaction-picker-right" : "reaction-picker-left"}`}
      role="toolbar"
      aria-label="React to message"
    >
      {ALL_REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => { onPick(emoji); onClose(); }}
          className="reaction-picker-btn"
          aria-label={`React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
