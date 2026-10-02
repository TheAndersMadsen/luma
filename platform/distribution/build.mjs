#!/usr/bin/env -S bun --no-env-file

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createReproducibleTar } from "../archive-tar.mjs";

import {
  canonicalJson,
  createReleaseDescriptor,
  isReleaseInstant,
  isUpdateSourceOrigin,
  loadReleaseInputs,
  validateReleaseNotes,
} from "./release-descriptor.mjs";
import { describePinReleaseArchive } from "../deploy/pin/import-release.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT), "../..");

const FILES = Object.freeze([
  ["bootstrap", "bootstrap", 0o755],
  ["bunfig.toml", "bunfig.toml", 0o644],
  [".env.example", ".env.example", 0o644],
  ["contracts/operator-setup.json", "contracts/operator-setup.json", 0o644],
  ["platform/cli/authority.js", "platform/cli/authority.js", 0o644],
  ["platform/cli/backup.js", "platform/cli/backup.js", 0o644],
  ["platform/cli/command-spec.js", "platform/cli/command-spec.js", 0o644],
  ["platform/cli/config.js", "platform/cli/config.js", 0o644],
  ["platform/cli/context.js", "platform/cli/context.js", 0o644],
  ["platform/cli/guided-production-setup.js", "platform/cli/guided-production-setup.js", 0o644],
  ["platform/cli/onboard.js", "platform/cli/onboard.js", 0o644],
  ["platform/cli/production-setup.js", "platform/cli/production-setup.js", 0o644],
  ["platform/cli/production.js", "platform/cli/production.js", 0o644],
  ["platform/cli/public-network.js", "platform/cli/public-network.js", 0o644],
  ["platform/cli/realm.js", "platform/cli/realm.js", 0o644],
  ["platform/cli/registry.js", "platform/cli/registry.js", 0o644],
  ["platform/cli/setup.js", "platform/cli/setup.js", 0o644],
  ["platform/cli/support-bundle.js", "platform/cli/support-bundle.js", 0o644],
  ["platform/cli/terminal.js", "platform/cli/terminal.js", 0o644],
  ["platform/cli/timing.js", "platform/cli/timing.js", 0o644],
  ["platform/cli/update.js", "platform/cli/update.js", 0o644],
  ["platform/deploy/pin/release.mjs", "platform/deploy/pin/release.mjs", 0o644],
  ["platform/deploy/pin/release-store-path.mjs", "platform/deploy/pin/release-store-path.mjs", 0o644],
  ["platform/deploy/pin/device-target-guard.mjs", "platform/deploy/pin/device-target-guard.mjs", 0o644],
  ["platform/deploy/pin/activate.mjs", "platform/deploy/pin/activate.mjs", 0o755],
  ["platform/deploy/pin/acquire-release.mjs", "platform/deploy/pin/acquire-release.mjs", 0o755],
  ["platform/deploy/pin/import-release.mjs", "platform/deploy/pin/import-release.mjs", 0o644],
  ["platform/deploy/pin/validate-release-store.mjs", "platform/deploy/pin/validate-release-store.mjs", 0o755],
  ["platform/distribution/release-descriptor.mjs", "platform/distribution/release-descriptor.mjs", 0o644],
  ["platform/distribution/release-proof.mjs", "platform/distribution/release-proof.mjs", 0o755],
  ["platform/distribution/release-signing.pub", "platform/distribution/release-signing.pub", 0o644],
  ["platform/distribution/update-source.json", "platform/distribution/update-source.json", 0o644],
  ["platform/setup/cloud-init.yaml", "platform/setup/cloud-init.yaml", 0o644],
  ["platform/deploy/vps/deploy.sh", "platform/deploy/vps/deploy.sh", 0o755],
  ["platform/deploy/vps/assistant-eval.mjs", "platform/deploy/vps/assistant-eval.mjs", 0o755],
  ["platform/deploy/vps/preflight.sh", "platform/deploy/vps/preflight.sh", 0o755],
  ["platform/deploy/vps/verify.sh", "platform/deploy/vps/verify.sh", 0o755],
  ["platform/distribution/OPERATOR-README.txt", "README.txt", 0o644],
  ["platform/distribution/operator-luma", "luma", 0o755],
  ["platform/edge/envoy/envoy.yaml.tpl", "platform/edge/envoy/envoy.yaml.tpl", 0o644],
  ["platform/edge/traefik/dynamic.yaml.tpl", "platform/edge/traefik/dynamic.yaml.tpl", 0o644],
  ["platform/edge/traefik/traefik.yaml.tpl", "platform/edge/traefik/traefik.yaml.tpl", 0o644],
  ["cosmos/search/settings.yml", "cosmos/search/settings.yml", 0o644],
  ["platform/containers/observability/prometheus.yml", "platform/containers/observability/prometheus.yml", 0o644],
]);

