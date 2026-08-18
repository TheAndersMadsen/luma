#!/usr/bin/env node
// Ai Pin builder host preflight. Answers one question for a newcomer:
// "what is missing or misconfigured on THIS machine, and what exactly do I type
// to fix it?"
//
// Deliberate boundaries, all of them load-bearing:
//   * No device. The only ADB call is the read-only `adb devices`, and a missing
//     Pin is never a failure — every prerequisite below is host-side.
//   * No network. Nothing is fetched, resolved, or downloaded.
//   * No secrets. The signing env file is inspected for KEY NAMES only; no value
//     is ever read into a reported string, and the renderer prints names drawn
//     from a fixed constant, never from file content. The same holds for the
//     signing ENVIRONMENT: names are tested for presence, values are not read.
//   * No host identity. Both renderers abbreviate the home directory to `~`.
//     This report is meant to be pasteable into an issue, and an absolute
//     `/Users/<name>/…` path leaks the OS username as surely as a serial does.
//     Probes and the `evaluate` result keep full paths; only rendering rewrites.
//   * No builds. Version probes only (`--version` style), each bounded and
//     timed out. Nothing here compiles anything. The one bulk read is the
//     SHA-256 of the two pinned native build inputs (~220 MB when present).
//
// Expected versions are PARSED from README.md's prerequisite line rather than
// restated here so this preflight remains aligned with the canonical toolchain.
// If that line ever moves or changes, this tool reports what the doc actually
// says today, and cites the line it read.
// The pinned-asset paths and digests are parsed from `runtime/android/build.gradle.kts`
// for exactly the same reason — that file is what enforces the gate.
//
// Run: node platform/containers/pin-builder/doctor.mjs [--json] [--verbose]
// Exit: 0 all required checks pass · 1 a required check failed · 2 bad usage.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CHECK_STATUS = Object.freeze({
  PASS: "pass",
  WARN: "warn",
  FAIL: "fail",
});

// The Rust target every Pin artifact is cross-compiled to. Implemented by
// runtime/android/build.gradle.kts and installed by platform/containers/pin-builder/Dockerfile.
export const ANDROID_RUST_TARGET = "aarch64-linux-android";

// The four external signing inputs. Names only — no value has an in-repository
// default and none is ever read by this tool.
// Source: runtime/android/build.gradle.kts:16-19 (secretProperty pairs).
export const REQUIRED_SIGNING_KEYS = Object.freeze([
  "PIN_SIGNING_STORE_FILE",
  "PIN_SIGNING_STORE_PASSWORD",
  "PIN_SIGNING_KEY_ALIAS",
  "PIN_SIGNING_KEY_PASSWORD",
]);

// Canonical external operator path shared with root `./revival` and
// platform/containers/pin-builder/setup-signing-key.mjs. It is display-only;
// collectProbes resolves XDG/REVIVAL overrides without looking in source.
export const SIGNING_ENV_RELATIVE_PATH = "~/.config/ai-pin-revival/secrets/pin/signing.env";
// Optional external test-only evidence; deliberately absent from canonical
// source and never required for an ordinary Doctor run.
export const STOCK_EVIDENCE_RELATIVE_PATH = "decompile-workspace/decompiled";

// The one prerequisite no script in this repository can satisfy for you. The
// Server build digest-gates two large native inputs that are deliberately
// absent from canonical source and that nothing here is authorized to
// download. runtime/android/build.gradle.kts:70-103 enforces the external-only
// boundary. Absent,
// they surface as a `tflitec` build-script panic mid-`cargo`, or as a terse
// Gradle `check` failure deep inside `:runtime:android:stageRustServerJniLibs` — twenty
// minutes into a build, with no hint that the cause is a missing file.
//
// The PATH and DIGEST of each are parsed from runtime/android/build.gradle.kts (below),
// never restated here: that file is what enforces the gate. These entries contain
// only what the build file cannot state — what the artifact is, and what this
// repository does or does not document about obtaining it.
export const GATED_BUILD_ASSETS = Object.freeze([
  Object.freeze({
    id: "gated_asset_codex_app_server",
    title: "Pinned Codex app-server binary",
    fallbackPath: "~/.config/ai-pin-revival/pin-assets/codex-0.144.3/codex-app-server-aarch64-unknown-linux-musl",
    externalPolicyRef: "runtime/android/build.gradle.kts:70-110",
    observedBytes: 217_128_768,
    observedBytesRef: "observed: operator-held Codex 0.144.3 artifact",
    buildFailure:
      "`:runtime:android:stageRustServerJniLibs` fails its `check(codexAppServerBinary.isFile)` " +
      "(runtime/android/build.gradle.kts:194-213)",
    // Unknown: canonical source provides no authorized acquisition path.
    provenance:
      "Canonical source provides no authorized download for this artifact, and no script here can fetch it. " +
      "The product tree does not invent a download path for material it is not authorized to redistribute. " +
      "Implemented: Gradle pins the Codex app-server 0.144.3 path and SHA-256 " +
      "(runtime/android/build.gradle.kts:105-110). Put an authorized byte-identical copy in the external " +
      "private-assets directory, or point the build at one you already hold with " +
      "`REVIVAL_CODEX_APP_SERVER_BINARY=<path>` or `-PcodexAppServerBinary=<path>` " +
      "(runtime/android/build.gradle.kts:82-110) — the digest gate applies either way.",
  }),
  Object.freeze({
    id: "gated_asset_tflite_runtime",
    title: "Pinned compatible TFLite runtime",
    fallbackPath: "~/.config/ai-pin-revival/pin-assets/tflite-2.11.0/libtensorflowlite_jni.so",
    externalPolicyRef: "runtime/android/build.gradle.kts:70-119",
    observedBytes: 3_668_888,
    observedBytesRef: "observed: operator-held compatible TFLite artifact",
    buildFailure:
      "the Rust cross-build panics inside the `tflitec` build script, which copies the path handed to it " +
      "as TFLITEC_PREBUILT_PATH_AARCH64_LINUX_ANDROID (runtime/android/build.gradle.kts:145-149) — a cargo " +
      "build-script panic, before Gradle's digest check at runtime/android/build.gradle.kts:214-230",
    provenance:
      "Supply a legally authorized, ABI-compatible TFLite runtime through the external private-assets " +
      "directory, `REVIVAL_TFLITE_RUNTIME_BINARY=<path>`, or `-PtfliteRuntimeBinary=<path>`. The project " +
      "does not distribute or prescribe extraction of a vendor binary. Any independently built replacement " +
      "must be reviewed and re-pinned deliberately before packaging.",
  }),
]);

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LISTED_ITEMS = 8;

// ---------------------------------------------------------------------------
// Pure parsers. Every one takes text and returns data; none touches the world.
// ---------------------------------------------------------------------------

/**
 * Read the documented host requirements out of README.md's single prerequisite
 * sentence. Returns null when that sentence cannot be found, which downgrades
 * the version comparisons to warnings rather than inventing a number.
 */
