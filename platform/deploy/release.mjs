#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const DEFAULT_CONFIG = join(DEFAULT_ROOT, "platform", "deploy", "release.json");
const MANIFEST_SCHEMA_VERSION = 1;
const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_ARCHIVE_BYTES = 1024 * 1024 * 1024;

const HIGH_CONFIDENCE_SECRET_PATTERNS = Object.freeze([
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["GitHub access token", /gh[pousr]_[A-Za-z0-9]{30,}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["OpenAI project key", /sk-proj-[A-Za-z0-9_-]{40,}/],
  ["Slack access token", /xox[baprs]-[A-Za-z0-9-]{20,}/],
  ["Azure Storage account key", /AccountKey=[A-Za-z0-9+/=]{32,}/],
  [
    "private key material",
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{32,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ],
]);

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toPosixPath(value) {
  return value.split(sep).join("/");
}

function pathIsWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateRelativePath(value, label = "path") {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  if (value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
    fail(`${label} must be a portable relative path: ${JSON.stringify(value)}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(`${label} contains an unsafe path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function releasePathIsWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${label} must be an array of strings`);
  }
  return value;
}

export async function loadReleaseConfig(configPath = DEFAULT_CONFIG) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    fail(`cannot read release source config ${configPath}: ${error.message}`);
  }

  if (config?.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(`unsupported release source schema: ${String(config?.schemaVersion)}`);
  }
  if (!config.profiles || typeof config.profiles !== "object") {
    fail("release source config must define profiles");
  }
  for (const [profileName, profile] of Object.entries(config.profiles)) {
    assertStringArray(profile?.include, `profiles.${profileName}.include`);
    assertStringArray(profile?.exclude ?? [], `profiles.${profileName}.exclude`);
    for (const includedPath of profile.include) {
      validateRelativePath(includedPath, `profiles.${profileName}.include entry`);
    }
    for (const excludedPath of profile.exclude ?? []) {
      validateRelativePath(excludedPath, `profiles.${profileName}.exclude entry`);
      if (!profile.include.some((includedPath) => releasePathIsWithin(includedPath, excludedPath))) {
        fail(
          `profiles.${profileName}.exclude entry is not beneath an included path: ${excludedPath}`,
        );
      }
    }
  }
  for (const key of [
    "ignoredDirectoryNames",
    "ignoredFileNames",
    "ignoredExtensions",
    "forbiddenRootDirectories",
    "forbiddenDirectoryNames",
    "forbiddenExtensions",
  ]) {
    assertStringArray(config[key], key);
  }
  return config;
}

function canonicalManifestPayload(profile, entries) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    profile,
    entries,
  };
}

function manifestReleaseId(profile, entries) {
  return sha256(JSON.stringify(canonicalManifestPayload(profile, entries)));
}

function normalizedMode(stat) {
  return stat.mode & 0o111 ? "0755" : "0644";
}

function looksLikeText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return !sample.includes(0);
}

function inspectContent(buffer, releasePath, context) {
  if (!looksLikeText(buffer)) return;
  const text = buffer.toString("utf8");
  const macTemporaryRoot = ["", "private", "var", "folders", ""].join("/");
  const machinePaths = [context.root, context.home, macTemporaryRoot]
    .filter((value) => typeof value === "string" && value.length > 1)
    .map((value) => (value.endsWith("/") ? value : `${value}/`));

  for (const machinePath of machinePaths) {
    if (text.includes(machinePath)) {
      fail(`machine-local path found in release source: ${releasePath}`);
    }
  }
  for (const [kind, pattern] of HIGH_CONFIDENCE_SECRET_PATTERNS) {
    if (pattern.test(text)) {
      fail(`${kind} detected in release source: ${releasePath}`);
    }
  }
}

function validateFileName(releasePath, config) {
  const name = basename(releasePath);
  const lowerName = name.toLowerCase();
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    fail(`environment file is forbidden in a release: ${releasePath}`);
  }
  if (name === ".npmrc") {
    fail(`credential-bearing npm config is forbidden in a release: ${releasePath}`);
  }
  if (
    config.forbiddenExtensions.some((extension) => {
      const lowerExtension = extension.toLowerCase();
      return lowerName.endsWith(lowerExtension) || lowerName.includes(`${lowerExtension}.`);
    })
  ) {
    fail(`forbidden artifact type in release source: ${releasePath}`);
  }
}

function validateIncludedPath(includedPath, config) {
  const firstSegment = includedPath.split("/")[0];
  if (config.forbiddenRootDirectories.includes(firstSegment)) {
    fail(`profile cannot include forbidden root directory: ${includedPath}`);
  }
  const segments = includedPath.split("/");
  for (const segment of segments) {
    if (config.ignoredDirectoryNames.includes(segment)) {
      fail(`profile cannot explicitly include generated directory: ${includedPath}`);
    }
    if (config.forbiddenDirectoryNames.includes(segment)) {
      fail(`profile cannot include proprietary or private directory: ${includedPath}`);
    }
  }
}

async function collectReleaseFiles({ root, profile, config }) {
  const profileConfig = config.profiles[profile];
  if (!profileConfig) {
    fail(`unknown release profile ${JSON.stringify(profile)}; expected ${Object.keys(config.profiles).join(", ")}`);
  }

  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`release source root must be a real directory: ${root}`);
  }
  const canonicalRoot = await realpath(root);
  const files = new Map();
  const ignoredDirectories = new Set(config.ignoredDirectoryNames);
  const ignoredFiles = new Set(config.ignoredFileNames);
  const ignoredExtensions = config.ignoredExtensions.map((extension) => extension.toLowerCase());
  const forbiddenDirectories = new Set(config.forbiddenDirectoryNames);
  const excludedPaths = profileConfig.exclude ?? [];

  async function visit(absolutePath, releasePath) {
    if (excludedPaths.some((excludedPath) => releasePathIsWithin(excludedPath, releasePath))) {
      return;
    }
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      fail(`symbolic links are forbidden in release source: ${releasePath}`);
    }
    if (stat.isDirectory()) {
      const directoryName = basename(releasePath);
      if (ignoredDirectories.has(directoryName)) return;
      if (forbiddenDirectories.has(directoryName)) {
        fail(`proprietary or private directory found in release source: ${releasePath}`);
      }
      const names = (await readdir(absolutePath)).sort((a, b) => a.localeCompare(b, "en"));
      for (const name of names) {
        const childPath = `${releasePath}/${name}`;
        await visit(join(absolutePath, name), childPath);
      }
      return;
    }
    if (!stat.isFile()) {
      fail(`only regular files may be packaged: ${releasePath}`);
    }
    if (ignoredFiles.has(basename(releasePath))) return;
    const lowerName = basename(releasePath).toLowerCase();
    if (ignoredExtensions.some((extension) => lowerName.endsWith(extension))) return;
    validateRelativePath(releasePath, "release path");
    validateFileName(releasePath, config);
    if (files.has(releasePath)) fail(`duplicate release path: ${releasePath}`);
    const data = await readFile(absolutePath);
    inspectContent(data, releasePath, {
      root: canonicalRoot,
      home: homedir(),
    });
    files.set(releasePath, {
      data,
      mode: normalizedMode(stat),
      path: releasePath,
      sha256: sha256(data),
      size: data.length,
    });
  }

  for (const includedPath of profileConfig.include) {
    validateIncludedPath(includedPath, config);
    const absolutePath = resolve(canonicalRoot, includedPath);
    if (!pathIsWithin(canonicalRoot, absolutePath)) {
      fail(`included path escapes release root: ${includedPath}`);
    }
    const stat = await optionalLstat(absolutePath);
    if (!stat) fail(`required release source is missing: ${includedPath}`);
    await visit(absolutePath, toPosixPath(includedPath));
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}

async function resolveProspectivePath(path) {
  let cursor = path;
  const missingSegments = [];
  while (!(await optionalLstat(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) fail(`cannot resolve prospective output path: ${path}`);
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(await realpath(cursor), ...missingSegments);
}

function writeString(target, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) fail(`tar header field is too long: ${value}`);
  encoded.copy(target, offset);
}

function writeOctal(target, offset, length, value) {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) fail(`tar numeric field is too large: ${value}`);
  writeString(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const separators = [...path.matchAll(/\//g)].map((match) => match.index);
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const splitAt = separators[index];
    const prefix = path.slice(0, splitAt);
    const name = path.slice(splitAt + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  fail(`release path cannot be represented safely in a ustar archive: ${path}`);
}

function tarHeader(entry) {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  const { name, prefix } = splitTarPath(entry.path);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, Number.parseInt(entry.mode, 8));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function createTarGzip(records) {
  const chunks = [];
  for (const record of records) {
    chunks.push(tarHeader(record), record.data);
    const padding = (TAR_BLOCK_BYTES - (record.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(TAR_END_BYTES));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

async function atomicWrite(path, data, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  const existing = await optionalLstat(path);
  if (existing?.isSymbolicLink()) fail(`refusing to replace symbolic link: ${path}`);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function parseOctal(buffer, offset, length, label) {
  const raw = buffer
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  if (!/^[0-7]+$/.test(raw)) fail(`invalid tar ${label}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`invalid tar ${label}`);
  return value;
}

function readTarString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function tarHeaderChecksum(header) {
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  return copy.reduce((sum, byte) => sum + byte, 0);
}

function parseTarGzip(archive) {
  let tar;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_EXTRACTED_ARCHIVE_BYTES });
  } catch (error) {
    fail(`cannot decompress release archive: ${error.message}`);
  }
  const records = [];
  const seen = new Set();
  let offset = 0;
  let sawEnd = false;
  while (offset + TAR_BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    const expectedChecksum = parseOctal(header, 148, 8, "checksum");
    if (tarHeaderChecksum(header) !== expectedChecksum) fail("tar header checksum mismatch");
    const type = String.fromCharCode(header[156]);
    if (type !== "0" && type !== "\0") {
      fail(`release archive contains a non-regular entry of type ${JSON.stringify(type)}`);
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    validateRelativePath(path, "archive path");
    if (seen.has(path)) fail(`release archive contains duplicate path: ${path}`);
    seen.add(path);
    const size = parseOctal(header, 124, 12, "size");
    const mode = parseOctal(header, 100, 8, "mode");
    if (offset + size > tar.length) fail(`truncated release archive entry: ${path}`);
    const data = Buffer.from(tar.subarray(offset, offset + size));
    offset += size;
    offset += (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    records.push({ data, mode: mode.toString(8).padStart(4, "0"), path, size });
  }
  if (!sawEnd) fail("release archive has no end marker");
  if (tar.subarray(offset).some((byte) => byte !== 0)) {
    fail("release archive contains trailing non-zero data");
  }
  return records;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("release manifest must be an object");
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(`unsupported release manifest schema: ${String(manifest.schemaVersion)}`);
  }
  if (typeof manifest.profile !== "string" || !manifest.profile) {
    fail("release manifest profile is invalid");
  }
  if (!Array.isArray(manifest.entries)) fail("release manifest entries must be an array");
  let priorPath = "";
  const paths = new Set();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object") fail("release manifest entry is invalid");
    validateRelativePath(entry.path, "manifest path");
    if (paths.has(entry.path)) fail(`duplicate manifest path: ${entry.path}`);
    if (priorPath && priorPath.localeCompare(entry.path, "en") >= 0) {
      fail("release manifest entries are not strictly sorted by path");
    }
    paths.add(entry.path);
    priorPath = entry.path;
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`invalid sha256 for ${entry.path}`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail(`invalid size for ${entry.path}`);
    if (!/^(?:0644|0755)$/.test(entry.mode)) fail(`invalid mode for ${entry.path}`);
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== "mode,path,sha256,size") fail(`unexpected manifest fields for ${entry.path}`);
  }
  const expectedReleaseId = manifestReleaseId(manifest.profile, manifest.entries);
  if (manifest.releaseId !== expectedReleaseId) {
    fail("release manifest digest does not match releaseId");
  }
  const keys = Object.keys(manifest).sort().join(",");
  if (keys !== "entries,profile,releaseId,schemaVersion") {
    fail("release manifest contains unexpected fields");
  }
  return manifest;
}

