import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { centerRuntimeIdentity } from "@/lib/runtimeIdentity";
import { PUBLIC_PROJECT_NAME, PUBLIC_SITE_NAME, publicOrigin } from "@/lib/public-site";
import { AUTH_ENABLED, SESSION_COOKIE, verifySession } from "@/server/auth";

export async function generateMetadata(): Promise<Metadata> {
  // Reading request headers keeps portable release images domain-neutral at
  // build time. Production supplies LUMA_PUBLIC_ORIGIN at runtime.
  await headers();
  const origin = publicOrigin();
  return {
    metadataBase: new URL(origin),
    title: { default: PUBLIC_SITE_NAME, template: `%s | ${PUBLIC_SITE_NAME}` },
    applicationName: PUBLIC_SITE_NAME,
    description:
      "Self-hosted Center and Cosmos services for the Humane Ai Pin.",
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
      description: "Self-hosted Center and Cosmos services for the Humane Ai Pin.",
      images: [{
        url: "/luma-hero.webp",
        width: 1600,
        height: 640,
        alt: "Luma connecting a Pin to a private Cosmos server",
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
  // The @capturemodal parallel slot, the capture lightbox rendered over the
  // grid via the (.)captures/[id] intercepting route. Empty (its default.tsx
  // returns null) on every route that isn't an intercepted capture.
  capturemodal: React.ReactNode;
}) {
  await headers();
  const origin = publicOrigin();
  const identity = centerRuntimeIdentity();
  // The wearer's assistant, and the status it polls, exist only for a signed-in
  // session. A visitor on a public page would only collect 401s. Sign-in and
  // sign-out both refresh this layout.
  const session = AUTH_ENABLED ? await verifySession((await cookies()).get(SESSION_COOKIE)?.value) : null;
  const signedIn = !AUTH_ENABLED || session !== null;
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "@id": `${origin}/#software`,
        name: PUBLIC_PROJECT_NAME,
        alternateName: PUBLIC_SITE_NAME,
        description: "Self-hosted Center and Cosmos services for a Humane Ai Pin.",
        url: origin,
        applicationCategory: "UtilitiesApplication",
        operatingSystem: "Web, Android, Linux",
        softwareVersion: identity.release,
        isAccessibleForFree: true,
        author: { "@id": `${origin}/#project` },
      },
      {
        "@type": "Organization",
        "@id": `${origin}/#project`,
        name: PUBLIC_PROJECT_NAME,
        url: origin,
        logo: `${origin}/icon-512.png`,
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
          omitting it downloads 344 kB twice. `font-src 'self'` in
          next.config.mjs already permits the fetch.
        */}
        <link
          rel="preload"
          href="/fonts/InterVariable.woff2"
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
        <Providers assistant={signedIn} identity={session ? { sub: session.sub, email: session.email } : null}>
          {children}
          {capturemodal}
        </Providers>
      </body>
    </html>
  );
}
