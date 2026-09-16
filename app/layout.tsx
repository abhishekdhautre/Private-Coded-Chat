import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { CryptoProvider } from "@/contexts/CryptoContext";

export const metadata = {
  title: "Private Coded Chat",
  description: "Two-person end-to-end encrypted coded chat"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <CryptoProvider>{children}</CryptoProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
