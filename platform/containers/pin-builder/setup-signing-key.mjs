#!/usr/bin/env node

// Generate a fork-owned Pin signing key and source-excluded env file that
// `:runtime:android:assembleRelease` reads, so a newcomer stops being blocked on the one
// artifact the repository can never ship.
//
// Why this exists
// ---------------
// The signing contract is fully externalized: `runtime/android/build.gradle.kts:36-45`
// resolves four values from Gradle properties or environment variables, and
// `hook/payload/build.gradle.kts` and `hook/loader/build.gradle.kts` repeat it verbatim.
// Nothing in the tree supplies a default, which is correct. This tool is the
// canonical creation path; `keytool -list` remains inspection-only.
//
// What this script refuses to do, and why
// ---------------------------------------
// An Android signer is package identity, not a release label. Overwriting a
// keystore does not "reset" a key, it destroys the only copy of an identity:
// every build made afterwards is a different package as far as Android is
// concerned, so nothing already installed can ever be upgraded in place again.
// That failure is silent at generation time and terminal months later. So an
// existing keystore or env file is refused outright. `--force` does not remove
// the guarantee — it moves the existing bytes to a verified backup first, and
// the write is blocked if that backup did not land byte-for-byte. keytool is
// also probed BEFORE any of that, so "no JDK on PATH" cannot become "the
// originals are deleted and the replacement was never generated", and if
// keytool fails anyway the error names the backup paths and the command that
// restores them.
//
// The same reasoning drives the gitignore gate. A keystore committed to a fork
// is a security incident with no clean remediation (history rewrite plus key
// rotation plus re-identifying every installed package). `.gitignore:46-56`
// already covers `*.keystore` and `secrets/`, but an ignore rule is a backstop,
// not a proof about the path this run was actually given. So the path is
// checked: outside the worktree it cannot be committed at all, inside it must
// be provably ignored by `git check-ignore`, and anything else refuses loudly.
//
// Passwords never reach argv. `keytool` has no `-storepass:env` or
// `-storepass:file` form (verified against the local `keytool -genkeypair
// -help`), and a password on argv is readable by every process on the host via
// `ps`. It is fed on stdin instead: measured on this host, PKCS12
// `-genkeypair` prompts exactly twice ("Enter keystore password:",
// "Re-enter new password:") and never asks for a separate key password, which
// is also why both PIN_SIGNING_*_PASSWORD values are written identically —
// PKCS12 has one password, and two different values produce signing failures
// that read like keystore corruption.
//
// keytool leaves the store at 0644 (measured). This script chmods it to 0600.
//
// This script does not build, install, commit, edit .gitignore, touch a device,
// or claim compatibility with the frozen release signer. Observed: the frozen
// signer fingerprint is recorded in `formatNextSteps`; a freshly generated key
// is a NEW package identity. That warning is printed, not buried.

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const PROGRAM = "setup-signing-key";
const runCommand = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(scriptDirectory, "../../../pin");

// Every secret this process holds, so that redaction is reachable from the
// top-level failure handler too. A password that leaks through an unexpected
// stack trace is exactly as exposed as one printed on purpose.
const ACTIVE_SECRETS = [];

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * The four names the build reads, in the order `runtime/android/build.gradle.kts:42-45`
 * declares them. Exported so the test asserts against the contract rather than
 * against a re-typed copy of it.
 */
export const REQUIRED_ENV_NAMES = Object.freeze([
  "PIN_SIGNING_STORE_FILE",
  "PIN_SIGNING_STORE_PASSWORD",
  "PIN_SIGNING_KEY_ALIAS",
  "PIN_SIGNING_KEY_PASSWORD",
]);

/** The Gradle-property spelling of the same four inputs, for the help text. */
export const REQUIRED_GRADLE_PROPERTIES = Object.freeze([
  "pinSigningStoreFile",
  "pinSigningStorePassword",
  "pinSigningKeyAlias",
  "pinSigningKeyPassword",
]);

// Deliberately NOT one of the four names above. Exporting a single
// PIN_SIGNING_* value puts the build into the partial state that throws at
// Gradle *configuration* time, which breaks even `./gradlew tasks`
// (`runtime/android/build.gradle.kts:29-34`). A distinct name cannot cause that.
export const PASSWORD_ENV_NAME = "PIN_SIGNING_SETUP_PASSWORD";

export const REDACTION = "[REDACTED]";

// Owner-only, both files. `.secrets`-style modes are checked elsewhere in the
// tree (platform/deploy/acceptance/pin/agentic-release-smoke.mjs rejects a token file with any group or
// other bits), so the same standard applies to material that is strictly more
// sensitive than a token.
export const KEYSTORE_MODE = 0o600;
export const ENV_FILE_MODE = 0o600;
export const SECRET_DIRECTORY_MODE = 0o700;