const DIRECTORIES = Object.freeze([
  ["platform/containers/observability/grafana", "platform/containers/observability/grafana"],
]);

// Every source path the bundle packs.
export const OPERATOR_SOURCES = Object.freeze([...FILES, ...DIRECTORIES].map(([source]) => source));

// The committed default update source (a fork edits the file): the origin
// whose /api/version every server of this release asks for newer releases
// unless its own setup names another.
export async function readUpdateSource(sourceRoot) {
  const file = join(sourceRoot, "platform/distribution/update-source.json");
  let document;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the update source ${file}: ${error.message}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      Object.keys(document).join() !== "origin" || !isUpdateSourceOrigin(document.origin) ||
      !document.origin.startsWith("https://")) {
    throw new Error(`${file} must be {"origin": "https://HOST"}: an https origin with no path`);
  }
  return document.origin;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function within(parent, candidate) {
  const selected = relative(parent, candidate);
  return selected === "" || (!selected.startsWith(`..${sep}`) && selected !== "..");
}

async function copyRegular(source, target, mode) {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`operator bundle input must be a regular file: ${source}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  await chmod(target, mode);
}

// Whether copyTree packs a path inside one of DIRECTORIES: dot entries other
// than .gitkeep stay behind.
function packedFromTree(relativePath) {
  return !relativePath.split(/[\\/]/u).some((part) => part.startsWith(".") && part !== ".gitkeep");
}

async function copyTree(source, target) {
  const metadata = await lstat(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`operator bundle input must be a real directory: ${source}`);
  }
  await cp(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (selected) => packedFromTree(relative(source, selected)),
  });
}

async function assertNoLinks(selected) {
  const metadata = await lstat(selected);
  if (metadata.isSymbolicLink()) throw new Error(`operator bundle must not contain links: ${selected}`);
  if (!metadata.isDirectory()) return;
  for (const name of await readdir(selected)) await assertNoLinks(join(selected, name));
}

// A release names one commit, so the bundle is packed only from that commit,
// checked out without changes. `git status` does not list ignored files, and
// DIRECTORIES are copied whole, so an ignored file the bundle would copy is
// refused as well.
function assertPackingRevision(sourceRoot, revision) {
  const git = (...args) => execFileSync("git", ["--no-optional-locks", "-C", sourceRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  let head;
  let changes;
  let ignored;
  try {
    head = git("rev-parse", "--verify", "HEAD");
    changes = git("status", "--porcelain");
    ignored = git("ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...OPERATOR_SOURCES)
      .split("\0")
      .filter((file) => file && DIRECTORIES.every(([directory]) =>
        !file.startsWith(`${directory}/`) || packedFromTree(file.slice(directory.length + 1))));
  } catch {
    throw new Error(`operator bundle source must be a git checkout with a commit: ${sourceRoot}`);
  }
  if (changes) {
    throw new Error(
      `refusing to pack a working tree with ${changes.split("\n").length} changed or untracked paths; ` +
        "commit or remove them (git status lists them), then pack the committed revision",
    );
  }
  if (ignored.length) {
    throw new Error(
      `refusing to pack ${ignored.length} git-ignored paths the operator bundle would copy: ` +
        `${ignored.slice(0, 5).join(", ")}${ignored.length > 5 ? ", ..." : ""}; ` +
        "remove them, then pack the committed revision",
    );
  }
  if (head !== revision) {
    throw new Error(`--revision ${revision} is not the checked-out HEAD ${head}; check out the release commit, then pack`);
  }
}

function parseArguments(argv) {
  const result = {};
  const names = new Map([
    ["--version", "version"],
    ["--revision", "revision"],
    ["--repository", "repository"],
    ["--tag", "tag"],
    ["--receipts", "receipts"],
    ["--pin-archive", "pinArchive"],
    ["--output", "output"],
    ["--root", "root"],
    ["--notes-file", "notesFile"],
    ["--published-at", "publishedAt"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const name = names.get(option);
    if (!name || Object.hasOwn(result, name)) throw new Error(`unknown or repeated option: ${option}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    result[name] = value;
    index += 1;
  }
  for (const required of ["version", "revision", "repository", "tag", "receipts", "pinArchive", "output"]) {
    if (!result[required]) throw new Error(`--${required} is required`);
  }
  return result;
}

