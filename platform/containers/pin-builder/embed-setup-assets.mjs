#!/usr/bin/env node

// Convert a prepared static setup-page directory into the single deterministic
// asset pack linked by the Rust server. The release build consumes only the
// committed pack; it never requires Node, a sibling checkout, or a laptop at
// device runtime.

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = await realpath(
  process.env.AI_PIN_SOURCE_ROOT ?? resolve(scriptDir, "../../../pin"),
);

function isInsideRepository(candidatePath) {
  const normalized = resolve(candidatePath);
  return normalized === repositoryRoot || normalized.startsWith(repositoryRoot + sep);
}

function validateRepositoryContainment(candidatePath, label) {
  if (!isInsideRepository(candidatePath)) {
    throw new Error(`${label} must resolve inside repository: ${candidatePath}`);
  }
}

async function resolveWithRealpath(candidatePath) {
  try {
    return await realpath(candidatePath);
  } catch {
    return resolve(candidatePath);
  }
}

// Input is the device-owned static setup page checked in under the runtime
// crate — plain HTML, CSS, and JS, so the pack is regenerable straight from
// committed source with no bundler in the loop. This used to be fed from a
// browser SPA's build output, which made the device image depend on a Node
// toolchain it has no other use for. An explicit first positional argument
// still lets a caller pack some other prepared directory.
//
// `--check` regenerates the pack and compares it with the committed file
// instead of replacing it, so a source edit that nobody re-embedded fails a
// gate instead of shipping a stale pack into the device image. The comparison
// is done in memory: the check has to be safe to run against a read-only
// source mount, and the release build's /workspace mount is exactly that.
const commandLineArguments = process.argv.slice(2);
const checkMode = commandLineArguments.includes("--check");
const positionalArguments = commandLineArguments.filter(
  (argument) => argument !== "--check",
);
for (const argument of positionalArguments) {
  if (argument.startsWith("-")) {
    throw new Error(
      `unknown option ${argument}; usage: node platform/containers/pin-builder/embed-setup-assets.mjs [--check] [input-dir] [output-file]`,
    );
  }
}

const rawInputDir = positionalArguments[0] ?? "runtime/core/assets/setup-page";
const rawOutputFile = positionalArguments[1] ?? "runtime/core/assets/setup-assets.json";

function driftMessage(packPath) {
  return (
    `Setup asset pack drift in ${packPath}; run ` +
    `node platform/containers/pin-builder/embed-setup-assets.mjs to regenerate it`
  );
}

const inputDir = isAbsolute(rawInputDir) ? rawInputDir : resolve(repositoryRoot, rawInputDir);
const outputFile = isAbsolute(rawOutputFile) ? rawOutputFile : resolve(repositoryRoot, rawOutputFile);

const resolvedInputDir = await resolveWithRealpath(inputDir);
validateRepositoryContainment(resolvedInputDir, "input directory");

let inputRoot;
try {
  inputRoot = await realpath(inputDir);
} catch (error) {
  throw new Error(`input directory does not exist or is not accessible: ${inputDir}`);
}
validateRepositoryContainment(inputRoot, "resolved input directory");

const outputDir = dirname(outputFile);
let resolvedOutputDir;
try {
  resolvedOutputDir = await realpath(outputDir);
} catch (error) {
  // A missing output directory in check mode is itself drift — the committed
  // pack is gone. Creating it would be a write, which check mode never does.
  if (checkMode) {
    throw new Error(driftMessage(resolve(outputDir, basename(outputFile))));
  }
  await mkdir(outputDir, { recursive: true });
  resolvedOutputDir = await realpath(outputDir);
}
validateRepositoryContainment(resolvedOutputDir, "output directory");
const resolvedOutputFile = resolve(resolvedOutputDir, basename(outputFile));

