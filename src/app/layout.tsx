import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

// Self-hosted variable fonts (latin): nothing is fetched from the network, so the look survives an offline demo.
const rounded = localFont({ src: "./fonts/Fredoka.woff2", variable: "--font-rounded", weight: "300 700", display: "swap" });
const sans = localFont({ src: "./fonts/Nunito.woff2", variable: "--font-body", weight: "200 1000", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Acorn", template: "%s · Acorn" },
  description: "Acorn remembers what you discover and helps you actually do something with it.",
  appleWebApp: { capable: true, title: "Acorn", statusBarStyle: "default" },
  // iPhone Home Screen icon: an opaque 180x180 PNG (iOS ignores transparency and does not use the manifest's icons for this)
  icons: { icon: [{ url: "/pwa-icon/192", sizes: "192x192", type: "image/png" }], apple: [{ url: "/pwa-icon/180", sizes: "180x180", type: "image/png" }] },
  formatDetection: { telephone: false },
};

// viewport-fit=cover lets the standalone app draw under the notch; the bottom bar already pads for the home indicator
export const viewport: Viewport = { themeColor: "#5f9340", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${rounded.variable} ${sans.variable} h-full`}>
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
