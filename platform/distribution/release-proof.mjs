#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  validatePinPayload,
  validateReleaseDescriptor,
} from "./release-descriptor.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const MAX_DESCRIPTOR_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_RELEASE_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_VERIFIER_OUTPUT_BYTES = 64 * 1024;
const GITHUB_API_VERSION = "2022-11-28";

export const RELEASE_PROOF_POLICY = Object.freeze({
  schemaVersion: 1,
  repository: "TheAndersMadsen/ai-pin-revival",
  workflowPath: ".github/workflows/release-cli.yml",
  workflowName: "immutable release",
  event: "push",
  oidcIssuer: "https://token.actions.githubusercontent.com",
  verifier: Object.freeze({
    repository: "sigstore/cosign",
    version: "v3.1.3",
    platforms: Object.freeze({
      "linux/x64": Object.freeze({
        name: "cosign-linux-amd64",
        size: 141_178_250,
        sha256: "4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71",
      }),
      "linux/arm64": Object.freeze({
        name: "cosign-linux-arm64",
        size: 132_747_403,
        sha256: "c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a",
      }),
    }),
  }),
});

function requiredTag(value) {
  if (typeof value !== "string" || !TAG.test(value)) {
    throw new Error("expected release tag must be an exact semantic version tag");
  }
  return value;
}

export function releaseProofBundleName(version) {
  const tag = requiredTag(`v${version}`);
  return `ai-pin-revival-${tag.slice(1)}.release.sigstore.json`;
}

export function expectedReleaseWorkflowIdentity(tag) {
  const selected = requiredTag(tag);
  return `https://github.com/${RELEASE_PROOF_POLICY.repository}/${RELEASE_PROOF_POLICY.workflowPath}@refs/tags/${selected}`;
}

function verifierArtifact(platform = process.platform, architecture = process.arch) {
  const key = `${platform}/${architecture}`;
  const artifact = RELEASE_PROOF_POLICY.verifier.platforms[key];
  if (!artifact) {
    throw new Error(`release verification supports only Linux x64 and arm64, not ${key}`);
  }
  return artifact;
}

function allowedVerifierUrl(value) {
  const selected = new URL(value);
  if (selected.protocol !== "https:" ||
      (selected.hostname !== "github.com" && !selected.hostname.endsWith(".githubusercontent.com"))) {
    throw new Error("pinned verifier download left the approved GitHub HTTPS boundary");
  }
  return selected;
}