const allowedExtensions = new Set([".html", ".js", ".css", ".svg", ".png", ".webp"]);
const textExtensions = new Set([".html", ".js", ".css", ".svg"]);
const excludedPaths = new Set(["setup.html"]);
const maxAssetCount = 64;
const maxAssetBytes = 2 * 1024 * 1024;
const maxTotalBytes = 4 * 1024 * 1024;

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function validateRelativePath(pathSegment) {
  const segments = pathSegment.split("/");
  if (
    pathSegment.length === 0 ||
    pathSegment.length > 256 ||
    pathSegment.startsWith("/") ||
    pathSegment.endsWith("/") ||
    pathSegment.includes("\\") ||
    ![...pathSegment].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x21 && code <= 0x7e;
    }) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe Setup asset path: ${pathSegment}`);
  }
}

async function collectFiles(root, directory = root) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => bytewiseCompare(left.name, right.name));
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Setup build must not contain symlinks: ${absolute}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectFiles(root, absolute)));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`unsupported Setup build entry: ${absolute}`);
    }
    const assetPath = relative(root, absolute).split(sep).join("/");
    validateRelativePath(assetPath);
    if (excludedPaths.has(assetPath) || extname(assetPath) === ".map") continue;
    if (!allowedExtensions.has(extname(assetPath))) {
      throw new Error(`unsupported Setup runtime asset type: ${assetPath}`);
    }
    files.push({ absolute, path: assetPath });
  }
  return files;
}

const files = (await collectFiles(inputRoot)).sort((left, right) =>
  bytewiseCompare(left.path, right.path),
);
if (files.length === 0 || files.length > maxAssetCount) {
  throw new Error(`Setup asset count must be between 1 and ${maxAssetCount}`);
}

const assets = [];
const bundleHasher = createHash("sha256");
let totalBytes = 0;
for (const file of files) {
  const content = await readFile(file.absolute);
  if (content.byteLength > maxAssetBytes) {
    throw new Error(`Setup asset exceeds ${maxAssetBytes} bytes: ${file.path}`);
  }
  totalBytes += content.byteLength;
  if (totalBytes > maxTotalBytes) {
    throw new Error(`Setup runtime assets exceed ${maxTotalBytes} bytes`);
  }
  if (textExtensions.has(extname(file.path))) {
    try {
      fatalUtf8Decoder.decode(content);
    } catch {
      throw new Error(`Setup asset is not valid UTF-8: ${file.path}`);
    }
  }
  bundleHasher.update(file.path);
  bundleHasher.update("\0");
  bundleHasher.update(content);
  bundleHasher.update("\0");
  assets.push({
    path: file.path,
    sha256: digest(content),
    content_base64: content.toString("base64"),
  });
}

const index = assets.find((asset) => asset.path === "index.html");
if (!index) throw new Error("Setup build is missing index.html");
const indexText = fatalUtf8Decoder.decode(
  Buffer.from(index.content_base64, "base64"),
);
if (!indexText.includes('/setup/')) {
  throw new Error("Setup index was not built with the /setup/ base path");
}
for (const match of indexText.matchAll(/(?:src|href)="\/setup\/([^"?#]+)"/g)) {
  const referencedPath = match[1];
  if (!assets.some((asset) => asset.path === referencedPath)) {
    throw new Error(`Setup index references an unpacked runtime asset: ${referencedPath}`);
  }
}

const pack = {
  schema_version: 1,
  base_path: "/setup/",
  bundle_sha256: bundleHasher.digest("hex"),
  assets,
};

const serializedPack = `${JSON.stringify(pack)}\n`;

// Same-directory temporary path: rename stays on one filesystem.
let temporaryPath = null;

async function cleanupTemporaryPath() {
  if (!temporaryPath) return;
  const pathToClean = temporaryPath;
  temporaryPath = null;
  try {
    await rm(pathToClean, { recursive: true, force: true });
  } catch {}
}

const signalHandler = async () => {
  await cleanupTemporaryPath();
  process.exit(130);
};

function installSignalHandlers() {
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
}

function removeSignalHandlers() {
  process.removeListener("SIGINT", signalHandler);
  process.removeListener("SIGTERM", signalHandler);
}

if (checkMode) {
  let committedPack = null;
  try {
    committedPack = await readFile(resolvedOutputFile, "utf8");
  } catch {}
  if (committedPack !== serializedPack) {
    throw new Error(driftMessage(resolvedOutputFile));
  }

  console.log(
    `Verified ${assets.length} Setup assets (${totalBytes} bytes) in ${resolvedOutputFile}`,
  );
} else {
  temporaryPath = await mkdtemp(resolve(resolvedOutputDir, ".setup-assets-tmp-"));
  installSignalHandlers();

  try {
    const temporaryOutput = resolve(temporaryPath, "setup-assets.json");
    await writeFile(temporaryOutput, serializedPack, {
      encoding: "utf8",
      mode: 0o644,
    });

    const yieldMs = Math.max(0, Math.min(30000, Number(process.env.PENUMBRA_EMBED_YIELD_MS) || 0));
    if (yieldMs > 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, yieldMs));
    }

    await rename(temporaryOutput, resolvedOutputFile);
    await cleanupTemporaryPath();
    removeSignalHandlers();

    console.log(
      `Embedded ${assets.length} Setup assets (${totalBytes} bytes) into ${resolvedOutputFile}`,
    );
  } catch (error) {
    await cleanupTemporaryPath();
    removeSignalHandlers();
    throw error;
  }
}
