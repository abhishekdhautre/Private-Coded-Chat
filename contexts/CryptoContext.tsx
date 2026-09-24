"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
type CryptoContextValue = {
  key: CryptoKey | null;
  keyword: string;
  unlocked: boolean;
  unlock: (key: CryptoKey, keyword: string) => void;
  lock: () => void;
  isV2?: boolean;
  epoch?: number;
  deviceId?: string;
  identityPrivateKey?: CryptoKey | null;
  unlockV2?: (params: {
    roomMasterKey: CryptoKey;
    epoch: number;
    deviceId: string;
    identityPrivateKey: CryptoKey;
  }) => void;
};

const CryptoContext = createContext<CryptoContextValue | undefined>(
  undefined
);

export function CryptoProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [keyword, setKeyword] = useState("");
  const [isV2, setIsV2] = useState(false);
  const [epoch, setEpoch] = useState(1);
  const [deviceId, setDeviceId] = useState("");
  const [identityPrivateKey, setIdentityPrivateKey] = useState<CryptoKey | null>(null);
  // Timestamp of last unlock — visibility lock is suppressed for 2s after
  // unlock to survive the brief visibilitychange:hidden that browsers fire
  // during page navigation.
  const unlockedAt = useRef(0);
  const UNLOCK_GRACE_MS = 2000;

  const unlock = useCallback((derivedKey: CryptoKey, nextKeyword: string) => {
    unlockedAt.current = Date.now();
    setKey(derivedKey);
    setKeyword(nextKeyword);
    setIsV2(false);
    setIdentityPrivateKey(null);
  }, []);

  const unlockV2 = useCallback((params: {
    roomMasterKey: CryptoKey;
    epoch: number;
    deviceId: string;
    identityPrivateKey: CryptoKey;
  }) => {
    unlockedAt.current = Date.now();
    setKey(params.roomMasterKey);
    setKeyword("");
    setIsV2(true);
    setEpoch(params.epoch);
    setDeviceId(params.deviceId);
    setIdentityPrivateKey(params.identityPrivateKey);
  }, []);

  const lock = useCallback(() => {
    setKey(null);
    setKeyword("");
    setIsV2(false);
    setIdentityPrivateKey(null);
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
        // Ignore the hide event that fires during navigation right after unlock
        if (Date.now() - unlockedAt.current < UNLOCK_GRACE_MS) return;
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
      isV2,
      epoch,
      deviceId,
      identityPrivateKey,
      unlockV2,
    }),
    [key, keyword, unlock, lock, isV2, epoch, deviceId, identityPrivateKey, unlockV2]
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