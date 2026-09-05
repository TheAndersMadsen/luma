#!/usr/bin/env node

import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadImageReceipts } from "./release-descriptor.mjs";

const [receiptsDirectory, output, revision] = process.argv.slice(2);
if (!receiptsDirectory || !output || !/^[0-9a-f]{40}$/u.test(revision || "")) {
  process.stderr.write("usage: publication-environment.mjs RECEIPTS OUTPUT REVISION\n");
  process.exit(64);
}

try {
  const images = await loadImageReceipts(resolve(receiptsDirectory));
  const placeholder = "release-publication-placeholder-not-runtime-data";
  const values = {
    REVIVAL_RELEASE_ID: revision,
    REVIVAL_COSMOS_IMAGE: images.cosmos.reference,
    REVIVAL_CENTER_IMAGE: images.center.reference,
    REVIVAL_KEYCLOAK_IMAGE: images.keycloak.reference,
    REVIVAL_SPOTIFY_IMAGE: images["spotify-adapter"].reference,
    REVIVAL_CENTER_IROH_BRIDGE_IMAGE: images["center-iroh-bridge"].reference,
    REVIVAL_DEPLOYMENT_ENVIRONMENT: "production",
    REVIVAL_ENVIRONMENT: "production",
    REVIVAL_PUBLIC_ORIGIN: "https://operator.invalid",
    COSMOS_OIDC_ISSUER: "https://operator.invalid/realms/humane",
    COSMOS_CAPTURE_SHARE_BASE_URL: "https://operator.invalid",
    COSMOS_CAPTURE_UPLOAD_BASE_URL: "https://operator.invalid",
    REVIVAL_MUSIC_GATEWAY_ORIGIN: "https://operator.invalid",
    COSMOS_PG_PASSWORD: placeholder,
    COSMOS_DATABASE_URL: `postgresql://cosmos:${placeholder}@postgres:5432/cosmos`,
    COSMOS_EDGE_TOKEN: placeholder,
    COSMOS_ADMIN_TOKEN: placeholder,
    COSMOS_CENTER_PROJECTION_TOKEN: placeholder,
    COSMOS_RTC_PUBLIC_URL: 'wss://operator.invalid/livekit',
    COSMOS_RTC_API_KEY: placeholder,
    COSMOS_RTC_API_SECRET: placeholder,
    COSMOS_SHARE_TOKEN_SECRET: placeholder,
    AUTH_SESSION_SECRET: placeholder,
    KEYCLOAK_CLIENT_SECRET: placeholder,
    KEYCLOAK_ADMIN: "release-publication",
    KEYCLOAK_ADMIN_PASSWORD: placeholder,
  };
  const contents = `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
  await writeFile(resolve(output), contents, { mode: 0o600, flag: "wx" });
  await chmod(resolve(output), 0o600);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