export function parseRequirementsFromReadme(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const lines = text.split("\n");
  const index = lines.findIndex(
    (line) =>
      line.includes("JDK") &&
      line.includes("NDK") &&
      line.includes("Node"),
  );
  if (index === -1) return null;

  const line = lines[index];
  const jdk = /\bJDK\s+(\d+)\b/.exec(line);
  const sdk = /\bAndroid SDK\s+(\d+)\b/.exec(line);
  // The prerequisite line is prose that gets restyled: the NDK may be written
  // "Android NDK r28c" or just "NDK r28c", and the Node floor with ASCII ">="
  // or a Unicode "≥" (U+2265). Accept every spelling the document has shipped so
  // a cosmetic edit does not silently disable all version validation. This only
  // ever widens what parses; a line with no version still returns null below.
  const ndk = /\b(?:Android )?NDK\s+(r(\d+)[a-z]?)\b/.exec(line);
  const node = /\bNode\s*(?:>=|≥)\s*(\d+(?:\.\d+){0,2})\b/.exec(line);
  if (!jdk || !ndk || !node) return null;

  return Object.freeze({
    jdkMajor: Number(jdk[1]),
    androidSdkApi: sdk ? Number(sdk[1]) : null,
    ndkLabel: ndk[1],
    ndkMajor: Number(ndk[2]),
    nodeMinimum: node[1],
    sourceRef: `README.md:${index + 1}`,
  });
}

/**
 * Extract variable NAMES from an env file. Values are never captured: the regex
 * stops at `=`, and nothing to the right of it is retained or returned.
 */
export function parseEnvKeyNames(text) {
  if (typeof text !== "string") return [];
  const names = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) continue;
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * Read the pinned path and SHA-256 of the two gated native inputs out of
 * `runtime/android/build.gradle.kts`. Returns a map keyed by the ids in
 * `GATED_BUILD_ASSETS`; any field the file does not state comes back null,
 * which downgrades the corresponding check to "present but unverified" rather
 * than asserting a digest this tool made up.
 */
export function parseGatedAssetPins(text) {
  const empty = Object.freeze({});
  if (typeof text !== "string" || text.length === 0) return empty;

  const at = (index) => `runtime/android/build.gradle.kts:${text.slice(0, index).split("\n").length}`;
  const capture = (pattern) => {
    const match = pattern.exec(text);
    return match ? { value: match[1], ref: at(match.index) } : null;
  };

  // Native inputs default outside the source tree. The doctor uses its fixed
  // external display paths unless a future build contract exposes a literal.
  const codexPath = null;
  const codexDigest = capture(/val\s+codexAppServerSha256\s*=\s*"([0-9a-f]{64})"/);
  const tflitePath = null;
  const tfliteDigest = capture(/val\s+tfliteRuntimeSha256\s*=\s*"([0-9a-f]{64})"/);

  const pin = (path, digest) =>
    path === null && digest === null
      ? null
      : Object.freeze({
          path: path?.value ?? null,
          pathRef: path?.ref ?? null,
          sha256: digest?.value ?? null,
          sha256Ref: digest?.ref ?? null,
        });

  const pins = {};
  const codex = pin(codexPath, codexDigest);
  const tflite = pin(tflitePath, tfliteDigest);
  if (codex) pins.gated_asset_codex_app_server = codex;
  if (tflite) pins.gated_asset_tflite_runtime = tflite;
  return Object.freeze(pins);
}

/**
 * Rewrite an absolute home directory to `~`. Applied by BOTH renderers — the
 * JSON report is just as pasteable as the human one, so there is one rule
 * rather than two. Probe data and `evaluate` output keep full paths, so no path
 * check is affected.
 *
 * The lookahead stops `/home/ann` from mangling `/home/annex`: the match must
 * be followed by a separator or by something that is not a path character.
 */
export function abbreviateHome(text, home) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (typeof home !== "string") return text;
  const trimmed = home.replace(/[/\\]+$/, "");
  // "/" and "" would rewrite every path in the report into nonsense.
  if (trimmed.length < 2) return text;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?![^/\\\\])`, "g"), "~");
}

/** `Pkg.Revision = 26.3.11579264` out of an NDK source.properties. */
export function parseNdkRevision(text) {
  if (typeof text !== "string") return null;
  const match = /^\s*Pkg\.Revision\s*=\s*(\S+)/m.exec(text);
  return match ? match[1] : null;
}

/** `openjdk version "21.0.11" ...` (or legacy `"1.8.0_392"`) → version + major. */
export function parseJavaVersion(text) {
  if (typeof text !== "string") return null;
  const match = /version\s+"([^"]+)"/.exec(text);
  if (!match) return null;
  const version = match[1];
  const parts = version.split(/[._-]/).filter((part) => /^\d+$/.test(part));
  if (parts.length === 0) return null;
  const major = parts[0] === "1" && parts.length > 1 ? Number(parts[1]) : Number(parts[0]);
  return { version, major };
}

/** Leading numeric components only: "26.3.11579264" → [26, 3, 11579264]. */
export function versionParts(value) {
  if (typeof value !== "string") return [];
  return (value.match(/\d+/g) ?? []).map(Number);
}

/** -1 / 0 / 1 over dotted numeric versions. Missing components count as 0. */
export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * `adb devices` → counts only. Serials are deliberately NOT retained: they are
 * device identifiers and this tool's output is meant to be pasteable into an
 * issue.
 */
export function parseAdbDevices(text) {
  const counts = { ready: 0, unauthorized: 0, other: 0 };
  if (typeof text !== "string") return counts;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("List of devices")) continue;
    if (line.startsWith("*")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 2) continue;
    const state = fields[1];
    if (state === "device") counts.ready += 1;
    else if (state === "unauthorized") counts.unauthorized += 1;
    else counts.other += 1;
  }
  return counts;
}

/** `sdk.dir=/path` out of local.properties, with Windows escaping undone. */
export function parseSdkDir(text) {
  if (typeof text !== "string") return null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = /^sdk\.dir\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim().replace(/\\:/g, ":").replace(/\\\\/g, "\\");
    if (value.length > 0) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// evaluate(probes) — the whole decision layer, pure. Every check below reads
// only its argument, so a test can inject any host state without a subprocess.
// ---------------------------------------------------------------------------

function makeCheck(id, title, status, { required = false, detail = "", fix = "" } = {}) {
  return Object.freeze({ id, title, status, required, detail, fix });
}

function checkContainerBuilder(probes) {
  const builder = probes.containerBuilder ?? null;
  if (!builder?.available) {
    return makeCheck("container_builder", "Pinned container builder", CHECK_STATUS.FAIL, {
      required: true,
      detail: "Docker is unavailable or its daemon is not ready.",
      fix: "Install/start Docker, then rerun `./revival pin doctor`. The canonical Pin build does not require a host Android SDK, NDK, JDK, Rust, or protoc.",
    });
  }
  if (builder.contractFilesPresent !== true) {
    return makeCheck("container_builder", "Pinned container builder", CHECK_STATUS.FAIL, {
      required: true,
      detail: "The pinned builder Dockerfile, entrypoint, or toolchain contract is missing.",
      fix: "Restore platform/containers/pin-builder from the canonical workspace before building a Pin release.",
    });
  }
  return makeCheck("container_builder", "Pinned container builder", CHECK_STATUS.PASS, {
    required: true,
    detail: `ready${builder.version ? ` (Docker ${builder.version})` : ""}; JDK 17, Android SDK/NDK, Rust, cargo-ndk, and protoc are supplied inside the pinned linux/amd64 image.`,
  });
}

function list(values) {
  const items = Array.isArray(values) ? values : [];
  const shown = items.slice(0, MAX_LISTED_ITEMS);
  const suffix = items.length > shown.length ? `, +${items.length - shown.length} more` : "";
  return shown.join(", ") + suffix;
}

function checkNode(probes) {
  const requirements = probes.requirements ?? null;
  const version = probes.node?.version ?? null;
  const minimum = requirements?.nodeMinimum ?? null;
  const ref = requirements?.sourceRef ?? "README.md";

  if (!version) {
    return makeCheck("node", "Node.js", CHECK_STATUS.FAIL, {
      required: true,
      detail: "No Node.js version reported.",
      fix: "Install Node.js (the release tools are native ES modules and use Node's built-in test runner).",
    });
  }
  if (!minimum) {
    return makeCheck("node", "Node.js", CHECK_STATUS.WARN, {
      detail: `Found v${version}; could not read the minimum from README.md.`,
      fix: "Restore the prerequisite line in README.md so the required Node version has one source of truth.",
    });
  }
  if (compareVersions(version, minimum) < 0) {
    return makeCheck("node", "Node.js", CHECK_STATUS.FAIL, {
      required: true,
      detail: `Found v${version}; ${ref} requires >= ${minimum}.`,
      fix: `Install Node >= ${minimum} (e.g. \`nvm install 22 && nvm use 22\`), then re-run this doctor. Source: ${ref}.`,
    });
  }
  return makeCheck("node", "Node.js", CHECK_STATUS.PASS, {
    required: true,
    detail: `v${version} (>= ${minimum}, ${ref}).`,
  });
}

