const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob: https://*.humane.cloud https://resources.tidal.com",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  // Next emits small inline bootstrap scripts in production standalone output.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // `usb=(self)` is deliberate, not decorative: the Pin console reaches the
  // device through WebUSB from Center's own origin. WebUSB is allowed today only
  // because `usb` is unlisted and defaults to `self`, so any later hardening pass
  // that appends `usb=()` would kill the installer with no CSP violation and no
  // console error pointing at this header. State the grant explicitly instead.
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(), usb=(self)" },
];

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Keep every Center artifact built for one immutable release byte-identifiable.
 *
 * This validation is intentionally lazy: `next dev` can load the configuration
 * without a release, while `next build` invokes `generateBuildId` and fails
 * closed unless its orchestrator supplied the canonical release identity.
 */
export function revivalBuildId(environment = process.env) {
  const releaseId = environment.REVIVAL_RELEASE_ID;
  if (typeof releaseId !== "string" || !RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error(
      "REVIVAL_RELEASE_ID is required for Center builds and must be 1-128 safe identifier characters.",
    );
  }
  return releaseId;
}

/** @type {import("next").NextConfig} */
const nextConfig = {
  // The container copies this traced server instead of containing source,
  // compilers, or the full dependency tree into production.
  output: "standalone",
  // The dev overlay badge sits bottom-left, exactly where the Humane logo belongs.
  devIndicators: false,
  generateBuildId: async () => revivalBuildId(),
  images: {
    // Humane served capture media from webapi.prod.humane.cloud through next/image.
    remotePatterns: [{ protocol: "https", hostname: "**.humane.cloud" }],
  },
  // No `/setup` rewrite. It used to serve a standalone Pin console SPA's
  // `index.html`, and that SPA carried an interactive ADB PTY — a root shell on
  // the wearer's device — on an ordinary wearer path. The console is native now:
  // `/settings/pin` for the wearer, `/admin/pin/terminal` for the operator shell,
  // which `isOperatorPath` and `app/admin/pin/layout.tsx` both gate. The SPA's
  // source is deleted; see the Dockerfile for why nothing may rebuild it here.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
