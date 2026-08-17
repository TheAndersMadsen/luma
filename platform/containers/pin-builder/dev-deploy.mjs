#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../pin");

const MODULE_BUILDS = {
  hook: {
    task: ":hook:payload:assembleDebug",
    apk: "hook/payload/build/outputs/apk/debug/hook-debug.apk",
  },
  injector: {
    task: ":hook:loader:assembleDebug",
    apk: "hook/loader/build/outputs/apk/debug/injector-debug.apk",
  },
  server: {
    task: ":runtime:android:assembleDebug",
    apk: "runtime/android/build/outputs/apk/debug/server-debug.apk",
  },
};

const INSTALL_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_PROBE_TIMEOUT_MS = 5_000;
const HEALTH_INTERVAL_MS = 2_000;

function usage(exitCode = 1) {
  console.error(`Usage: platform/containers/pin-builder/dev-deploy.mjs --host <ip-or-url> [--token-file <path> | --token-fd <n>] [--no-build] [--apk <path> ...] [hook|injector|server ...]

Examples:
  platform/containers/pin-builder/dev-deploy.mjs --host 192.168.1.50 hook injector
  platform/containers/pin-builder/dev-deploy.mjs --host http://192.168.1.50:8080 --apk path/to/app.apk --no-build
  platform/containers/pin-builder/dev-deploy.mjs --host 192.168.1.50 --token-file ~/.penumbra-token server
  printf '%s' "secret" | platform/containers/pin-builder/dev-deploy.mjs --host 192.168.1.50 --token-fd 0 server

Named modules (hook, injector, server) always build fresh debug APKs. Named
modules with --no-build are rejected because the build-output path may hold a
stale artifact from an earlier build. Use --apk with --no-build for an explicit
prebuilt artifact.

Bearer token: pass --token-file <path> (owner-only permissions, no group or
other read/write/execute bits) or --token-fd <n> (pre-opened file descriptor;
0 for stdin). The token is sent as an Authorization header on install requests
and is never logged, echoed, or included in error output. The legacy --token
flag and PENUMBRA_ADMIN_TOKEN environment variable are not accepted.
Without external compatibility-signing inputs, debug APKs use the host debug
signer and normally cannot replace privileged installed packages. They are not
release artifacts.`);
  process.exit(exitCode);
}

export function parseArgs(argv) {
  const modules = [];
  const apks = [];
  let host = null;
  let build = true;
  let tokenFile = null;
  let tokenFd = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--host":
        host = argv[++i];
        if (!host) usage();
        break;
      case "--apk": {
        const apk = argv[++i];
        if (!apk) usage();
        apks.push(path.resolve(repoRoot, apk));
        break;
      }
      case "--token":
        throw new Error(
          "--token is not accepted; use --token-file <path> or --token-fd <n>",
        );
      case "--token-file":
        tokenFile = argv[++i];
        if (!tokenFile) usage();
        break;
      case "--token-fd": {
        const fdStr = argv[++i];
        if (!fdStr) usage();
        const fd = Number(fdStr);
        if (!Number.isInteger(fd) || fd < 0) {
          throw new Error("--token-fd requires a non-negative integer");
        }
        tokenFd = fd;
        break;
      }
      case "--no-build":
        build = false;
        break;
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        if (!Object.hasOwn(MODULE_BUILDS, arg)) {
          console.error(`Unknown module or option: ${arg}`);
          usage();
        }
        modules.push(arg);
        break;
    }
  }

  if (!host) usage();
  if (modules.length === 0 && apks.length === 0) usage();

  if (tokenFile !== null && tokenFd !== null) {
    throw new Error("specify --token-file or --token-fd, not both");
  }

  if (!build && modules.length > 0) {
    throw new Error(
      `--no-build is incompatible with named modules (${modules.join(", ")}). ` +
        "Named modules require a build step. Use --apk with --no-build for " +
        "explicit prebuilt artifacts, or remove --no-build to build fresh APKs.",
    );
  }

  return { host: normalizeHost(host), build, modules, apks, tokenFile, tokenFd };
}

export async function readTokenFile(tokenPath) {
  const resolved = path.resolve(tokenPath);
  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    throw new Error("token file not found");
  }
  if (!stats.isFile()) {
    throw new Error("token path is not a regular file");
  }
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `token file has insecure permissions (0${mode.toString(8)}); ` +
        "require owner-only access (no group or other bits)",
    );
  }
  const content = await readFile(resolved, "utf8");
  const token = content.trim();
  if (!token) {
    throw new Error("token file is empty");
  }
  return token;
}

export async function readTokenFd(fdNumber) {
  let content;
  try {
    content = readFileSync(fdNumber, "utf8");
  } catch {
    throw new Error("failed to read token from file descriptor");
  }
  const token = content.trim();
  if (!token) {
    throw new Error("token from file descriptor is empty");
  }
  return token;
}