function checkJdk(probes) {
  const requirements = probes.requirements ?? null;
  const java = probes.java ?? null;
  const expected = requirements?.jdkMajor ?? null;
  const ref = requirements?.sourceRef ?? "README.md";
  const installHint =
    "Install a JDK and put `java` on PATH (Adoptium Temurin; on macOS `brew install --cask temurin@17`).";

  if (!java?.present) {
    return makeCheck("jdk", "JDK", CHECK_STATUS.FAIL, {
      required: true,
      detail: "`java` not found on PATH. Gradle cannot run.",
      fix: expected
        ? `${installHint} ${ref} specifies JDK ${expected}.`
        : installHint,
    });
  }
  if (!java.version) {
    return makeCheck("jdk", "JDK", CHECK_STATUS.WARN, {
      detail: "`java` ran but its version could not be parsed.",
      fix: "Check `java -version` by hand; an unparseable banner usually means a wrapper script is shadowing the JDK.",
    });
  }
  if (expected !== null && java.major !== expected) {
    return makeCheck("jdk", "JDK", CHECK_STATUS.WARN, {
      detail: `Found JDK ${java.version}; ${ref} specifies JDK ${expected}.`,
      fix:
        `Nothing in the build pins a Java toolchain (no \`jvmToolchain\`/\`java { toolchain }\` in any build.gradle.kts), ` +
        `so JDK ${java.major} will be used as-is. The canonical builder pins JDK ${expected} ` +
        `(platform/containers/pin-builder/Dockerfile:6). Install JDK ${expected} if you hit a Gradle/AGP incompatibility.`,
    });
  }
  return makeCheck("jdk", "JDK", CHECK_STATUS.PASS, {
    required: true,
    detail: expected === null
      ? `JDK ${java.version}.`
      : `JDK ${java.version} (matches ${ref}).`,
  });
}

function checkAndroidSdk(probes) {
  const sdk = probes.androidSdk ?? null;
  const requirements = probes.requirements ?? null;
  const api = requirements?.androidSdkApi ?? null;
  const ref = requirements?.sourceRef ?? "README.md";

  if (!sdk?.path) {
    return makeCheck("android_sdk", "Android SDK", CHECK_STATUS.FAIL, {
      required: true,
      detail: "No SDK location found: no `sdk.dir` in local.properties and no ANDROID_HOME/ANDROID_SDK_ROOT.",
      fix:
        "Create `local.properties` at the repo root with one line, `sdk.dir=/absolute/path/to/Android/sdk`, " +
        "or export ANDROID_SDK_ROOT. The canonical container sets both SDK variables " +
        "(platform/containers/pin-builder/Dockerfile:26-29).",
    });
  }
  if (!sdk.exists) {
    return makeCheck("android_sdk", "Android SDK", CHECK_STATUS.FAIL, {
      required: true,
      detail: `Configured SDK path does not exist: ${sdk.path} (from ${sdk.source}).`,
      fix: `Point ${sdk.source} at a real Android SDK directory, or install the SDK via Android Studio.`,
    });
  }

  const missing = [];
  if (api !== null && !(sdk.platforms ?? []).includes(`android-${api}`)) {
    missing.push(`platforms;android-${api}`);
  }
  if ((sdk.buildTools ?? []).length === 0) {
    missing.push("build-tools");
  }
  if (missing.length > 0) {
    return makeCheck("android_sdk", "Android SDK", CHECK_STATUS.WARN, {
      detail:
        `SDK at ${sdk.path} (from ${sdk.source}); missing ${list(missing)}. ` +
        `Platforms present: ${list(sdk.platforms) || "none"}. Build-tools present: ${list(sdk.buildTools) || "none"}.`,
      fix:
        `Install with \`sdkmanager ${missing.map((item) => `"${item}${item === "build-tools" ? ";35.0.0" : ""}"`).join(" ")}\`. ` +
        `${ref} requires Android SDK ${api ?? "34"}; Build Tools 35.0.0 or newer are needed for the ` +
        "`zipalign -P 16` release verification; the canonical builder pins Build Tools 35.0.0 " +
        "(platform/containers/pin-builder/Dockerfile:16).",
    });
  }
  return makeCheck("android_sdk", "Android SDK", CHECK_STATUS.PASS, {
    required: true,
    detail:
      `${sdk.path} (from ${sdk.source}); platforms: ${list(sdk.platforms) || "none"}; ` +
      `build-tools: ${list(sdk.buildTools) || "none"}.`,
  });
}

function checkPlatformTools(probes) {
  const adb = probes.adb ?? null;
  if (!adb?.present) {
    return makeCheck("android_platform_tools", "Android platform-tools (adb)", CHECK_STATUS.FAIL, {
      required: true,
      detail: "`adb` not found in the SDK's platform-tools directory or on PATH.",
      fix:
        'Install with `sdkmanager "platform-tools"`, then add it to PATH: ' +
        '`export PATH="$ANDROID_SDK_ROOT/platform-tools:$PATH"`.',
    });
  }
  return makeCheck("android_platform_tools", "Android platform-tools (adb)", CHECK_STATUS.PASS, {
    required: true,
    detail: `${adb.path}${adb.version ? ` (${adb.version})` : ""}.`,
  });
}

