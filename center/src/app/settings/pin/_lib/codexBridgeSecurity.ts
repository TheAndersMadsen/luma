/*
 * Ported verbatim from the retired Setup SPA
 * (`src/pages/codexBridgeSecurity.ts`).
 *
 * These two validators run in the browser BEFORE a secret-bearing save leaves
 * for the Pin, and they mirror the on-device bridge URL policy. Do not relax
 * them: the private-key rejection in validatePublicCaPem is the reason a user
 * cannot paste a key pair into a field that is displayed back as "configured".
 */

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true;

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet)) &&
    octets.every((octet) => Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

/** Match the on-device bridge URL policy before a secret-bearing save. */
export function validateCodexBridgeUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a valid Codex bridge URL.";
  }

  if (url.username || url.password || url.search || url.hash) {
    return "The Codex bridge URL cannot contain credentials, a query, or a fragment.";
  }

  const hostname = normalizedHostname(url);
  if (!hostname || hostname === "0.0.0.0" || hostname === "::") {
    return "The Codex bridge URL must name a connectable host.";
  }

  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && isLoopbackHostname(hostname)) return null;
  if (url.protocol === "http:") {
    return "Use HTTPS for a Codex bridge reached over Wi-Fi. HTTP is allowed only for localhost or a loopback IP.";
  }
  return "The Codex bridge URL must use HTTP or HTTPS.";
}

/** Reject key material and accept only one public certificate PEM block. */
export function validatePublicCaPem(value: string): string | null {
  if (value.length > 32_768) {
    return "The Codex bridge CA must be no larger than 32 KiB.";
  }
  if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(value)) {
    return "Paste only a public CA certificate, never a private key.";
  }

  const trimmed = value.trim();
  const certificateBlocks = trimmed.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (
    certificateBlocks?.length !== 1 ||
    certificateBlocks[0]?.trim() !== trimmed
  ) {
    return "The Codex bridge CA must contain exactly one PEM certificate.";
  }
  return null;
}
