"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
type CryptoContextValue = {
  key: CryptoKey | null;
  keyword: string;
  unlocked: boolean;
  unlock: (key: CryptoKey, keyword: string) => void;
  lock: () => void;
};

const CryptoContext = createContext<CryptoContextValue | undefined>(
  undefined
);

export function CryptoProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [keyword, setKeyword] = useState("");

  const unlock = useCallback((derivedKey: CryptoKey, nextKeyword: string) => {
    setKey(derivedKey);
    setKeyword(nextKeyword);
  }, []);

  const lock = useCallback(() => {
    setKey(null);
    setKeyword("");
  }, []);

  useEffect(() => {
    if (!key) return;
    const autoLockMinutes = Number(process.env.NEXT_PUBLIC_AUTO_LOCK_MINUTES ?? "5");
    const timeoutMs = (Number.isFinite(autoLockMinutes) && autoLockMinutes > 0 ? autoLockMinutes : 5) * 60_000;
    let timer: ReturnType<typeof setTimeout>;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, timeoutMs);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        lock();
      } else {
        resetTimer();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pointerdown", resetTimer);
    window.addEventListener("keydown", resetTimer);
    window.addEventListener("touchstart", resetTimer);
    resetTimer();

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pointerdown", resetTimer);
      window.removeEventListener("keydown", resetTimer);
      window.removeEventListener("touchstart", resetTimer);
    };
  }, [key, lock]);

  const value = useMemo(
    () => ({
      key,
      keyword,
      unlocked: key !== null,
      unlock,
      lock,
    }),
    [key, keyword, unlock, lock]
  );

  return (
    <CryptoContext.Provider value={value}>
      {children}
    </CryptoContext.Provider>
  );
}

export function useCrypto() {
  const context = useContext(CryptoContext);

  if (!context) {
    throw new Error("useCrypto must be used inside CryptoProvider");
  }

  return context;
}