function checkNdk(probes) {
  const ndk = probes.ndk ?? null;
  const requirements = probes.requirements ?? null;
  const documentedLabel = requirements?.ndkLabel ?? null;
  const documentedMajor = requirements?.ndkMajor ?? null;
  const ref = requirements?.sourceRef ?? "README.md";

  if (!ndk?.path) {
    return makeCheck("android_ndk", "Android NDK", CHECK_STATUS.FAIL, {
      required: true,
      detail:
        "No NDK found: ANDROID_NDK_ROOT/ANDROID_NDK_HOME/NDK_HOME are unset and the SDK has no `ndk/` entry.",
      fix:
        "Install an NDK through Android Studio's SDK Manager, or list the available packages with " +
        "`sdkmanager --list | grep ndk` and install one. " +
        (documentedLabel ? `${ref} documents NDK ${documentedLabel}. ` : "") +
        "The Server's Rust cross-build (`cargo ndk` at runtime/android/build.gradle.kts:71-77) cannot run without it.",
    });
  }

  const found = ndk.revision ?? "unknown revision";
  const foundMajor = ndk.revision ? versionParts(ndk.revision)[0] ?? null : null;
  const where = `${ndk.path} (from ${ndk.source})`;
  const alsoInstalled =
    (ndk.candidates ?? []).length > 1 ? ` Other NDKs present: ${list(ndk.candidates)}.` : "";

  if (documentedMajor === null || foundMajor === null) {
    return makeCheck("android_ndk", "Android NDK", CHECK_STATUS.WARN, {
      detail: `Found NDK ${found} at ${where}; could not compare against a documented version.${alsoInstalled}`,
      fix: `Confirm the intended NDK in ${ref}; nothing in the build pins \`ndkVersion\`, so whatever is resolved here is what builds.`,
    });
  }
  if (foundMajor !== documentedMajor) {
    return makeCheck("android_ndk", "Android NDK", CHECK_STATUS.WARN, {
      detail: `Found NDK ${found} at ${where}; ${ref} documents NDK ${documentedLabel}.${alsoInstalled}`,
      fix:
        `This is a warning, not a blocker: a different NDK major has been observed to build this repo successfully, ` +
        `and no build file pins \`ndkVersion\`, so cargo-ndk uses whatever is resolved here. ` +
        `Install NDK ${documentedLabel} only if you need to match ${ref} exactly, or set ANDROID_NDK_ROOT to the ` +
        "NDK you intend to build with. The canonical builder pin is in platform/containers/pin-builder/Dockerfile:17.",
    });
  }
  return makeCheck("android_ndk", "Android NDK", CHECK_STATUS.PASS, {
    required: true,
    detail: `NDK ${found} at ${where}; matches ${ref} (${documentedLabel}).${alsoInstalled}`,
  });
}

function checkRustc(probes) {
  const rustc = probes.rustc ?? null;
  if (!rustc?.present) {
    return makeCheck("rustc", "Rust compiler", CHECK_STATUS.FAIL, {
      required: true,
      detail: "`rustc` not found on PATH.",
      fix:
        "Install the stable Rust toolchain via rustup: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`. " +
        "The repo pins no toolchain file, so `stable` is what is expected.",
    });
  }
  return makeCheck("rustc", "Rust compiler", CHECK_STATUS.PASS, {
    required: true,
    detail: rustc.version ?? "present",
  });
}

function checkCargo(probes) {
  const cargo = probes.cargo ?? null;
  if (!cargo?.present) {
    return makeCheck("cargo", "Cargo", CHECK_STATUS.FAIL, {
      required: true,
      detail: "`cargo` not found on PATH.",
      fix: "Install Rust via rustup (cargo ships with it) and ensure `~/.cargo/bin` is on PATH.",
    });
  }
  return makeCheck("cargo", "Cargo", CHECK_STATUS.PASS, {
    required: true,
    detail: cargo.version ?? "present",
  });
}

function checkRustTarget(probes) {
  const target = probes.rustTarget ?? null;
  const title = `Rust target ${ANDROID_RUST_TARGET}`;
  if (!target || target.determined !== true) {
    return makeCheck("rust_target_android", title, CHECK_STATUS.WARN, {
      detail: "Could not determine the installed Rust targets (rustup not found?).",
      fix: `Verify by hand with \`rustup target list --installed\`; add it with \`rustup target add ${ANDROID_RUST_TARGET}\` (platform/containers/pin-builder/Dockerfile:83).`,
    });
  }
  if (!target.installed) {
    return makeCheck("rust_target_android", title, CHECK_STATUS.FAIL, {
      required: true,
      detail: `The ${ANDROID_RUST_TARGET} target is not installed.`,
      fix: `Run \`rustup target add ${ANDROID_RUST_TARGET}\` (platform/containers/pin-builder/Dockerfile:83).`,
    });
  }
  return makeCheck("rust_target_android", title, CHECK_STATUS.PASS, {
    required: true,
    detail: `installed (via ${target.source ?? "rustup"}).`,
  });
}

function checkCargoNdk(probes) {
  const cargoNdk = probes.cargoNdk ?? null;
  if (!cargoNdk?.present) {
    return makeCheck("cargo_ndk", "cargo-ndk", CHECK_STATUS.FAIL, {
      required: true,
      detail: "`cargo ndk` is not installed (`error: no such command: \\`ndk\\``).",
      fix:
        "Run `cargo install cargo-ndk --locked` (canonical pin: platform/containers/pin-builder/Dockerfile:18,84). " +
        "Without it `:runtime:android:buildRustServerAndroid` fails with a terse Gradle wrapper error " +
        "(runtime/android/build.gradle.kts:71-77).",
    });
  }
  return makeCheck("cargo_ndk", "cargo-ndk", CHECK_STATUS.PASS, {
    required: true,
    detail: cargoNdk.version ?? "present",
  });
}

function checkProtoc(probes) {
  const protoc = probes.protoc ?? null;
  if (!protoc?.present) {
    return makeCheck("protoc", "protoc", CHECK_STATUS.FAIL, {
      required: true,
      detail: "`protoc` not found on PATH; `runtime/core/build.rs:83` cannot compile the gRPC contracts.",
      fix:
        "Install the protobuf compiler: macOS `brew install protobuf`, Debian/Ubuntu " +
        "`apt-get install -y protobuf-compiler` (platform/containers/pin-builder/Dockerfile:63).",
    });
  }
  return makeCheck("protoc", "protoc", CHECK_STATUS.PASS, {
    required: true,
    detail: protoc.version ?? "present",
  });
}

/**
 * The stock-evidence guards deliberately skip on a clean clone, but a complete
 * local architecture run must make that omission visible instead of looking
 * fully green. Absence is non-blocking because the evidence is gitignored and
 * is not a build input.
 */
function checkStockEvidence(probes) {
  const evidence = probes.stockEvidence ?? null;
  const path = evidence?.path ?? STOCK_EVIDENCE_RELATIVE_PATH;
  if (evidence?.exists !== true) {
    return makeCheck("stock_decompile_evidence", "Stock decompile evidence", CHECK_STATUS.WARN, {
      detail:
        `${path} is absent. Stock-name and native-action evidence checks will SKIP loudly; ` +
        "the build and all evidence-independent tests remain valid.",
      fix:
        `Restore your local, gitignored stock decompile at ${STOCK_EVIDENCE_RELATIVE_PATH}, ` +
        "then rerun `node --test platform/containers/pin-builder/tier-a-registry.test.mjs` for the evidence-bound registry check.",
    });
  }
  return makeCheck("stock_decompile_evidence", "Stock decompile evidence", CHECK_STATUS.PASS, {
    detail: `${path} is present; stock-name and native-action evidence guards can run.`,
  });
}