function githubHeaders(value, accept) {
  const token = value?.trim() ?? "";
  if (token.length > 1024 || /\s/u.test(token)) {
    throw new Error("GH_TOKEN must be a bounded GitHub token without whitespace");
  }
  return Object.freeze({
    accept,
    "x-github-api-version": GITHUB_API_VERSION,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
}

async function boundedResponseBytes(response, maximum, label, exactSize = null) {
  if (!response.ok || !response.body) throw new Error(`${label} failed with HTTP ${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null &&
      (!Number.isSafeInteger(Number(contentLength)) || Number(contentLength) < 1 ||
       Number(contentLength) > maximum || (exactSize !== null && Number(contentLength) !== exactSize))) {
    throw new Error(`${label} has an invalid content length`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum || (exactSize !== null && size > exactSize)) {
      throw new Error(`${label} exceeded its bounded size`);
    }
    chunks.push(bytes);
  }
  if (size < 1 || (exactSize !== null && size !== exactSize)) {
    throw new Error(`${label} has an invalid byte length`);
  }
  return Buffer.concat(chunks, size);
}

function releaseApiUrl(tag) {
  return `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/tags/${requiredTag(tag)}`;
}

function releaseAssetApiUrl(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("GitHub release asset id is invalid");
  return `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/${id}`;
}

function requiredAssetNames(names) {
  if (!Array.isArray(names) || names.length < 1 || names.length > 8 ||
      names.some((name) => typeof name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(name)) ||
      new Set(names).size !== names.length) {
    throw new Error("GitHub release asset names are invalid");
  }
  return Object.freeze([...names]);
}

export async function resolvePublishedReleaseAssets({
  tag,
  names,
  fetchImpl = globalThis.fetch,
  githubToken = process.env.GH_TOKEN,
  timeoutMs = 120_000,
} = {}) {
  const selectedTag = requiredTag(tag);
  const selectedNames = requiredAssetNames(names);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("GitHub release metadata timeout must be a positive integer");
  }
  const response = await fetchImpl(releaseApiUrl(selectedTag), {
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: githubHeaders(githubToken, "application/vnd.github+json"),
  });
  const bytes = await boundedResponseBytes(
    response, MAX_RELEASE_METADATA_BYTES, "GitHub release metadata download",
  );
  let release;
  try {
    release = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("GitHub release metadata is not valid JSON");
  }
  if (!release || typeof release !== "object" || Array.isArray(release) ||
      release.tag_name !== selectedTag || release.draft !== false || !Array.isArray(release.assets) ||
      release.assets.length > 1_000) {
    throw new Error("GitHub release metadata does not describe the expected published tag");
  }
  const result = {};
  for (const name of selectedNames) {
    const matches = release.assets.filter((asset) => asset?.name === name);
    if (matches.length !== 1) throw new Error(`GitHub release has no unique ${name} asset`);
    const asset = matches[0];
    const url = releaseAssetApiUrl(asset.id);
    const browserUrl = publishedReleaseAssetUrl(selectedTag, name);
    if (asset.url !== url || asset.browser_download_url !== browserUrl ||
        !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 3 * 1024 * 1024 * 1024) {
      throw new Error(`GitHub release ${name} metadata is invalid`);
    }
    result[name] = Object.freeze({ name, size: asset.size, url });
  }
  return Object.freeze(result);
}

export async function resolvePublishedReleaseAsset(options = {}) {
  const { name } = options;
  const assets = await resolvePublishedReleaseAssets({ ...options, names: [name] });
  return assets[name];
}

function allowedAssetDeliveryUrl(value, initial) {
  const selected = new URL(value);
  const initialUrl = /^https:\/\/api\.github\.com\/repos\/TheAndersMadsen\/ai-pin-revival\/releases\/assets\/[1-9][0-9]*$/u;
  if (selected.protocol !== "https:" ||
      (initial ? !initialUrl.test(selected.href) : !selected.hostname.endsWith(".githubusercontent.com"))) {
    throw new Error("GitHub release asset download left the approved HTTPS boundary");
  }
  return selected;
}

export async function fetchPublishedReleaseAsset({
  asset,
  fetchImpl = globalThis.fetch,
  githubToken = process.env.GH_TOKEN,
  timeoutMs = 120_000,
} = {}) {
  if (!asset || typeof asset !== "object" || Array.isArray(asset) ||
      typeof asset.url !== "string" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("GitHub release asset request is invalid");
  }
  let selected = allowedAssetDeliveryUrl(asset.url, true);
  for (let count = 0; count <= 5; count += 1) {
    const initial = count === 0;
    const response = await fetchImpl(selected, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: initial ? githubHeaders(githubToken, "application/octet-stream") : undefined,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || count === 5) throw new Error("GitHub release asset has an invalid redirect chain");
      selected = allowedAssetDeliveryUrl(new URL(location, selected), false);
      continue;
    }
    if (!response.ok || !response.body) {
      throw new Error(`GitHub release asset download failed with HTTP ${response.status}`);
    }
    return response;
  }
  throw new Error("GitHub release asset has too many redirects");
}

async function fetchVerifier(url, fetchImpl) {
  let selected = allowedVerifierUrl(url);
  for (let count = 0; count <= 5; count += 1) {
    const response = await fetchImpl(selected, {
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || count === 5) throw new Error("pinned verifier download has an invalid redirect chain");
      selected = allowedVerifierUrl(new URL(location, selected));
      continue;
    }
    if (!response.ok || !response.body) {
      throw new Error(`pinned verifier download failed with HTTP ${response.status}`);
    }
    return response;
  }
  throw new Error("pinned verifier download has too many redirects");
}

async function sha256File(filename) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}

async function assertPinnedVerifier(filename, artifact) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== artifact.size) {
    throw new Error("cached release verifier does not match the pinned artifact");
  }
  if (await sha256File(filename) !== artifact.sha256) {
    throw new Error("cached release verifier does not match the pinned SHA-256");
  }
  return filename;
}

async function downloadPinnedVerifier({ target, artifact, fetchImpl }) {
  const url = `https://github.com/${RELEASE_PROOF_POLICY.verifier.repository}/releases/download/` +
    `${RELEASE_PROOF_POLICY.verifier.version}/${artifact.name}`;
  const response = await fetchVerifier(url, fetchImpl);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== artifact.size) {
    throw new Error("pinned release verifier size does not match its immutable policy");
  }
  let size = 0;
  const digest = createHash("sha256");
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > artifact.size) {
        callback(new Error("pinned release verifier exceeded its immutable size"));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    verifier,
    createWriteStream(target, { flags: "wx", mode: 0o700 }),
  );
  if (size !== artifact.size || digest.digest("hex") !== artifact.sha256) {
    throw new Error("pinned release verifier bytes do not match immutable policy");
  }
  await chmod(target, 0o700);
}

function defaultVerifierCache(environment = process.env) {
  const cache = environment.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cache, "ai-pin-revival", "tools");
}