export async function resolveToken({ tokenFile, tokenFd }) {
  if (tokenFile !== null && tokenFile !== undefined &&
      tokenFd !== null && tokenFd !== undefined) {
    throw new Error("specify --token-file or --token-fd, not both");
  }
  if (tokenFile !== null && tokenFile !== undefined) {
    return readTokenFile(tokenFile);
  }
  if (tokenFd !== null && tokenFd !== undefined) {
    return readTokenFd(tokenFd);
  }
  return null;
}

export function createModuleBuildPlan(modules) {
  return modules.map((module) => ({
    module,
    task: MODULE_BUILDS[module].task,
    apk: MODULE_BUILDS[module].apk,
  }));
}

function normalizeHost(host) {
  if (host.startsWith("http://") || host.startsWith("https://")) {
    return host.replace(/\/$/, "");
  }
  return `http://${host}:8080`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function safeUploadName(index, apkPath) {
  const parsed = path.parse(path.basename(apkPath));
  const base = parsed.name.replace(/[^A-Za-z0-9._-]/g, "_");
  const ext = (parsed.ext || ".apk").replace(/[^A-Za-z0-9._-]/g, "_");
  return `${Date.now()}-${index}-${base}${ext}`;
}

export function buildInstallHeaders(token) {
  const headers = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

function redactFromText(text, token) {
  if (!token || !text) return text;
  return text.replaceAll(token, "[REDACTED]");
}

export async function requestInstall(
  host,
  apkPaths,
  filenames,
  token,
  timeoutMs = INSTALL_TIMEOUT_MS,
) {
  const form = new FormData();
  for (let i = 0; i < apkPaths.length; i++) {
    const bytes = await readFile(apkPaths[i]);
    const blob = new Blob([bytes], {
      type: "application/vnd.android.package-archive",
    });
    form.append("apk", blob, filenames[i]);
  }

  const response = await fetch(`${host}/api/dev/install`, {
    method: "POST",
    body: form,
    headers: buildInstallHeaders(token),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable body>");
    const safeBody = redactFromText(body, token);
    throw new Error(
      `install request failed (${response.status}): ${safeBody}`,
    );
  }

  return response.json();
}

export async function waitForHealth(
  host,
  timeoutMs = HEALTH_TIMEOUT_MS,
  intervalMs = HEALTH_INTERVAL_MS,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${host}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      if (response.ok) return;
    } catch {
      // Expected while system_server/server restarts.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${host}/api/health`);
}

export function summarizeInstallResult(result) {
  const accepted = result && result.accepted === true;
  const restartExpected = result && result.restart_expected === true;
  const apkCount = Array.isArray(result && result.apks) ? result.apks.length : 0;
  return { accepted, restartExpected, apkCount };
}

async function main() {
  const { host, build, modules, apks, tokenFile, tokenFd } = parseArgs(
    process.argv.slice(2),
  );
  const token = await resolveToken({ tokenFile, tokenFd });
  const modulePlan = createModuleBuildPlan(modules);

  if (build && modules.length > 0) {
    const tasks = modulePlan.map(({ task }) => task);
    console.log(`[1/4] Building debug APKs for ${modules.join(", ")}...`);
    await run("./gradlew", tasks);
  } else {
    console.log("[1/4] Skipping build (explicit --apk artifacts only)");
  }

  const moduleApks = modulePlan.map(({ apk }) => path.join(repoRoot, apk));
  const apkPaths = [...moduleApks, ...apks];
  for (const apkPath of apkPaths) {
    if (!existsSync(apkPath)) {
      throw new Error(`APK not found: ${apkPath}`);
    }
  }

  const uploadNames = apkPaths.map((apkPath, index) =>
    safeUploadName(index, apkPath),
  );

  console.log(
    `[2/4] Uploading and installing ${apkPaths.length} APK(s) to ${host}...`,
  );
  for (let i = 0; i < apkPaths.length; i++) {
    console.log(`      ${path.basename(apkPaths[i])} -> ${uploadNames[i]}`);
  }
  if (token) {
    console.log("      bearer token: provided (value suppressed)");
  }

  const installResult = await requestInstall(host, apkPaths, uploadNames, token);
  const summary = summarizeInstallResult(installResult);
  console.log(
    `      server response: accepted=${summary.accepted} ` +
      `restart_expected=${summary.restartExpected} apks=${summary.apkCount}`,
  );
  if (!summary.accepted) {
    throw new Error(
      "install response did not confirm acceptance: " +
        JSON.stringify(installResult),
    );
  }

  console.log("[3/4] Waiting for server health...");
  await waitForHealth(host);

  console.log(
    "[4/4] Dev deploy finished. Server accepted upload and health is reachable. " +
      "This does not prove on-device artifact identity or physical acceptance. " +
      "Verify installed version, signer, and digest on the target device before " +
      "treating this as anything beyond a development iteration.",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}
