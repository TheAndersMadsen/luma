import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";

export const metadata: Metadata = {
  title: "Humane Center",
  applicationName: "Humane Center",
  description: "Manage your Ai Pin, captures, notes, and settings.",
  manifest: "/manifest.json",
  icons: {
    icon: [{ url: "/favicon.ico", sizes: "any" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black",
    title: "Center",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "black",
};

export default function RootLayout({
  children,
  capturemodal,
}: {
  children: React.ReactNode;
  // The @capturemodal parallel slot — the capture lightbox rendered over the
  // grid via the (.)captures/[id] intercepting route. Empty (its default.tsx
  // returns null) on every route that isn't an intercepted capture.
  capturemodal: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        {/*
          The Humane variable face, fetched in parallel with the stylesheet
          rather than after it.

          `@font-face` lives in globals.css, so without this the browser cannot
          learn the font exists until it has downloaded AND parsed that
          stylesheet: document → CSS → font, three serial hops before any text
          renders in the right face. Every route pays it, and with
          `font-display: swap` the wearer sees the fallback face first and then
          a reflow — on the dashboard that is the whole screen shifting under
          the cards.

          `crossOrigin` is not optional even though the font is same-origin:
          fonts are fetched in CORS mode, and a preload without it is a
          separate cache entry the stylesheet's own request will not reuse, so
          omitting it downloads 76 kB twice. `font-src 'self'` in
          next.config.mjs already permits the fetch.
        */}
        <link
          rel="preload"
          href="/fonts/humaneweb-vf.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <Providers>
          {children}
          {capturemodal}
        </Providers>
      </body>
    </html>
  );
}