export async function provisionPinnedCosign({
  cacheRoot = defaultVerifierCache(),
  platform = process.platform,
  architecture = process.arch,
  fetchImpl = globalThis.fetch,
} = {}) {
  const artifact = verifierArtifact(platform, architecture);
  const directory = resolve(cacheRoot, "cosign", RELEASE_PROOF_POLICY.verifier.version);
  const target = join(directory, artifact.name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const current = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (current) return assertPinnedVerifier(target, artifact);

  const temporaryDirectory = await mkdtemp(join(directory, ".download-"));
  const temporary = join(temporaryDirectory, artifact.name);
  try {
    await downloadPinnedVerifier({ target: temporary, artifact, fetchImpl });
    try {
      await link(temporary, target);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    return await assertPinnedVerifier(target, artifact);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function cleanVerifierEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !name.startsWith("COSIGN_") &&
    !name.startsWith("SIGSTORE_") &&
    name !== "TUF_ROOT"));
}

async function executeCosign({ executable, arguments: args }) {
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, {
      env: cleanVerifierEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk) => {
      if (output.length < MAX_VERIFIER_OUTPUT_BYTES) {
        output += chunk.toString("utf8", 0, MAX_VERIFIER_OUTPUT_BYTES - output.length);
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        accept();
        return;
      }
      reject(new Error(`Cosign rejected the release proof${output.trim() ? `: ${output.trim()}` : ""}`));
    });
  });
}

