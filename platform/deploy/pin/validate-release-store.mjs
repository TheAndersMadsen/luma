#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { parseCanonicalPinReleaseManifestDocument } from "./release.mjs";

const APK_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

async function readManifest(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error.message}`);
  }
  return { source, manifest: parseCanonicalPinReleaseManifestDocument(source) };
}

async function verifyArtifact(path, artifact) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw new Error(`cannot read ${artifact.role} artifact: ${error.message}`);
  }
  if (!metadata.isFile()) throw new Error(`${artifact.role} artifact is not a regular file`);
  if (metadata.size !== artifact.size) {
    throw new Error(`${artifact.role} artifact size does not match its manifest`);
  }

  const digest = createHash("sha256");
  await pipeline(createReadStream(path), digest);
  if (digest.digest("hex") !== artifact.sha256) {
    throw new Error(`${artifact.role} artifact sha256 does not match its manifest`);
  }
  const descriptor = await open(path, "r");
  try {
    const header = Buffer.alloc(APK_HEADER.length);
    const { bytesRead } = await descriptor.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || !header.equals(APK_HEADER)) {
      throw new Error(`${artifact.role} artifact is not an APK/ZIP file`);
    }
  } finally {
    await descriptor.close();
  }
}

export async function validateReleaseStore(storeRoot) {
  const root = resolve(storeRoot);
  const current = await readManifest(join(root, "current.json"), "current release pointer");
  const releaseDirectory = join(root, "releases", current.manifest.releaseId);
  const release = await readManifest(join(releaseDirectory, "manifest.json"), "release manifest");
  if (release.source !== current.source) {
    throw new Error("current release pointer and immutable release manifest disagree");
  }
  for (const artifact of release.manifest.artifacts) {
    await verifyArtifact(join(releaseDirectory, artifact.name), artifact);
  }
  return release.manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv.length !== 3) {
    process.stderr.write("usage: validate-release-store.mjs STORE_ROOT\n");
    process.exitCode = 64;
  } else {
    try {
      await validateReleaseStore(process.argv[2]);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
