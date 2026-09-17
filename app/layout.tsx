import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { CryptoProvider } from "@/contexts/CryptoContext";
import { Analytics } from "@vercel/analytics/next";
import type { Viewport } from "next";

export const metadata = {
  title: "Private Coded Chat",
  description: "Two-person end-to-end encrypted coded chat"
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AuthProvider>
          <CryptoProvider>{children}</CryptoProvider>
        </AuthProvider>
        <Analytics />
      </body>
    </html>
  );
}