// Canonical operator state is external to the source tree. These defaults are
// shared with the root `./revival` command and honor its XDG/REVIVAL overrides.
const DEFAULT_CONFIG_ROOT = resolve(
  process.env.REVIVAL_CONFIG_DIR ??
    resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "ai-pin-revival"),
);
const DEFAULT_SECRETS_ROOT = resolve(
  process.env.REVIVAL_SECRETS_DIR ?? resolve(DEFAULT_CONFIG_ROOT, "secrets"),
);
export const DEFAULT_KEYSTORE_PATH = resolve(
  DEFAULT_SECRETS_ROOT,
  "pin/operator-signing.keystore",
);
export const DEFAULT_ENV_FILE_PATH = resolve(DEFAULT_SECRETS_ROOT, "pin/signing.env");

export const DEFAULT_ALIAS = "pin-fork";
export const DEFAULT_VALIDITY_DAYS = 10_000;
// Generic placeholder identity. Nothing here is personal data, and a self
// signed Android certificate's subject carries no trust weight.
export const DEFAULT_DNAME = "CN=PenumbraOS Fork, OU=Pin, O=PenumbraOS Revival Fork, C=US";
export const DEFAULT_KEY_ALGORITHM = "RSA";
export const DEFAULT_KEY_SIZE = 4096;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * A URL-safe password from `node:crypto`. 32 random bytes, so ~256 bits before
 * encoding; base64url so it needs no shell quoting and cannot be mangled by a
 * copy/paste through a terminal.
 */
export function generatePassword(byteLength = 32) {
  if (!Number.isInteger(byteLength) || byteLength < 16) {
    throw new Error("password entropy must be at least 16 bytes");
  }
  return randomBytes(byteLength).toString("base64url");
}

/**
 * Remove every supplied secret from `text`.
 *
 * Every byte this script prints goes through here, including the dry-run plan
 * and every line of keytool output. Literal replacement, all occurrences, regex
 * metacharacters escaped so a password containing `.` or `$` is still removed.
 */
export function redact(text, secrets = []) {
  let output = String(text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(escaped, "g"), REDACTION);
  }
  return output;
}

/**
 * Fail closed if redaction did not actually work.
 *
 * `redact` is simple enough to be obviously correct, which is exactly the kind
 * of function that gets refactored into being wrong. This asserts the property
 * at the boundary instead of trusting the implementation.
 */
export function assertRedacted(text, secrets = []) {
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    if (text.includes(secret)) {
      throw new Error("refusing to emit output that still contains a secret");
    }
  }
  return text;
}

/** POSIX single-quoting, so any password survives `source` byte-for-byte. */
export function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Every textual form a secret can take in this program's output.
 *
 * Found the hard way. A password containing a single quote is written into the
 * env file as `a'\''b`, which does not contain the substring `a'b` — so literal
 * redaction matched nothing and the characters went straight through to stdout
 * looking "escaped" rather than leaked. Redaction has to know about every
 * encoding the value passes through, not just the one it arrived in.
 */
export function secretVariants(secret) {
  if (typeof secret !== "string" || secret === "") return [];
  const quotedBody = secret.replace(/'/g, `'\\''`);
  return quotedBody === secret ? [secret] : [secret, quotedBody];
}

/**
 * The env file the build reads.
 *
 * All four names are written together, always. Writing them one at a time is
 * how a workstation ends up in the partial-input state that throws during
 * Gradle configuration for every task in `hook`, `injector` and `server`.
 * The store path is absolute because a relative value is resolved by
 * `rootProject.file(...)` against the repository root, not the shell's working
 * directory (`runtime/android/build.gradle.kts:186`) — a difference that silently works
 * from one directory and fails from another.
 */
export function renderEnvFile(values) {
  for (const name of REQUIRED_ENV_NAMES) {
    const value = values[name];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${name} must be a non-blank string`);
    }
  }
  if (!isAbsolute(values.PIN_SIGNING_STORE_FILE)) {
    throw new Error("PIN_SIGNING_STORE_FILE must be an absolute path");
  }
  if (values.PIN_SIGNING_STORE_PASSWORD !== values.PIN_SIGNING_KEY_PASSWORD) {
    // PKCS12 carries a single password. keytool ignores a distinct key
    // password for a PKCS12 store, so two different values here produce
    // signing failures that look like a corrupt keystore.
    throw new Error("PKCS12 requires the store and key passwords to be identical");
  }
  return [
    "# Pin signing inputs for hook/payload, hook/loader and runtime/android.",
    "# Generated by platform/containers/pin-builder/setup-signing-key.mjs. Never commit this file.",
    "# Canonical consumer: ./revival pin release build (no manual source step).",
    ...REQUIRED_ENV_NAMES.map((name) => `export ${name}=${shellSingleQuote(values[name])}`),
    "",
  ].join("\n");
}

