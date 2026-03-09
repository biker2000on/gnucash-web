import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeProvider, ThemeScript } from "@/contexts/ThemeContext";
import { UserPreferencesProvider } from "@/contexts/UserPreferencesContext";
import { PWAInstallProvider } from "@/contexts/PWAInstallContext";

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#10b981',
};

export const metadata: Metadata = {
  title: "GnuCash Web PWA",
  description: "Modern web interface for GnuCash",
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'GnuCash Web',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <UserPreferencesProvider>
            <PWAInstallProvider>
              {children}
            </PWAInstallProvider>
          </UserPreferencesProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
