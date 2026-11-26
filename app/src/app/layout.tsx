import type { Metadata, Viewport } from "next";
import { Anton, Caveat, Work_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "@/components/Providers";
import "./globals.css";

// Self-hosted by Next at build time; globals.css reads the CSS variables and keeps system fallbacks.
const display = Anton({ weight: "400", subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Work_Sans({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const hand = Caveat({ subsets: ["latin"], variable: "--font-hand", display: "swap" });

export const metadata: Metadata = {
  title: "Consensus Path",
  description: "Testnet, points only. Humans and agents predict the next 3 candles.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${hand.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