/**
 * Signing env file. PRESENCE and KEY NAMES only.
 *
 * Absent is a warning, not a failure: host gates and debug builds need no
 * signing identity. A PARTIAL file is a hard failure, because sourcing it makes
 * every Gradle invocation in :hook:payload:/:hook:loader:/:runtime:android: throw at configuration
 * time — not just release packaging (runtime/android/build.gradle.kts:26-34).
 */
function checkSigningEnv(probes) {
  const signing = probes.signingEnv ?? null;
  const path = signing?.path ?? SIGNING_ENV_RELATIVE_PATH;
  const title = "Pin signing env file";

  if (!signing?.exists) {
    return makeCheck("signing_env", title, CHECK_STATUS.WARN, {
      detail: `${path} not present. Host gates and debug builds do not need it.`,
      fix:
        `Only needed to assemble a signed release. Create ${path} with exactly ` +
        `these four exports and mode 600: ${REQUIRED_SIGNING_KEYS.join(", ")} ` +
        `(runtime/android/build.gradle.kts:36-59; platform/containers/pin-builder/setup-signing-key.mjs). ` +
        "Keep the keystore itself outside the worktree.",
    });
  }

  // Intersect with a fixed constant: the reported names can only ever be
  // members of REQUIRED_SIGNING_KEYS, never text taken from the file.
  const observed = Array.isArray(signing.keys) ? signing.keys : [];
  const present = REQUIRED_SIGNING_KEYS.filter((name) => observed.includes(name));
  const missing = REQUIRED_SIGNING_KEYS.filter((name) => !observed.includes(name));
  const inventory = `set: ${present.join(", ") || "none"}; unset: ${missing.join(", ") || "none"} (names only — no value is read or printed).`;

  if (present.length === 0) {
    return makeCheck("signing_env", title, CHECK_STATUS.WARN, {
      detail: `${path} exists but declares none of the four signing variables. ${inventory}`,
      fix:
        `Add all four exports (${REQUIRED_SIGNING_KEYS.join(", ")}) or delete the file. ` +
        "Canonical consumer: runtime/android/build.gradle.kts:36-59.",
    });
  }
  if (missing.length > 0) {
    return makeCheck("signing_env", title, CHECK_STATUS.FAIL, {
      required: true,
      detail: `${path} is PARTIAL. ${inventory}`,
      fix:
        "A partial set poisons every Gradle invocation in :hook:payload:/:hook:loader:/:runtime:android: at configuration time " +
        '("Pin signing is incomplete. Supply all four external pinSigning* properties or PIN_SIGNING_* ' +
        'environment variables" — runtime/android/build.gradle.kts:29-34). Blank values count as absent. ' +
        `Supply all four (${REQUIRED_SIGNING_KEYS.join(", ")}) or remove the file entirely.`,
    });
  }

  const modeNote =
    signing.mode !== null && signing.mode !== undefined && (signing.mode & 0o777) !== 0o600
      ? " File mode is not exactly 0600."
      : "";
  const status = modeNote ? CHECK_STATUS.WARN : CHECK_STATUS.PASS;
  return makeCheck("signing_env", title, status, {
    detail: `${path} declares all four signing variables. ${inventory}${modeNote}`,
    fix: modeNote
      ? `Restrict it: \`chmod 600 '${path}'\` (platform/containers/pin-builder/setup-signing-key.mjs).`
      : "",
  });
}

/**
 * Are the four signing variables actually EXPORTED in this shell?
 *
 * Distinct from the file check above, and the distinction is the whole point:
 * `secretProperty` in runtime/android/build.gradle.kts:10-19 reads a Gradle
 * property or the ENVIRONMENT. It does not read `secrets/pin-signing.env`. A
 * complete file with an empty environment is therefore not sufficient for a
 * signed Gradle release build, so it is reported as a warning with the exact
 * command that bridges them.
 *
 * A PARTIAL environment is worse than an empty one and is a hard failure: one
 * exported variable makes EVERY Gradle invocation in :hook:payload:/:hook:loader:/:runtime:android:
 * throw at configuration time (runtime/android/build.gradle.kts:29-34).
 *
 * Names only. No value is read; presence is tested and the value discarded.
 */
function checkSigningEnvironment(probes) {
  const environment = probes.signingEnvironment ?? null;
  const title = "Ambient Pin signing variables (optional)";

  if (!environment) {
    return makeCheck("signing_env_exported", title, CHECK_STATUS.WARN, {
      detail: "Environment not inspected.",
      fix: "No export is required; `./revival pin release build` loads the protected external file itself.",
    });
  }

  // Same containment as the file check: reported names can only ever be members
  // of the fixed constant, never text taken from the environment.
  const observed = Array.isArray(environment.exported) ? environment.exported : [];
  const exported = REQUIRED_SIGNING_KEYS.filter((name) => observed.includes(name));
  if (exported.length === 0) {
    return makeCheck("signing_env_exported", title, CHECK_STATUS.PASS, {
      detail: "No signing values are exported. The canonical builder reads only its protected read-only signing.env mount.",
    });
  }
  return makeCheck("signing_env_exported", title, CHECK_STATUS.WARN, {
    detail: `Recognized ambient names: ${exported.join(", ")}; values were not read or printed. The canonical builder ignores ambient signing values.`,
    fix: `Avoid accidental direct-Gradle behavior by clearing ambient names: \`unset ${exported.join(" ")}\`. Use \`./revival pin release build\` instead.`,
  });
}

/**
 * One of the two large native build inputs. Absent is a REQUIRED failure: it
 * genuinely stops `:runtime:android:assembleRelease`, and this is the prerequisite a
 * newcomer cannot fix by installing a package, so it must not be buried in the
 * warning pile in the canonical host preflight.
 */