/**
 * Why this run must stop, or null to proceed.
 *
 * The refusal names the consequence, because the consequence is not obvious:
 * losing a signing key is not "regenerate it", it is "every installed package
 * built with the old key is now un-upgradeable forever".
 */
export function refusalReason(existingPaths, force) {
  const existing = [...existingPaths];
  if (existing.length === 0) return null;
  if (force) return null;
  return [
    `refusing to overwrite existing signing material:`,
    ...existing.map((path) => `  ${path}`),
    "",
    "  A keystore is not a cache. Android treats the signer as package identity,",
    "  so replacing this key means nothing already installed from this fork can",
    "  ever be upgraded in place again — only uninstalled and reinstalled, losing",
    "  its data and its privileged relationships. There is no way to recover a",
    "  destroyed key, and the file is gitignored, so nothing can restore it.",
    "",
    "  If this keystore is already yours, do not regenerate it: point",
    `  ${REQUIRED_ENV_NAMES[0]} at it and reuse it.`,
    "",
    "  If you are certain these bytes are disposable, re-run with --force. That",
    "  copies each existing path to a timestamped backup beside it and verifies",
    "  the backup by digest before anything is written.",
  ].join("\n");
}

/**
 * Paths that exist but have no verified backup.
 *
 * This is the second half of the `--force` contract, kept separate and pure so
 * "backed up first" is a property a test can falsify rather than a code path a
 * reader has to trust.
 */
export function missingBackups(existingPaths, backups) {
  const backedUp = new Set(
    backups.filter((entry) => entry && entry.verified === true).map((entry) => entry.source),
  );
  return existingPaths.filter((path) => !backedUp.has(path));
}

/**
 * Did the backup capture the original exactly?
 *
 * A separate function rather than an inline `===` because the inline form was
 * unfalsifiable: on the happy path a copy always matches, so replacing the
 * comparison with `true` changed no observable behaviour and no test noticed.
 * A guard nothing can turn red is not a guard.
 */
export function backupIsVerified(sourceDigest, backupDigest) {
  return (
    typeof sourceDigest === "string" &&
    /^[0-9a-f]{64}$/.test(sourceDigest) &&
    sourceDigest === backupDigest
  );
}

/**
 * May the BACKUP of `sourcePath` be written?
 *
 * A backup carries the same private key as the original, so it faces the same
 * gate — but it must be gated on its OWN name, because a `.gitignore` rule
 * matches the original's name and not the backup's. Measured in this
 * repository: `*.keystore` (.gitignore:46) makes `mykey.keystore` ignored while
 * `mykey.keystore.backup-<ts>` is NOT, so gating only the source copies a
 * private key straight into the path `git add -A` will stage.
 *
 * Pure and exported so the hole stays closed by a test rather than by memory.
 */
export function backupTargetVerdict(sourcePath, timestamp, { repositoryRoot = REPOSITORY_ROOT, isIgnored } = {}) {
  return writeTargetVerdict(backupPathFor(sourcePath, timestamp), { repositoryRoot, isIgnored });
}

/** `<path>.backup-<timestamp>` — beside the original, never inside the repo if the original was not. */
export function backupPathFor(path, timestamp) {
  const stamp = String(timestamp).replace(/[:.]/g, "-");
  return `${path}.backup-${stamp}`;
}

/** Owner-only means no group and no other bits. */
export function modeIsOwnerOnly(mode) {
  return (mode & 0o077) === 0;
}