// The release notes for the descriptor: the plain text of --notes-file, or
// none. The text is validated as the descriptor stores it.
async function releaseNotes(options) {
  if (!options.notesFile) return null;
  return validateReleaseNotes(await readFile(resolve(options.notesFile), "utf8"));
}

export async function buildOperatorBundle(options) {
  const sourceRoot = resolve(options.root || DEFAULT_ROOT);
  const output = resolve(options.output);
  if (within(sourceRoot, output)) throw new Error("--output must be outside the source tree");
  assertPackingRevision(sourceRoot, options.revision);
  await mkdir(output, { recursive: true });
  const stageParent = await mkdtemp(join(output, ".operator-build-"));
  const directoryName = `luma-operator-${options.version}`;
  const stage = join(stageParent, directoryName);
  const archiveName = `luma-operator-${options.version}-linux.tar.gz`;
  const archiveTemporary = join(stageParent, archiveName);
  const archive = join(output, archiveName);
  const descriptorName = `luma-${options.version}.release.json`;
  const descriptorPath = join(output, descriptorName);
  const checksumsPath = join(output, "SHA256SUMS");
  const pin = await describePinReleaseArchive({
    archive: resolve(options.pinArchive),
    expectedSigner: options.expectedPinSigner,
  });
  const updateSource = await readUpdateSource(sourceRoot);
  const notes = await releaseNotes(options);
  // When the release was published, as the descriptor and /api/version report
  // it. The packing moment unless the publisher names one.
  const publishedAt = options.publishedAt ?? new Date().toISOString();
  if (!isReleaseInstant(publishedAt)) throw new Error("--published-at must be an ISO 8601 UTC instant");
  const pinArchive = join(output, pin.archive);
  for (const target of [archive, descriptorPath, checksumsPath, pinArchive]) {
    try {
      await lstat(target);
      throw new Error(`refusing to replace release output: ${target}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  try {
    await mkdir(stage, { recursive: true });
    for (const [source, target, mode] of FILES) {
      await copyRegular(join(sourceRoot, source), join(stage, target), mode);
    }
    for (const [source, target] of DIRECTORIES) {
      await copyTree(join(sourceRoot, source), join(stage, target));
    }
    const release = await loadReleaseInputs(resolve(options.receipts));
    // The operator's own identity, which setup writes into runtime.env for
    // Center (version, tag, Pin release, notes, publication time) and which
    // names the default update source.
    const version = {
      schemaVersion: 2,
      version: options.version,
      revision: options.revision,
      application: release.application.reference,
      source: { repository: options.repository, tag: options.tag },
      pin,
      updateSource,
      notes,
      publishedAt,
    };
    const versionPath = join(stage, "platform/distribution/version.json");
    await mkdir(dirname(versionPath), { recursive: true });
    await writeFile(versionPath, `${JSON.stringify(version, null, 2)}\n`, { mode: 0o644, flag: "wx" });
    await assertNoLinks(stage);
    await createReproducibleTar({
      parent: stageParent,
      directory: directoryName,
      archive: archiveTemporary,
    });
    await rename(archiveTemporary, archive);
    const archiveBytes = await readFile(archive);
    const archiveSha256 = sha256(archiveBytes);
    const descriptor = createReleaseDescriptor({
      version: options.version,
      revision: options.revision,
      repository: options.repository,
      tag: options.tag,
      ...release,
      operator: { archive: archiveName, sha256: archiveSha256, size: archiveBytes.length },
      pin,
      updateSource,
      notes,
      publishedAt,
    });
    const descriptorBytes = `${canonicalJson(descriptor)}\n`;
    await writeFile(descriptorPath, descriptorBytes, { mode: 0o644, flag: "wx" });
    await copyRegular(resolve(options.pinArchive), pinArchive, 0o644);
    const rows = [
      `${archiveSha256}  ${archiveName}`,
      `${pin.sha256}  ${pin.archive}`,
      `${sha256(descriptorBytes)}  ${descriptorName}`,
    ].sort();
    await writeFile(checksumsPath, `${rows.join("\n")}\n`, { mode: 0o644, flag: "wx" });
    return Object.freeze({ archive: archiveName, descriptor: descriptorName, descriptorValue: descriptor });
  } finally {
    await rm(stageParent, { recursive: true, force: true });
  }
}

async function main() {
  const result = await buildOperatorBundle(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ archive: result.archive, descriptor: result.descriptor })}\n`);
}

if (resolve(process.argv[1] || "") === resolve(SCRIPT)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