function checkGatedAsset(probes, spec) {
  const entries = Array.isArray(probes.gatedAssets) ? probes.gatedAssets : [];
  const asset = entries.find((entry) => entry?.id === spec.id) ?? null;
  const path = asset?.path ?? spec.fallbackPath;
  const digestRef = asset?.expectedSha256Ref ?? "runtime/android/build.gradle.kts";

  if (!asset) {
    return makeCheck(spec.id, spec.title, CHECK_STATUS.WARN, {
      detail: `${path} was not inspected.`,
      fix: `Check by hand that ${path} exists; without it ${spec.buildFailure}.`,
    });
  }

  if (!asset.exists) {
    return makeCheck(spec.id, spec.title, CHECK_STATUS.FAIL, {
      required: true,
      detail:
        `${path} is ABSENT. This is expected in canonical source — the file is external ` +
        `(${spec.externalPolicyRef}) and is not a bug — but the Server cannot be built without it: ${spec.buildFailure}.`,
      fix: `Not fetchable by any script here. ${spec.provenance}`,
    });
  }

  const size = typeof asset.sizeBytes === "number" ? `${asset.sizeBytes.toLocaleString("en-US")} bytes` : "size unknown";

  if (!asset.expectedSha256) {
    return makeCheck(spec.id, spec.title, CHECK_STATUS.WARN, {
      detail: `${path} is present (${size}), but no expected digest could be read from runtime/android/build.gradle.kts.`,
      fix:
        "The pinned SHA-256 is what makes this file trustworthy; restore it in runtime/android/build.gradle.kts " +
        "so both Gradle and this doctor gate on one value. " +
        `Until then verify by hand: \`shasum -a 256 ${path}\`.`,
    });
  }

  if (asset.actualSha256 !== asset.expectedSha256) {
    return makeCheck(spec.id, spec.title, CHECK_STATUS.FAIL, {
      required: true,
      detail:
        `${path} is present (${size}) but is NOT the pinned artifact. Expected ${asset.expectedSha256} ` +
        `(${digestRef}); found ${asset.actualSha256 ?? "an unreadable file"}.`,
      fix:
        `Gradle rejects it for the same reason, so this fails the build too (${spec.buildFailure}). ` +
        `Replace it with the exact pinned copy. ${spec.provenance}`,
    });
  }

  const observed =
    typeof asset.sizeBytes === "number" && asset.sizeBytes !== spec.observedBytes
      ? ` Note: ${spec.observedBytesRef} was ${spec.observedBytes.toLocaleString("en-US")} bytes.`
      : "";
  return makeCheck(spec.id, spec.title, CHECK_STATUS.PASS, {
    required: true,
    detail: `${path} (${size}); SHA-256 matches the pin at ${digestRef}.${observed}`,
  });
}

/**
 * Optional attached Pin. Never required, never a failure — every check above is
 * host-only, and this doctor must pass on a machine that has never seen a Pin.
 * Serials are counted, never printed.
 */
function checkPinDevice(probes) {
  const devices = probes.devices ?? null;
  const title = "Attached Pin (optional)";

  if (!devices || devices.adbAvailable !== true) {
    return makeCheck("pin_device", title, CHECK_STATUS.WARN, {
      detail: "Device state unknown: `adb` is unavailable, so `adb devices` was not run.",
      fix: "Informational only. No host check above needs a device; attach one only for deploy and on-device verification.",
    });
  }
  const counts = devices.counts ?? { ready: 0, unauthorized: 0, other: 0 };
  if (counts.ready > 0) {
    return makeCheck("pin_device", title, CHECK_STATUS.PASS, {
      detail: `${counts.ready} device(s) in state \`device\` (serials withheld).`,
      fix: "",
    });
  }
  if (counts.unauthorized > 0) {
    return makeCheck("pin_device", title, CHECK_STATUS.WARN, {
      detail: `${counts.unauthorized} device(s) reporting \`unauthorized\`.`,
      fix: "Informational only. Accept the USB debugging prompt on the device if you intend to deploy; nothing above needs it.",
    });
  }
  return makeCheck("pin_device", title, CHECK_STATUS.WARN, {
    detail: "No device attached.",
    fix: "Informational only — this is the expected state. Every check above is host-only and passes with no device.",
  });
}

const CHECK_BUILDERS = Object.freeze([
  checkNode,
  checkContainerBuilder,
  checkJdk,
  checkAndroidSdk,
  checkPlatformTools,
  checkNdk,
  checkRustc,
  checkCargo,
  checkRustTarget,
  checkCargoNdk,
  checkProtoc,
  checkStockEvidence,
  // Derived from the constant so the check ids and the asset list cannot drift.
  ...GATED_BUILD_ASSETS.map((spec) => (probes) => checkGatedAsset(probes, spec)),
  checkSigningEnv,
  checkSigningEnvironment,
  checkPinDevice,
]);

/**
 * The whole decision layer. Pure: reads only `probes`, performs no I/O.
 * `ok` is false if and only if a REQUIRED check failed.
 */