async function readBoundedRegular(filename, maximum, label) {
  const selected = resolve(filename);
  let handle;
  try {
    handle = await open(selected, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum) {
      throw new Error(`${label} must be a bounded regular file`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size) throw new Error(`${label} changed while it was being read`);
    return bytes;
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`${label} must not be a symbolic link`);
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function verifyReleaseDescriptorProof({
  descriptorPath,
  bundlePath,
  expectedTag,
  cacheRoot,
  githubToken = process.env.GH_TOKEN,
  provisionVerifier = provisionPinnedCosign,
  executeVerifier = executeCosign,
} = {}) {
  const tag = requiredTag(expectedTag);
  const [descriptorBytes, bundleBytes] = await Promise.all([
    readBoundedRegular(descriptorPath, MAX_DESCRIPTOR_BYTES, "release descriptor"),
    readBoundedRegular(bundlePath, MAX_BUNDLE_BYTES, "release proof bundle"),
  ]);
  const verifier = await provisionVerifier({ cacheRoot });
  const temporary = await mkdtemp(join(tmpdir(), "ai-pin-revival-proof-"));
  const descriptor = join(temporary, "release.json");
  const bundle = join(temporary, "release.sigstore.json");
  try {
    await Promise.all([
      writeFile(descriptor, descriptorBytes, { flag: "wx", mode: 0o600 }),
      writeFile(bundle, bundleBytes, { flag: "wx", mode: 0o600 }),
    ]);
    await executeVerifier({
      executable: verifier,
      arguments: [
        "verify-blob",
        "--bundle", bundle,
        "--certificate-identity", expectedReleaseWorkflowIdentity(tag),
        "--certificate-oidc-issuer", RELEASE_PROOF_POLICY.oidcIssuer,
        "--certificate-github-workflow-repository", RELEASE_PROOF_POLICY.repository,
        "--certificate-github-workflow-name", RELEASE_PROOF_POLICY.workflowName,
        "--certificate-github-workflow-ref", `refs/tags/${tag}`,
        "--certificate-github-workflow-trigger", RELEASE_PROOF_POLICY.event,
        descriptor,
      ],
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  let document;
  try {
    document = JSON.parse(descriptorBytes.toString("utf8"));
  } catch {
    throw new Error("verified release descriptor is not valid JSON");
  }
  const validated = validateReleaseDescriptor(document);
  if (validated.source.repository !== RELEASE_PROOF_POLICY.repository || validated.source.tag !== tag) {
    throw new Error("verified release descriptor does not match the expected repository and tag");
  }
  return validated;
}

function validateEmbeddedReleaseBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 2) {
    throw new Error("embedded operator release must use schemaVersion 2");
  }
  const tag = requiredTag(`v${value.version}`);
  if (!value.source || typeof value.source !== "object" || Array.isArray(value.source) ||
      Object.keys(value.source).sort().join("\0") !== "repository\0tag" ||
      value.source.repository !== RELEASE_PROOF_POLICY.repository || value.source.tag !== tag) {
    throw new Error("embedded operator release source is not the expected repository and tag");
  }
  return Object.freeze({
    schemaVersion: 2,
    version: value.version,
    source: Object.freeze({ ...value.source }),
    pin: validatePinPayload(value.pin),
  });
}

export function publishedReleaseProofUrls(version) {
  const tag = requiredTag(`v${version}`);
  return Object.freeze({
    descriptor: publishedReleaseAssetUrl(tag, `ai-pin-revival-${version}.release.json`),
    bundle: publishedReleaseAssetUrl(tag, releaseProofBundleName(version)),
  });
}

export function publishedReleaseAssetUrl(tag, name) {
  const selectedTag = requiredTag(tag);
  const [selectedName] = requiredAssetNames([name]);
  return `https://github.com/${RELEASE_PROOF_POLICY.repository}/releases/download/${selectedTag}/${selectedName}`;
}

export async function verifyPublishedReleaseBinding({
  embedded,
  fetchImpl = globalThis.fetch,
  cacheRoot,
  githubToken = process.env.GH_TOKEN,
  provisionVerifier = provisionPinnedCosign,
  executeVerifier = executeCosign,
} = {}) {
  const expected = validateEmbeddedReleaseBinding(embedded);
  const urls = publishedReleaseProofUrls(expected.version);
  const descriptorName = new URL(urls.descriptor).pathname.split("/").at(-1);
  const bundleName = new URL(urls.bundle).pathname.split("/").at(-1);
  const assets = await resolvePublishedReleaseAssets({
    tag: expected.source.tag,
    names: [descriptorName, bundleName],
    fetchImpl,
    githubToken,
  });
  if (assets[descriptorName].size > MAX_DESCRIPTOR_BYTES || assets[bundleName].size > MAX_BUNDLE_BYTES) {
    throw new Error("published release proof assets exceed their bounded sizes");
  }
  const [descriptorResponse, bundleResponse] = await Promise.all([
    fetchPublishedReleaseAsset({ asset: assets[descriptorName], fetchImpl, githubToken }),
    fetchPublishedReleaseAsset({ asset: assets[bundleName], fetchImpl, githubToken }),
  ]);
  const [descriptorBytes, bundleBytes] = await Promise.all([
    boundedResponseBytes(
      descriptorResponse, MAX_DESCRIPTOR_BYTES, "release descriptor download", assets[descriptorName].size,
    ),
    boundedResponseBytes(
      bundleResponse, MAX_BUNDLE_BYTES, "release proof download", assets[bundleName].size,
    ),
  ]);
  const temporary = await mkdtemp(join(tmpdir(), "ai-pin-revival-published-proof-"));
  const descriptorPath = join(temporary, `ai-pin-revival-${expected.version}.release.json`);
  const bundlePath = join(temporary, releaseProofBundleName(expected.version));
  try {
    await Promise.all([
      writeFile(descriptorPath, descriptorBytes, { flag: "wx", mode: 0o600 }),
      writeFile(bundlePath, bundleBytes, { flag: "wx", mode: 0o600 }),
    ]);
    const descriptor = await verifyReleaseDescriptorProof({
      descriptorPath,
      bundlePath,
      expectedTag: expected.source.tag,
      cacheRoot,
      provisionVerifier,
      executeVerifier,
    });
    if (descriptor.version !== expected.version ||
        canonicalJson(descriptor.source) !== canonicalJson(expected.source) ||
        canonicalJson(descriptor.pin) !== canonicalJson(expected.pin)) {
      throw new Error("verified release descriptor does not match the embedded operator release binding");
    }
    return Object.freeze({
      schemaVersion: 2,
      version: descriptor.version,
      source: descriptor.source,
      pin: descriptor.pin,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {};
  const names = new Map([
    ["--descriptor", "descriptorPath"],
    ["--bundle", "bundlePath"],
    ["--tag", "expectedTag"],
    ["--cache", "cacheRoot"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json" && options.json !== true) {
      options.json = true;
      continue;
    }
    const name = names.get(argument);
    if (!name || Object.hasOwn(options, name)) throw new Error(`unknown or repeated option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[name] = value;
    index += 1;
  }
  for (const name of ["descriptorPath", "bundlePath", "expectedTag"]) {
    if (!options[name]) throw new Error("usage: release-proof.mjs --descriptor FILE --bundle FILE --tag vVERSION [--cache DIR] [--json]");
  }
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  const descriptor = await verifyReleaseDescriptorProof(options);
  process.stdout.write(options.json
    ? `${JSON.stringify({
      schemaVersion: 1,
      verified: true,
      version: descriptor.version,
      revision: descriptor.revision,
      source: descriptor.source,
    })}\n`
    : `Verified Ai Pin Revival ${descriptor.version} from ${descriptor.source.repository}\n`);
}

if (resolve(process.argv[1] || "") === resolve(SELF_PATH)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
