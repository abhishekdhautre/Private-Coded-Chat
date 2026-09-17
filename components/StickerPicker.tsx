"use client";
import { useEffect, useRef, useState } from "react";
import { STICKER_CATEGORIES } from "@/lib/stickers";

export function StickerPicker({ onPick, onClose }: { onPick: (url: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState(0);
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
    <div ref={ref} className="picker-panel" role="dialog" aria-label="Sticker picker">
      <div className="picker-tabs">
        {STICKER_CATEGORIES.map((cat, i) => (
          <button
            key={cat.name}
            onClick={() => setTab(i)}
            className={`picker-tab ${tab === i ? "picker-tab-active" : ""}`}
            aria-label={cat.name}
          >
            {cat.stickers[0]}
          </button>
        ))}
      </div>
      <div className="picker-grid">
        {STICKER_CATEGORIES[tab].stickers.map((s) => (
          <button
            key={s}
            onClick={() => { onPick(s); onClose(); }}
            className="picker-item"
            aria-label={`Send sticker ${s}`}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
