import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { centerRuntimeIdentity } from "@/lib/runtimeIdentity";
import { PUBLIC_PROJECT_NAME, PUBLIC_REPOSITORY_URL, PUBLIC_SITE_NAME, publicOrigin } from "@/lib/public-site";

export async function generateMetadata(): Promise<Metadata> {
  // Reading request headers keeps portable release images domain-neutral at
  // build time. Production supplies REVIVAL_PUBLIC_ORIGIN at runtime.
  await headers();
  const origin = publicOrigin();
  return {
    metadataBase: new URL(origin),
    title: { default: PUBLIC_SITE_NAME, template: `%s | ${PUBLIC_SITE_NAME}` },
    applicationName: PUBLIC_SITE_NAME,
    description:
      "Bring a Humane Ai Pin back online with owner-operated Center and Cosmos services.",
    alternates: { canonical: "/" },
    manifest: "/manifest.json",
    icons: {
      icon: [{ url: "/favicon.ico", sizes: "any" }],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    openGraph: {
      type: "website",
      url: "/",
      siteName: PUBLIC_SITE_NAME,
      title: PUBLIC_SITE_NAME,
      description: "Your Ai Pin, connected to Center and Cosmos services you operate.",
      images: [{
        url: "/revival-hero.webp",
        width: 1600,
        height: 640,
        alt: "Ai Pin Revival connecting a Pin to a private Cosmos server",
      }],
    },
    robots: { index: true, follow: true },
    appleWebApp: {
      capable: true,
      statusBarStyle: "black",
      title: "Center",
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "black",
};

export default async function RootLayout({
  children,
  capturemodal,
}: {
  children: React.ReactNode;
  // The @capturemodal parallel slot — the capture lightbox rendered over the
  // grid via the (.)captures/[id] intercepting route. Empty (its default.tsx
  // returns null) on every route that isn't an intercepted capture.
  capturemodal: React.ReactNode;
}) {
  await headers();
  const origin = publicOrigin();
  const identity = centerRuntimeIdentity();
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "@id": `${origin}/#software`,
        name: PUBLIC_PROJECT_NAME,
        alternateName: PUBLIC_SITE_NAME,
        description: "Owner-operated Center and Cosmos services for a Humane Ai Pin.",
        url: origin,
        applicationCategory: "UtilitiesApplication",
        operatingSystem: "Web, Android, Linux",
        softwareVersion: identity.release,
        isAccessibleForFree: true,
        codeRepository: PUBLIC_REPOSITORY_URL,
        author: { "@id": `${origin}/#project` },
      },
      {
        "@type": "Organization",
        "@id": `${origin}/#project`,
        name: PUBLIC_PROJECT_NAME,
        url: origin,
        logo: `${origin}/icon-512.png`,
        sameAs: [PUBLIC_REPOSITORY_URL],
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "technical support",
          url: `${origin}/contact`,
        },
      },
    ],
  };
  const structuredJson = JSON.stringify(structuredData).replaceAll("<", "\\u003c");

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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: structuredJson }}
        />
        <Providers>
          {children}
          {capturemodal}
        </Providers>
      </body>
    </html>
  );
}