async function assertRegularFile(path, label) {
  const stat = await optionalLstat(path);
  if (!stat) fail(`${label} does not exist: ${path}`);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular file, not a symbolic link or special file: ${path}`);
  }
  return stat;
}

export async function verifyRelease({ archivePath, manifestPath }) {
  await assertRegularFile(manifestPath, "release manifest");
  const archiveStat = await assertRegularFile(archivePath, "release archive");
  if (archiveStat.size > MAX_ARCHIVE_BYTES) fail("release archive exceeds the verification size limit");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(`cannot read release manifest ${manifestPath}: ${error.message}`);
  }
  validateManifest(manifest);
  const records = parseTarGzip(await readFile(archivePath));
  if (records.length !== manifest.entries.length) {
    fail(`archive has ${records.length} files but manifest has ${manifest.entries.length}`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "ai-pin-revival-verify-"));
  try {
    for (let index = 0; index < manifest.entries.length; index += 1) {
      const expected = manifest.entries[index];
      const actual = records[index];
      if (actual.path !== expected.path) {
        fail(`archive path mismatch: expected ${expected.path}, got ${actual.path}`);
      }
      if (actual.size !== expected.size || actual.data.length !== expected.size) {
        fail(`archive size mismatch for ${expected.path}`);
      }
      if (actual.mode !== expected.mode) fail(`archive mode mismatch for ${expected.path}`);
      if (sha256(actual.data) !== expected.sha256) fail(`archive hash mismatch for ${expected.path}`);

      const destination = resolve(temporaryRoot, expected.path);
      if (!pathIsWithin(temporaryRoot, destination)) fail(`archive path escapes extraction root: ${expected.path}`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, actual.data, { flag: "wx", mode: Number.parseInt(expected.mode, 8) });
      await chmod(destination, Number.parseInt(expected.mode, 8));
    }

    for (const expected of manifest.entries) {
      const extractedPath = resolve(temporaryRoot, expected.path);
      const stat = await lstat(extractedPath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`extracted entry is not a regular file: ${expected.path}`);
      const data = await readFile(extractedPath);
      if (data.length !== expected.size || sha256(data) !== expected.sha256) {
        fail(`extracted file verification failed: ${expected.path}`);
      }
      if (normalizedMode(stat) !== expected.mode) fail(`extracted mode verification failed: ${expected.path}`);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  return {
    ok: true,
    releaseId: manifest.releaseId,
    profile: manifest.profile,
    files: manifest.entries.length,
  };
}

export async function buildRelease({
  profile,
  outputDirectory,
  root = DEFAULT_ROOT,
  configPath = join(root, "platform", "deploy", "release.json"),
}) {
  if (typeof profile !== "string" || !profile) fail("build requires --profile");
  if (typeof outputDirectory !== "string" || !outputDirectory) fail("build requires --output");
  const resolvedRoot = resolve(root);
  const outputPath = resolve(outputDirectory);
  const rootStat = await lstat(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`release source root must be a real directory: ${resolvedRoot}`);
  }
  const canonicalRoot = await realpath(resolvedRoot);
  const canonicalOutput = await resolveProspectivePath(outputPath);
  if (pathIsWithin(canonicalRoot, canonicalOutput)) {
    fail(`release output must be outside the source root: ${outputPath}`);
  }
  const outputStat = await optionalLstat(outputPath);
  if (outputStat?.isSymbolicLink()) fail(`release output cannot be a symbolic link: ${outputPath}`);
  if (outputStat && !outputStat.isDirectory()) fail(`release output is not a directory: ${outputPath}`);
  await mkdir(outputPath, { recursive: true });

  const config = await loadReleaseConfig(configPath);
  const records = await collectReleaseFiles({ root: resolvedRoot, profile, config });
  const entries = records.map(({ mode, path, sha256: digest, size }) => ({
    path,
    sha256: digest,
    size,
    mode,
  }));
  const releaseId = manifestReleaseId(profile, entries);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    profile,
    releaseId,
    entries,
  };
  const archivePath = join(outputPath, `${profile}-${releaseId}.tar.gz`);
  const manifestPath = join(outputPath, `${profile}-${releaseId}.manifest.json`);
  await atomicWrite(archivePath, createTarGzip(records));
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await verifyRelease({ archivePath, manifestPath });
  return { releaseId, archivePath, manifestPath };
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!command || !["build", "verify"].includes(command)) {
    fail("usage: release.mjs <build|verify> [options]");
  }
  const options = { command, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--json") {
      if (options.json) fail("--json may only be specified once");
      options.json = true;
      continue;
    }
    const optionNames = {
      "--archive": "archivePath",
      "--manifest": "manifestPath",
      "--output": "outputDirectory",
      "--profile": "profile",
    };
    const key = optionNames[argument];
    if (!key) fail(`unknown option: ${argument}`);
    if (options[key] !== undefined) fail(`${argument} may only be specified once`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

async function main(argv) {
  const options = parseCli(argv);
  if (options.command === "build") {
    if (options.archivePath || options.manifestPath) fail("build does not accept --archive or --manifest");
    const result = await buildRelease(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`built ${result.releaseId} at ${result.archivePath}\n`);
    return;
  }
  if (options.profile || options.outputDirectory) fail("verify does not accept --profile or --output");
  if (!options.archivePath) fail("verify requires --archive");
  if (!options.manifestPath) fail("verify requires --manifest");
  const result = await verifyRelease(options);
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`verified ${result.releaseId} (${result.files} files, ${result.profile})\n`);
}

if (resolve(process.argv[1] ?? "") === resolve(SCRIPT_PATH)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