/** True when `path` is inside `root` (or is `root` itself). */
export function isInsideDirectory(path, root) {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

/**
 * May this run write to `path`?
 *
 * Two ways to pass, and only two:
 *   - the path is outside the worktree, so no Git operation in this repository
 *     can ever stage it;
 *   - the path is inside the worktree and `git check-ignore` proves it ignored.
 *
 * `isIgnored` is injected so the decision is testable without a Git process,
 * and so an *unknown* answer (Git missing, path unresolvable) is treated as
 * "not proven ignored" rather than as permission.
 */
export function writeTargetVerdict(path, { repositoryRoot = REPOSITORY_ROOT, isIgnored } = {}) {
  if (!isAbsolute(path)) {
    return { allowed: false, reason: "not an absolute path", detail: `${PROGRAM} resolves every target to an absolute path before writing.` };
  }
  if (!isInsideDirectory(path, repositoryRoot)) {
    return { allowed: true, reason: "outside the repository worktree" };
  }
  if (isIgnored === true) {
    return { allowed: true, reason: "inside the worktree and proven gitignored" };
  }
  return {
    allowed: false,
    reason: isIgnored === false ? "inside the worktree and NOT gitignored" : "inside the worktree and its ignore status could not be proven",
    detail: [
      `  ${path}`,
      "",
      "  This path is inside the repository and Git does not report it as ignored.",
      "  Writing key material there is a security incident waiting to be committed:",
      "  a leaked signing key cannot be un-leaked by deleting the commit, it can only",
      "  be rotated, which re-identifies every package built with it.",
      "",
      "  Choose a path outside the worktree instead — the default is",
      `  ${DEFAULT_KEYSTORE_PATH} — or one already covered by .gitignore.`,
      "  This script will not edit .gitignore for you; widening an ignore rule is a",
      "  reviewed decision, not a side effect of a setup helper.",
    ].join("\n"),
  };
}

/**
 * The keytool argv. It contains no password, by construction.
 *
 * keytool offers only `-storepass <arg>` / `-keypass <arg>` — no `:env` or
 * `:file` form (checked against `keytool -genkeypair -help` on this host) — and
 * argv is world-readable through `ps`. So neither flag appears here and the
 * password goes in on stdin. This is what makes the dry-run safe to print
 * verbatim and safe for CI to run.
 */
export function buildKeytoolArgs({
  keystorePath,
  alias = DEFAULT_ALIAS,
  validityDays = DEFAULT_VALIDITY_DAYS,
  dname = DEFAULT_DNAME,
  keyAlgorithm = DEFAULT_KEY_ALGORITHM,
  keySize = DEFAULT_KEY_SIZE,
} = {}) {
  if (typeof keystorePath !== "string" || keystorePath.trim() === "") {
    throw new Error("keystorePath is required");
  }
  if (!Number.isInteger(validityDays) || validityDays <= 0) {
    throw new Error("validityDays must be a positive integer");
  }
  return [
    "-genkeypair",
    "-keystore",
    keystorePath,
    "-storetype",
    "PKCS12",
    "-alias",
    alias,
    "-keyalg",
    keyAlgorithm,
    "-keysize",
    String(keySize),
    "-validity",
    String(validityDays),
    "-dname",
    dname,
  ];
}

/**
 * What to print when keytool cannot be invoked at all.
 *
 * This check runs BEFORE anything is moved or deleted, which is the whole
 * point: `--force` removes the originals so that keytool creates a new store
 * rather than adding an alias to the old one, and a keytool that was never
 * going to run would otherwise turn "no JDK on PATH" into "your keystore is
 * gone and the only copy is in a file the error never mentioned".
 */
export function formatKeytoolUnavailable(detail) {
  return [
    `${PROGRAM}: keytool cannot be run (${detail}), so NOTHING was written, moved or removed.`,
    "",
    "  keytool ships with the JDK. Install a JDK (17 or newer is what this",
    "  project builds with) and make sure `keytool` is on PATH, then re-run.",
    "",
    "  This was checked before any existing keystore or env file was touched, so",
    "  whatever was on disk before this run is still exactly where it was.",
  ].join("\n");
}

/**
 * Where the previous bytes went, and the exact command that puts them back.
 *
 * Pure and exported because the failure it serves is the one nobody rehearses:
 * `--force` deletes the originals so keytool can create a fresh store, and if
 * keytool then fails the user is left with an error about keytool and no idea
 * that their only remaining copy is a `.backup-<timestamp>` file. Naming the
 * paths is the difference between a recoverable run and a lost signing key.
 */
export function formatBackupRestoreGuidance(backups) {
  const verified = (backups ?? []).filter((entry) => entry && entry.verified === true);
  if (verified.length === 0) return null;
  return [
    "",
    "  Your previous signing material was moved aside before this run and is intact:",
    ...verified.map((entry) => `    ${entry.backup}`),
    "",
    "  Restore it with:",
    ...verified.map(
      (entry) => `    mv ${shellSingleQuote(entry.backup)} ${shellSingleQuote(entry.source)}`,
    ),
    "",
    "  Do that before re-running, and do not delete those backups until a",
    "  keystore you can actually open is back in place.",
  ].join("\n");
}

/** The inspection command, also password-free on argv. */
export function buildKeytoolListArgs({ keystorePath, alias = DEFAULT_ALIAS } = {}) {
  if (typeof keystorePath !== "string" || keystorePath.trim() === "") {
    throw new Error("keystorePath is required");
  }
  return ["-list", "-v", "-keystore", keystorePath, "-alias", alias];
}

/**
 * Pull the certificate SHA-256 out of `keytool -list -v` output and normalize
 * it to all 64 lower-case hex digits with no separators. A fingerprint is
 * public metadata and is the one
 * signing value this script is allowed to print.
 */
export function certificateFingerprintFromKeytoolList(text) {
  const match = /SHA-?256:\s*([0-9A-Fa-f:]{47,})/.exec(String(text));
  if (!match) return null;
  const normalized = match[1].replace(/:/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

/**
 * Names among the four that are already exported in this environment.
 *
 * Reported as a warning, never as values. A partially exported set makes every
 * Gradle invocation in three modules throw during configuration, and the
 * message does not say which value is missing, so this is worth naming up
 * front.
 */
export function partialSigningEnvWarning(environment) {
  const present = REQUIRED_ENV_NAMES.filter((name) => {
    const value = environment[name];
    return typeof value === "string" && value.trim() !== "";
  });
  if (present.length === 0 || present.length === REQUIRED_ENV_NAMES.length) return null;
  const missing = REQUIRED_ENV_NAMES.filter((name) => !present.includes(name));
  return [
    "warning: this shell already exports part of the signing set.",
    `  exported: ${present.join(", ")}`,
    `  missing:  ${missing.join(", ")}`,
    "  Until all four are set, every Gradle task in hook/payload, hook/loader and runtime/android",
    "  fails during configuration (runtime/android/build.gradle.kts:29-34). Sourcing the",
    "  generated env file resolves it.",
  ].join("\n");
}

/** The dry-run plan, and the same text the real run echoes before acting. */
export function formatPlan(plan) {
  const displayPath = (path) =>
    isInsideDirectory(path, plan.repositoryRoot ?? REPOSITORY_ROOT)
      ? `${path} (in-worktree; ${relative(plan.repositoryRoot ?? REPOSITORY_ROOT, path)})`
      : path;
  return [
    `${PROGRAM}: plan`,
    "",
    "  keystore      " + displayPath(plan.keystorePath),
    "  env file      " + displayPath(plan.envFilePath),
    "  alias         " + plan.alias,
    "  validity      " + `${plan.validityDays} days`,
    "  key           " + `${plan.keyAlgorithm} ${plan.keySize}, PKCS12 store`,
    "  subject       " + plan.dname,
    "  password      " + `${plan.passwordSource} (never printed, never on argv)`,
    "  modes         " +
      `keystore ${KEYSTORE_MODE.toString(8).padStart(4, "0")}, ` +
      `env file ${ENV_FILE_MODE.toString(8).padStart(4, "0")}, ` +
      `parent dirs ${SECRET_DIRECTORY_MODE.toString(8).padStart(4, "0")}`,
    "",
    "  keystore path check   " + plan.keystoreVerdict.reason,
    "  env file path check   " + plan.envFileVerdict.reason,
    "",
    "  command (argv carries no password; both prompts are fed on stdin):",
    `    keytool ${plan.keytoolArgs.map((argument) => (/[\s]/.test(argument) ? shellSingleQuote(argument) : argument)).join(" ")}`,
    "",
    "  env file contents:",
    ...plan.envFilePreview.split("\n").map((line) => `    ${line}`),
  ].join("\n");
}

/** Next steps. Printed only after real artifacts exist. */
export function formatNextSteps({ envFilePath, fingerprint, alias, keystorePath }) {
  const sourcePath = isInsideDirectory(envFilePath, REPOSITORY_ROOT)
    ? relative(REPOSITORY_ROOT, envFilePath)
    : envFilePath;
  return [
    "",
    "Certificate SHA-256 (public metadata; safe to record):",
    `  ${fingerprint ?? "unavailable — run the inspection command below"}`,
    "",
    "This is a NEW package identity. Observed frozen release signer SHA-256:",
    "d8a64e1c3a1afdc340c4b86feaacb88e2d81d66972afbd58e743b7c5b8d1cbdb",
    "This generated signer cannot match it. Builds signed with this key are",
    "valid, but they are not in-place upgrades for anything already",
    "installed from the frozen signer — that is an uninstall/reinstall migration,",
    "not an update. Do not present this key as compatible.",
    "",
    "Next command:",
    `  source ${sourcePath}`,
    "",
    "Then a signed release build (versionCode must be > 1 and versionName must not",
    'be "1.0"; both are enforced at runtime/android/build.gradle.kts:265-269):',
    "  ./gradlew :runtime:android:assembleRelease -PversionCode=<CODE> -PversionName=<NAME>",
    "",
    "Inspect the key later without putting a password on a command line:",
    `  keytool ${buildKeytoolListArgs({ keystorePath, alias }).join(" ")}`,
    "",
    "Back this keystore up somewhere private and offline before you rely on it.",
    "It is gitignored on purpose; nothing in this repository can restore it.",
  ].join("\n");
}

function usage() {
  return [
    "Usage:",
    `  node platform/containers/pin-builder/${PROGRAM}.mjs [--dry-run] [--force] [options]`,
    "",
    "Generates a fork-owned PKCS12 release keystore and the gitignored env file",
    `that hook/payload, hook/loader and runtime/android read, so ./gradlew :runtime:android:assembleRelease`,
    "can sign. It does not build, install, commit, or touch a device.",
    "",
    "Options:",
    `  --dry-run           Print the exact plan and write nothing. Safe for CI.`,
    `  --force             Only with an existing target: back it up (verified by`,
    `                      digest) before replacing it. Never a silent overwrite.`,
    `  --keystore PATH     Default ${DEFAULT_KEYSTORE_PATH}`,
    `  --env-out PATH      Default ${DEFAULT_ENV_FILE_PATH}`,
    "                      (named --env-out, not --env-file: node consumes",
    "                      --env-file itself before the script ever sees it)",
    `  --alias NAME        Default ${DEFAULT_ALIAS}`,
    `  --validity DAYS     Default ${DEFAULT_VALIDITY_DAYS}`,
    "  --dname VALUE       Certificate subject. Default is a generic placeholder.",
    "  --help              This text.",
    "",
    "Password:",
    `  Generated with node:crypto by default. Set ${PASSWORD_ENV_NAME} to supply`,
    "  your own. It is never printed, never written to argv, and never logged —",
    "  all output is redacted, including --dry-run.",
    `  Do not use one of the four ${REQUIRED_ENV_NAMES[0].slice(0, 11)}* names for it:`,
    "  exporting part of the set makes every Gradle task fail during configuration.",
    "",
    "Writes exactly two files:",
    `  - the keystore (mode ${KEYSTORE_MODE.toString(8)}), PKCS12, one alias`,
    `  - the env file (mode ${ENV_FILE_MODE.toString(8)}) with all four exports:`,
    ...REQUIRED_ENV_NAMES.map((name) => `      ${name}`),
    "",
    "Both targets must be outside the worktree or provably gitignored, or this",
    "refuses. A committed keystore is a security incident, not a mistake.",
    "",
  ].join("\n");
}

export function parseCliArgs(argv) {
  const options = {
    dryRun: false,
    force: false,
    help: false,
    keystorePath: DEFAULT_KEYSTORE_PATH,
    envFilePath: DEFAULT_ENV_FILE_PATH,
    alias: DEFAULT_ALIAS,
    validityDays: DEFAULT_VALIDITY_DAYS,
    dname: DEFAULT_DNAME,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (argument) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--keystore":
        options.keystorePath = resolve(takeValue());
        break;
      // NOT `--env-file`. Node itself consumes that flag even when it appears
      // after the script path (measured on node v22.22.3: `node script.mjs
      // --env-file X` exits 9 with "X: not found" before the script runs), and
      // the shebang form hits the same thing. A flag the runtime steals is not
      // a flag.
      case "--env-out":
        options.envFilePath = resolve(takeValue());
        break;
      case "--alias":
        options.alias = takeValue();
        break;
      case "--dname":
        options.dname = takeValue();
        break;
      case "--validity": {
        const raw = takeValue();
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`--validity must be a positive integer, got: ${raw}`);
        }
        options.validityDays = parsed;
        break;
      }
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.alias.trim() === "") throw new Error("--alias must not be blank");
  if (options.dname.trim() === "") throw new Error("--dname must not be blank");
  return options;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * Run a command, feeding `input` on stdin and capturing bounded output.
 *
 * Deliberately not `execFile`: `execFile` has no `input` option (only the
 * *Sync* variants do), so passing one silently feeds keytool nothing and it
 * hangs on its first prompt. stdin is the only password channel available —
 * keytool has no `-storepass:env`/`-storepass:file` form — so this has to be a
 * real spawn.
 */
async function runWithStdin(command, args, input, { maxOutputBytes = 1024 * 1024 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const capture = (stream, append) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const current = append(chunk);
        if (current.length > maxOutputBytes) child.kill("SIGKILL");
      });
    };
    capture(child.stdout, (chunk) => (stdout += chunk));
    capture(child.stderr, (chunk) => (stderr += chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        const error = new Error(`${command} exited with code ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        rejectPromise(error);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * Can keytool be started? Returns null when it can, or a short reason when it
 * cannot.
 *
 * A NON-ZERO exit still proves the binary exists and runs, which is all this
 * needs to establish — `keytool -help` exits 0 on this host but 1 on some JDKs,
 * and treating that as "missing" would refuse a perfectly good toolchain. Only
 * a spawn failure (ENOENT, EACCES) means there is nothing to invoke later.
 */
async function keytoolUnavailableReason() {
  try {
    await runCommand("keytool", ["-help"], { timeout: 60_000 });
    return null;
  } catch (error) {
    if (typeof error?.code === "number") return null;
    return String(error?.code ?? error?.message ?? "could not be started");
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256OfFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Is `path` ignored by Git? `null` when the answer cannot be established.
 *
 * `git check-ignore` exits 0 for ignored, 1 for not ignored, and 128 for an
 * unresolvable path (measured: a path under a non-existent directory outside
 * the repository returns 128, not 1). Only a clean 0 counts as proof.
 */
async function gitReportsIgnored(path) {
  try {
    await runCommand("git", ["check-ignore", "-q", "--", path], { cwd: REPOSITORY_ROOT });
    return true;
  } catch (error) {
    if (error && error.code === 1) return false;
    return null;
  }
}

/** Write a secret file that is owner-only from the moment it exists. */
export async function writeSecretFile(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: SECRET_DIRECTORY_MODE });
  // `wx` fails rather than truncating: by the time we get here the caller has
  // already refused or backed up, so an existing file means something appeared
  // underneath us, and losing loudly beats overwriting a secret.
  await writeFile(path, contents, { mode: ENV_FILE_MODE, flag: "wx" });
  // The mode argument is masked by umask on some platforms, so set it again.
  await chmod(path, ENV_FILE_MODE);
}

async function backupExisting(path, timestamp) {
  const destination = backupPathFor(path, timestamp);
  if (await pathExists(destination)) {
    throw new Error(`backup target already exists, refusing to overwrite it: ${destination}`);
  }
  const verdict = backupTargetVerdict(path, timestamp, {
    isIgnored: await gitReportsIgnored(destination),
  });
  if (!verdict.allowed) {
    throw new Error(
      `refusing to back up ${path} — the backup path is ${verdict.reason}:\n  ${destination}\n` +
        "  A backup carries the same private key as the original. Move the original\n" +
        "  outside the worktree (or widen .gitignore to cover the backup suffix) and\n" +
        "  re-run; this script will not write key material somewhere Git can stage it.",
    );
  }
  await copyFile(path, destination);
  await chmod(destination, KEYSTORE_MODE);
  const verified = backupIsVerified(await sha256OfFile(path), await sha256OfFile(destination));
  return { source: path, backup: destination, verified };
}

async function main() {
  const secrets = ACTIVE_SECRETS;
  const emit = (stream, text) => {
    stream.write(`${assertRedacted(redact(text, secrets), secrets)}\n`);
  };

  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${PROGRAM}: ${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const supplied = process.env[PASSWORD_ENV_NAME];
  const password =
    typeof supplied === "string" && supplied.trim() !== "" ? supplied : generatePassword();
  secrets.push(...secretVariants(password));
  const passwordSource =
    supplied && supplied.trim() !== ""
      ? `supplied through ${PASSWORD_ENV_NAME}`
      : "generated with node:crypto (32 random bytes)";

  const keystoreVerdict = writeTargetVerdict(options.keystorePath, {
    isIgnored: await gitReportsIgnored(options.keystorePath),
  });
  const envFileVerdict = writeTargetVerdict(options.envFilePath, {
    isIgnored: await gitReportsIgnored(options.envFilePath),
  });
  for (const [label, verdict] of [
    ["keystore", keystoreVerdict],
    ["env file", envFileVerdict],
  ]) {
    if (!verdict.allowed) {
      emit(
        process.stderr,
        `${PROGRAM}: refusing to write the ${label} — ${verdict.reason}\n${verdict.detail ?? ""}`,
      );
      process.exitCode = 2;
      return;
    }
  }

  const envValues = {
    PIN_SIGNING_STORE_FILE: options.keystorePath,
    PIN_SIGNING_STORE_PASSWORD: password,
    PIN_SIGNING_KEY_ALIAS: options.alias,
    PIN_SIGNING_KEY_PASSWORD: password,
  };
  const envFileContents = renderEnvFile(envValues);
  const keytoolArgs = buildKeytoolArgs({
    keystorePath: options.keystorePath,
    alias: options.alias,
    validityDays: options.validityDays,
    dname: options.dname,
  });

  const plan = {
    repositoryRoot: REPOSITORY_ROOT,
    keystorePath: options.keystorePath,
    envFilePath: options.envFilePath,
    alias: options.alias,
    validityDays: options.validityDays,
    dname: options.dname,
    keyAlgorithm: DEFAULT_KEY_ALGORITHM,
    keySize: DEFAULT_KEY_SIZE,
    passwordSource,
    keystoreVerdict,
    envFileVerdict,
    keytoolArgs,
    // Rendered from placeholders rather than filtered afterwards: the real
    // password is never placed into this string at all, so no redaction bug
    // can expose it. `emit` still redacts everything as a second line of
    // defence.
    envFilePreview: renderEnvFile({
      ...envValues,
      PIN_SIGNING_STORE_PASSWORD: REDACTION,
      PIN_SIGNING_KEY_PASSWORD: REDACTION,
    }),
  };

  const existing = [];
  if (await pathExists(options.keystorePath)) existing.push(options.keystorePath);
  if (await pathExists(options.envFilePath)) existing.push(options.envFilePath);

  if (options.dryRun) {
    emit(process.stdout, formatPlan(plan));
    emit(process.stdout, "");
    if (existing.length > 0) {
      const reason = refusalReason(existing, options.force);
      emit(
        process.stdout,
        reason === null
          ? `  --force is set, so a real run would back up and replace:\n${existing.map((path) => `    ${path}`).join("\n")}`
          : `  a real run would REFUSE:\n${reason}`,
      );
    }
    const warning = partialSigningEnvWarning(process.env);
    if (warning) emit(process.stdout, `\n${warning}`);
    emit(process.stdout, "\n--dry-run: nothing was written.");
    return;
  }

  const reason = refusalReason(existing, options.force);
  if (reason !== null) {
    emit(process.stderr, `${PROGRAM}: ${reason}`);
    process.exitCode = 2;
    return;
  }

  // Before anything is moved or removed. keytool is the one dependency this
  // script cannot supply, and the destructive step below is only justified by
  // the generation step that follows it.
  const keytoolProblem = await keytoolUnavailableReason();
  if (keytoolProblem !== null) {
    emit(process.stderr, formatKeytoolUnavailable(keytoolProblem));
    process.exitCode = 2;
    return;
  }

  let backups = [];
  if (existing.length > 0) {
    const timestamp = new Date().toISOString();
    backups = [];
    for (const path of existing) backups.push(await backupExisting(path, timestamp));
    const unprotected = missingBackups(existing, backups);
    if (unprotected.length > 0) {
      emit(
        process.stderr,
        `${PROGRAM}: refusing to continue — backup did not verify for:\n${unprotected.map((path) => `  ${path}`).join("\n")}`,
      );
      process.exitCode = 2;
      return;
    }
    for (const entry of backups) emit(process.stdout, `backed up ${entry.source}\n  -> ${entry.backup}`);
    // Removed only after every backup verified by digest. keytool would
    // otherwise add an alias to the existing store instead of creating a new
    // one, and `wx` would refuse the env file.
    for (const path of existing) await rm(path);
  }

  await mkdir(dirname(options.keystorePath), { recursive: true, mode: SECRET_DIRECTORY_MODE });

  try {
    // Two prompts, measured on this host: "Enter keystore password:" then
    // "Re-enter new password:". PKCS12 asks for no separate key password,
    // which is why one value satisfies both PIN_SIGNING_*_PASSWORD names.
    const generation = await runWithStdin("keytool", keytoolArgs, `${password}\n${password}\n`);
    // keytool echoes its prompts even when stdin is a pipe, so this block reads
    // like the tool is waiting for input when it is already done. Label it so
    // nobody sits there typing.
    const noise = `${generation.stdout ?? ""}${generation.stderr ?? ""}`.trim();
    if (noise) emit(process.stdout, `keytool: ${noise.replace(/\n/g, "\nkeytool: ")}`);
  } catch (error) {
    // The originals are already gone at this point (they had to be, or keytool
    // would have added an alias to the old store instead of creating a new
    // one). An error that only says "keytool failed" leaves the user unaware
    // that their only remaining copy is a `.backup-<timestamp>` file, so the
    // paths and the restore command are part of the message, not a footnote.
    const guidance = formatBackupRestoreGuidance(backups);
    emit(
      process.stderr,
      `${PROGRAM}: keytool failed\n${`${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message}` +
        (guidance === null ? "" : `\n${guidance}`),
    );
    process.exitCode = 2;
    return;
  }

  // keytool leaves the store at 0644 (measured on this host). Fix it before
  // anything else can read it.
  await chmod(options.keystorePath, KEYSTORE_MODE);
  emit(process.stdout, `wrote ${options.keystorePath} (mode ${KEYSTORE_MODE.toString(8)})`);

  await writeSecretFile(options.envFilePath, envFileContents);
  emit(
    process.stdout,
    `wrote ${options.envFilePath} (mode ${ENV_FILE_MODE.toString(8)}) with ${REQUIRED_ENV_NAMES.join(", ")}`,
  );

  let fingerprint = null;
  try {
    const listing = await runWithStdin(
      "keytool",
      buildKeytoolListArgs({ keystorePath: options.keystorePath, alias: options.alias }),
      `${password}\n`,
    );
    fingerprint = certificateFingerprintFromKeytoolList(`${listing.stdout ?? ""}${listing.stderr ?? ""}`);
  } catch {
    fingerprint = null;
  }

  const warning = partialSigningEnvWarning(process.env);
  if (warning) emit(process.stdout, `\n${warning}`);
  emit(
    process.stdout,
    formatNextSteps({
      envFilePath: options.envFilePath,
      fingerprint,
      alias: options.alias,
      keystorePath: options.keystorePath,
    }),
  );
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    // Redacted through the same registry `main` uses. An unexpected throw is
    // the one path nobody rehearses, so it must not be the one that prints a
    // password.
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`${PROGRAM}: ${redact(message, ACTIVE_SECRETS)}\n`);
    process.exitCode = 2;
  }
}
