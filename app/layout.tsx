import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import { AuthProvider } from "@/contexts/AuthContext";
import { CryptoProvider } from "@/contexts/CryptoContext";
import { Analytics } from "@vercel/analytics/next";
import type { Viewport } from "next";

// Self-hosted via next/font — no external requests at runtime, which suits a
// privacy-first product and avoids layout shift.
const sans = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata = {
  title: "Private Coded Chat",
  description: "Two-person end-to-end encrypted coded chat",
  applicationName: "Private Coded Chat",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0c11",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <AuthProvider>
          <CryptoProvider>{children}</CryptoProvider>
        </AuthProvider>
        <Analytics />
      </body>
    </html>
  );
}
