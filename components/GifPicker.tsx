"use client";
import { useEffect, useRef, useState } from "react";

type GifResult = { id: string; url: string; preview: string; title: string };

async function searchGiphy(query: string, apiKey: string): Promise<GifResult[]> {
  const endpoint = query.trim()
    ? `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(query)}&limit=24&rating=g`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${apiKey}&limit=24&rating=g`;
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error("Giphy request failed");
  const json = await res.json();
  return (json.data as Array<{ id: string; title: string; images: { fixed_height_small: { url: string }; preview_gif: { url: string } } }>).map((g) => ({
    id: g.id,
    url: g.images.fixed_height_small.url,
    preview: g.images.preview_gif.url,
    title: g.title,
  }));
}

export function GifPicker({ onPick, onClose }: { onPick: (url: string, preview: string) => void; onClose: () => void }) {
  const apiKey = process.env.NEXT_PUBLIC_GIPHY_API_KEY ?? "";
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    if (!apiKey) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        setResults(await searchGiphy(query, apiKey));
      } catch {
        setError("Could not load GIFs.");
      } finally {
        setLoading(false);
      }
    }, 400);
  }, [query, apiKey]);

  if (!apiKey) {
    return (
      <div ref={ref} className="picker-panel picker-panel-wide flex flex-col items-center justify-center gap-2 text-center p-6">
        <span className="text-3xl">🎞️</span>
        <p className="text-sm text-slate-400">GIF search requires a Giphy API key.</p>
        <p className="text-xs text-slate-500">Add <code className="text-cyan-400">NEXT_PUBLIC_GIPHY_API_KEY</code> to your <code>.env.local</code>.</p>
        <button onClick={onClose} className="mt-2 text-xs text-slate-500 underline">Close</button>
      </div>
    );
  }

  return (
    <div ref={ref} className="picker-panel picker-panel-wide" role="dialog" aria-label="GIF picker">
      <div className="p-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search GIFs…"
          className="w-full rounded-lg bg-[#2a3942] px-3 py-2 text-sm outline-none placeholder:text-slate-500"
          aria-label="Search GIFs"
        />
      </div>
      {loading && <p className="p-4 text-center text-xs text-slate-500">Loading…</p>}
      {error && <p className="p-4 text-center text-xs text-red-400">{error}</p>}
      {!loading && !error && results.length === 0 && (
        <p className="p-4 text-center text-xs text-slate-500">{query ? "No results." : "Type to search GIFs."}</p>
      )}
      <div className="gif-grid">
        {results.map((g) => (
          <button
            key={g.id}
            onClick={() => { onPick(g.url, g.preview); onClose(); }}
            className="gif-item"
            aria-label={g.title || "GIF"}
          >
            <img src={g.preview} alt={g.title} loading="lazy" className="w-full h-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}
