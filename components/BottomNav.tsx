"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { subscribeChatList, subscribeIncomingRequests } from "@/lib/userService";

const NAV = [
  { href: "/home", icon: "💬", label: "Chats" },
  { href: "/search", icon: "🔎", label: "Search" },
  { href: "/friends", icon: "👥", label: "Friends" },
  { href: "/profile", icon: "👤", label: "Profile" },
];

export function BottomNav() {
  const path = usePathname();
  const { user } = useAuth();
  const [chatUnread, setChatUnread] = useState(0);
  const [requestCount, setRequestCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    const unsub1 = subscribeChatList(user.uid, (chats) => {
      setChatUnread(chats.reduce((s, c) => s + c.unread, 0));
    });
    const unsub2 = subscribeIncomingRequests(user.uid, (reqs) => {
      setRequestCount(reqs.length);
    });
    return () => { unsub1(); unsub2(); };
  }, [user]);

  if (!user) return null;

  return (
    <nav className="bottom-nav" aria-label="Main navigation">
      {NAV.map(({ href, icon, label }) => {
        const active = path === href || (href !== "/home" && path.startsWith(href));
        const badge =
          href === "/home" && chatUnread > 0 ? chatUnread :
          href === "/friends" && requestCount > 0 ? requestCount : 0;
        return (
          <Link
            key={href}
            href={href}
            className={`bottom-nav-item${active ? " bottom-nav-active" : ""}`}
            aria-label={label}
          >
            <span className="bottom-nav-icon-wrap">
              <span className="bottom-nav-icon">{icon}</span>
              {badge > 0 && (
                <span className="bottom-nav-badge" aria-label={`${badge} unread`}>
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </span>
            <span className="bottom-nav-label">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