export function evaluate(probes) {
  const input = probes ?? {};
  const rawChecks = CHECK_BUILDERS.map((builder) => builder(input));
  const containerSuppliesToolchain = input.containerBuilder?.suppliesHostToolchain === true;
  const optionalHostToolIds = new Set([
    "jdk",
    "android_sdk",
    "android_platform_tools",
    "android_ndk",
    "rustc",
    "cargo",
    "rust_target_android",
    "cargo_ndk",
    "protoc",
  ]);
  const checks = rawChecks.map((check) =>
    containerSuppliesToolchain && optionalHostToolIds.has(check.id) && check.status === CHECK_STATUS.FAIL
      ? makeCheck(check.id, `${check.title} (optional host install)`, CHECK_STATUS.WARN, {
          detail: `Not available on the host; the canonical pinned container supplies it when Docker is ready. ${check.detail}`,
          fix: check.fix,
        })
      : check,
  );
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) {
    if (check.status in counts) counts[check.status] += 1;
  }
  const blocking = checks.filter(
    (check) => check.required === true && check.status === CHECK_STATUS.FAIL,
  );
  return Object.freeze({
    ok: blocking.length === 0,
    counts: Object.freeze(counts),
    blocking: Object.freeze(blocking.map((check) => check.id)),
    requirementsSource: input.requirements?.sourceRef ?? null,
    buildPath: containerSuppliesToolchain ? "pinned-container" : "host-toolchain",
    checks: Object.freeze(checks),
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function nextStepLine(result) {
  if (!result.ok) {
    const ids = result.blocking.join(", ");
    return `Next step: fix the blocking check(s) — ${ids} — using the \`fix:\` line above, then re-run \`node platform/containers/pin-builder/doctor.mjs\`.`;
  }
  const warnNote =
    result.counts.warn > 0
      ? `${result.counts.warn} warning(s) above are non-blocking. `
      : "";
  return (
    `Next step: host prerequisites satisfied. ${warnNote}` +
    "Start with the cheapest gate — `node --test platform/containers/pin-builder/*.test.mjs` — before any Gradle or cargo build."
  );
}

const MARKERS = Object.freeze({ fail: "FAIL", warn: "WARN", pass: "PASS" });

export function renderHuman(result, { verbose = false, home = homedir() } = {}) {
  const lines = [];
  lines.push("Ai Pin Revival host doctor — read-only preflight (no device, no network, no secret values).");
  lines.push(
    result.requirementsSource
      ? `Expected versions read from ${result.requirementsSource}.`
      : "Expected versions could not be read from README.md; version comparisons are reported as warnings.",
  );
  lines.push(
    `Canonical build path: ${result.buildPath === "pinned-container" ? "pinned linux/amd64 container" : "host toolchain"}.`,
  );
  lines.push("");

  for (const status of [CHECK_STATUS.FAIL, CHECK_STATUS.WARN, CHECK_STATUS.PASS]) {
    const group = result.checks.filter((check) => check.status === status);
    if (group.length === 0) continue;
    lines.push(`${MARKERS[status]} (${group.length})`);
    for (const check of group) {
      const required = check.required && status !== CHECK_STATUS.PASS ? " [required]" : "";
      lines.push(`  - ${check.title}${required}: ${check.detail}`);
      const showFix = check.fix && (status !== CHECK_STATUS.PASS || verbose);
      if (showFix) lines.push(`      fix: ${check.fix}`);
    }
    lines.push("");
  }

  lines.push(
    `Summary: ${result.counts.pass} pass, ${result.counts.warn} warn, ${result.counts.fail} fail — ` +
      `${result.ok ? "all required checks passed" : "a required check failed"}.`,
  );
  lines.push(nextStepLine(result));
  // One rewrite over the finished report, so no future line can forget it.
  return abbreviateHome(lines.join("\n"), home);
}

export function renderJson(result, { home = homedir() } = {}) {
  const shorten = (text) => abbreviateHome(text, home);
  return {
    tool: "revival-pin-doctor",
    ok: result.ok,
    requirements_source: result.requirementsSource,
    build_path: result.buildPath,
    counts: { ...result.counts },
    blocking: [...result.blocking],
    next_step: shorten(nextStepLine(result)),
    // Paths only ever reach output through `detail` and `fix`; the same `~`
    // rule applies here, because a JSON report is just as pasteable.
    checks: result.checks.map((check) => ({
      id: check.id,
      title: check.title,
      status: check.status,
      required: check.required,
      detail: shorten(check.detail),
      fix: shorten(check.fix),
    })),
  };
}

// ---------------------------------------------------------------------------
// Probe collection (impure). Every command is a bounded, timed-out version
// query; nothing here builds, installs, writes, or touches a device beyond the
// read-only `adb devices`.
// ---------------------------------------------------------------------------

function runCapture(command, args, environment) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_OUTPUT_BYTES,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    if (result.error) return { ok: false, stdout: "", stderr: "" };
    return {
      ok: result.status === 0,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}

function firstLine(text) {
  const line = String(text ?? "").split("\n").find((candidate) => candidate.trim().length > 0);
  return line ? line.trim().slice(0, 200) : null;
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listDirectory(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function resolveAndroidSdk(repoRoot, environment) {
  const localProperties = readTextOrNull(join(repoRoot, "local.properties"));
  const fromLocal = parseSdkDir(localProperties);
  const candidates = [
    fromLocal ? { path: fromLocal, source: "local.properties sdk.dir" } : null,
    environment.ANDROID_HOME ? { path: environment.ANDROID_HOME, source: "ANDROID_HOME" } : null,
    environment.ANDROID_SDK_ROOT ? { path: environment.ANDROID_SDK_ROOT, source: "ANDROID_SDK_ROOT" } : null,
  ].filter(Boolean);

  const chosen = candidates.find((candidate) => existsSync(candidate.path)) ?? candidates[0] ?? null;
  if (!chosen) return { path: null, source: null, exists: false, platforms: [], buildTools: [] };
  const exists = existsSync(chosen.path);
  return {
    path: chosen.path,
    source: chosen.source,
    exists,
    platforms: exists ? listDirectory(join(chosen.path, "platforms")) : [],
    buildTools: exists ? listDirectory(join(chosen.path, "build-tools")) : [],
  };
}

function resolveNdk(sdkPath, environment) {
  const sdkNdkDir = sdkPath ? join(sdkPath, "ndk") : null;
  const candidates = sdkNdkDir ? listDirectory(sdkNdkDir) : [];

  const envEntry = [
    ["ANDROID_NDK_ROOT", environment.ANDROID_NDK_ROOT],
    ["ANDROID_NDK_HOME", environment.ANDROID_NDK_HOME],
    ["NDK_HOME", environment.NDK_HOME],
  ].find(([, value]) => typeof value === "string" && value.length > 0 && existsSync(value));

  let path = null;
  let source = null;
  if (envEntry) {
    path = envEntry[1];
    source = envEntry[0];
  } else if (candidates.length > 0) {
    const newest = [...candidates].sort((a, b) => compareVersions(a, b)).pop();
    path = join(sdkNdkDir, newest);
    source = "Android SDK ndk/ directory";
  } else if (sdkPath && existsSync(join(sdkPath, "ndk-bundle"))) {
    path = join(sdkPath, "ndk-bundle");
    source = "Android SDK ndk-bundle";
  }

  if (!path) return { path: null, source: null, revision: null, candidates };
  const revision = parseNdkRevision(readTextOrNull(join(path, "source.properties")));
  return { path, source, revision, candidates };
}

function resolveAdb(sdkPath, environment) {
  const sdkAdb = sdkPath ? join(sdkPath, "platform-tools", "adb") : null;
  if (sdkAdb && existsSync(sdkAdb)) {
    const probe = runCapture(sdkAdb, ["version"], environment);
    return { present: true, path: sdkAdb, version: firstLine(probe.stdout), command: sdkAdb };
  }
  const probe = runCapture("adb", ["version"], environment);
  if (probe.ok || probe.stdout.length > 0) {
    return { present: true, path: "adb (PATH)", version: firstLine(probe.stdout), command: "adb" };
  }
  return { present: false, path: null, version: null, command: null };
}

function resolveRustTarget(environment) {
  const rustup = runCapture("rustup", ["target", "list", "--installed"], environment);
  if (rustup.ok) {
    const installed = rustup.stdout
      .split("\n")
      .map((line) => line.trim())
      .includes(ANDROID_RUST_TARGET);
    return { determined: true, installed, source: "rustup" };
  }
  const sysroot = runCapture("rustc", ["--print", "sysroot"], environment);
  const root = sysroot.ok ? firstLine(sysroot.stdout) : null;
  if (root) {
    const targetDir = join(root, "lib", "rustlib", ANDROID_RUST_TARGET);
    return { determined: true, installed: existsSync(targetDir), source: "rustc sysroot" };
  }
  return { determined: false, installed: false, source: null };
}

function statModeOrNull(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

const DIGEST_CHUNK_BYTES = 1024 * 1024;

/**
 * Streaming SHA-256, in fixed-size chunks. The codex asset is ~217 MB, so
 * `readFileSync` would allocate the whole thing; this holds one megabyte.
 */
function sha256OfFile(path) {
  let handle = null;
  try {
    handle = openSync(path, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES);
    for (;;) {
      const read = readSync(handle, buffer, 0, DIGEST_CHUNK_BYTES, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        // Nothing useful to do; the digest result already reflects the failure.
      }
    }
  }
}

/**
 * Presence and digest of each gated native input.
 *
 * The digest is computed whenever the file is present and the pin is readable,
 * and is NOT short-circuited on a size mismatch. Skipping the hash when the
 * size disagrees with `observedBytes` looks like a free optimisation and is
 * not: `observedBytes` is an operator-held artifact measurement, while the
 * digest comes from the canonical build file that enforces the gate. The two
 * are allowed to disagree after an explicit re-pin. Gating on the observation would report a
 * correctly re-pinned asset as unreadable. Hashing both assets costs ~0.2s.
 *
 * Exported because it is the one probe with a decision in it, and a decision
 * that is only reachable through `collectProbes` is a decision no test can
 * make go red.
 */
export function resolveGatedAssets(repoRoot, operatorHome = homedir()) {
  const pins = parseGatedAssetPins(
    readTextOrNull(join(repoRoot, "runtime", "android", "build.gradle.kts")),
  );

  return GATED_BUILD_ASSETS.map((spec) => {
    const pin = pins[spec.id] ?? null;
    const relativePath = pin?.path ?? spec.fallbackPath;
    const absolutePath = relativePath.startsWith("~/")
      ? join(operatorHome, relativePath.slice(2))
      : join(repoRoot, relativePath);

    let sizeBytes = null;
    try {
      const stats = statSync(absolutePath);
      if (stats.isFile()) sizeBytes = stats.size;
    } catch {
      sizeBytes = null;
    }

    const exists = sizeBytes !== null;
    const expectedSha256 = pin?.sha256 ?? null;

    return {
      id: spec.id,
      path: relativePath,
      pathSource: pin?.pathRef ?? null,
      exists,
      sizeBytes,
      expectedSha256,
      expectedSha256Ref: pin?.sha256Ref ?? null,
      // Null only when the file genuinely could not be read; the check says so
      // in those words rather than claiming a digest mismatch.
      actualSha256: exists && expectedSha256 !== null ? sha256OfFile(absolutePath) : null,
    };
  });
}

/**
 * Which of the four signing variables are exported, by NAME. The value is
 * tested for non-blankness and then dropped; it is never stored or returned.
 * Mirrors `secretProperty` in runtime/android/build.gradle.kts, whose signing
 * environment expectations this check exists to report.
 */
function resolveSigningEnvironment(environment, fileKeys) {
  const exported = REQUIRED_SIGNING_KEYS.filter((name) => {
    const value = environment?.[name];
    return typeof value === "string" && value.trim().length > 0;
  });
  const observed = Array.isArray(fileKeys) ? fileKeys : [];
  return {
    exported,
    fileComplete: REQUIRED_SIGNING_KEYS.every((name) => observed.includes(name)),
  };
}

export function resolveSigningEnvPath(environment = process.env, operatorHome = homedir()) {
  const configRoot = resolve(
    environment.REVIVAL_CONFIG_DIR ??
      join(environment.XDG_CONFIG_HOME ?? join(operatorHome, ".config"), "ai-pin-revival"),
  );
  const secretsRoot = resolve(environment.REVIVAL_SECRETS_DIR ?? join(configRoot, "secrets"));
  return join(secretsRoot, "pin", "signing.env");
}

export function collectProbes({ repoRoot, env = process.env } = {}) {
  const root = repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../pin");
  const productRoot = resolve(root, "..");
  const requirements = parseRequirementsFromReadme(readTextOrNull(join(root, "README.md")));

  const androidSdk = resolveAndroidSdk(root, env);
  const ndk = resolveNdk(androidSdk.exists ? androidSdk.path : null, env);
  const adb = resolveAdb(androidSdk.exists ? androidSdk.path : null, env);

  const javaProbe = runCapture("java", ["-version"], env);
  const javaBanner = `${javaProbe.stderr}\n${javaProbe.stdout}`;
  const javaVersion = parseJavaVersion(javaBanner);

  const rustcProbe = runCapture("rustc", ["--version"], env);
  const cargoProbe = runCapture("cargo", ["--version"], env);
  const cargoNdkProbe = runCapture("cargo", ["ndk", "--version"], env);
  const protocProbe = runCapture("protoc", ["--version"], env);

  const signingPath = resolveSigningEnvPath(env);
  const signingText = readTextOrNull(signingPath);
  // Names only. `parseEnvKeyNames` never captures anything right of `=`.
  const signingFileKeys = signingText === null ? [] : parseEnvKeyNames(signingText);
  const insidePinnedBuilder = env.REVIVAL_INSIDE_PIN_BUILDER === "true";
  const dockerProbe = insidePinnedBuilder
    ? { ok: true, stdout: "pinned-image", stderr: "" }
    : runCapture("docker", ["version", "--format", "{{.Client.Version}}"], env);
  const containerContractFiles = [
    "platform/containers/pin-builder/Dockerfile",
    "platform/containers/pin-builder/entrypoint.sh",
    "platform/containers/pin-builder/toolchain.json",
  ];

  let devices = { adbAvailable: false, counts: { ready: 0, unauthorized: 0, other: 0 } };
  if (adb.present && adb.command) {
    const listed = runCapture(adb.command, ["devices"], env);
    devices = { adbAvailable: true, counts: parseAdbDevices(listed.stdout) };
  }

  return {
    repoRoot: root,
    requirements,
    node: { version: process.versions.node },
    containerBuilder: {
      available: dockerProbe.ok,
      version: firstLine(dockerProbe.stdout),
      contractFilesPresent: containerContractFiles.every((file) => existsSync(join(productRoot, file))),
      suppliesHostToolchain: true,
    },
    java: {
      present: javaVersion !== null || javaProbe.ok,
      version: javaVersion?.version ?? null,
      major: javaVersion?.major ?? null,
    },
    androidSdk,
    adb,
    ndk,
    rustc: { present: rustcProbe.ok, version: firstLine(rustcProbe.stdout) },
    cargo: { present: cargoProbe.ok, version: firstLine(cargoProbe.stdout) },
    rustTarget: resolveRustTarget(env),
    cargoNdk: { present: cargoNdkProbe.ok, version: firstLine(cargoNdkProbe.stdout) },
    protoc: { present: protocProbe.ok, version: firstLine(protocProbe.stdout) },
    stockEvidence: {
      exists: existsSync(join(root, STOCK_EVIDENCE_RELATIVE_PATH)),
      path: STOCK_EVIDENCE_RELATIVE_PATH,
    },
    gatedAssets: resolveGatedAssets(root),
    signingEnv: {
      exists: signingText !== null,
      path: signingPath,
      keys: signingFileKeys,
      mode: signingText === null ? null : statModeOrNull(signingPath),
    },
    signingEnvironment: resolveSigningEnvironment(env, signingFileKeys),
    devices,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function usage() {
  return [
    "Usage:",
    "  node platform/containers/pin-builder/doctor.mjs [--json] [--verbose]",
    "",
    "Read-only host preflight for building this repo. Requires no device, no",
    "network, and no secrets. Reports every check rather than stopping at the",
    "first miss. Exit 0 when all required checks pass, 1 when a required check",
    "fails, 2 on bad usage.",
    "",
    "  --json     machine-readable report on stdout",
    "  --verbose  also print the fix line for passing checks",
    "  --help     this message",
    "",
    "The report is meant to be pasteable: signing values are never read, device",
    "serials are counted rather than named, and your home directory is",
    "abbreviated to `~` in both the human and the --json output.",
    "",
    "Verifying the two pinned native build inputs reads ~220 MB when they are",
    "present; nothing is written, built, or downloaded.",
  ].join("\n");
}

export function parseCliArgs(argv) {
  let json = false;
  let verbose = false;
  let help = false;
  for (const argument of argv) {
    switch (argument) {
      case "--json":
        json = true;
        break;
      case "--verbose":
      case "-v":
        verbose = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`unrecognized argument: ${argument}`);
    }
  }
  return { json, verbose, help };
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const result = evaluate(collectProbes({}));
  if (options.json) {
    stdout.write(`${JSON.stringify(renderJson(result), null, 2)}\n`);
  } else {
    stdout.write(`${renderHuman(result, { verbose: options.verbose })}\n`);
  }
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
