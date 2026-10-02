#!/usr/bin/env -S bun --no-env-file

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
    LUMA_RELEASE_ID: revision,
    LUMA_COSMOS_IMAGE: images.cosmos.reference,
    LUMA_CENTER_IMAGE: images.center.reference,
    LUMA_KEYCLOAK_IMAGE: images.keycloak.reference,
    LUMA_SPOTIFY_IMAGE: images["spotify-adapter"].reference,
    LUMA_CENTER_IROH_BRIDGE_IMAGE: images["center-iroh-bridge"].reference,
    LUMA_DEPLOYMENT_ENVIRONMENT: "production",
    LUMA_ENVIRONMENT: "production",
    LUMA_PUBLIC_ORIGIN: "https://operator.invalid",
    COSMOS_OIDC_ISSUER: "https://operator.invalid/realms/humane",
    COSMOS_CAPTURE_SHARE_BASE_URL: "https://operator.invalid",
    COSMOS_CAPTURE_UPLOAD_BASE_URL: "https://operator.invalid",
    LUMA_MUSIC_GATEWAY_ORIGIN: "https://operator.invalid",
    COSMOS_PG_PASSWORD: placeholder,
    COSMOS_DATABASE_URL: `postgresql://cosmos:${placeholder}@postgres:5432/cosmos`,
    COSMOS_EDGE_TOKEN: placeholder,
    COSMOS_ADMIN_TOKEN: placeholder,
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
