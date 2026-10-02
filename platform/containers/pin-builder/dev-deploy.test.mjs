import assert from "node:assert/strict";
import http from "node:http";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildInstallHeaders,
  createModuleBuildPlan,
  parseArgs,
  readTokenFd,
  readTokenFile,
  requestInstall,
  resolveToken,
  summarizeInstallResult,
  waitForHealth,
} from "./dev-deploy.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../pin",
);

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "penumbra-deploy-test-"));
}

function cleanupTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Existing postconditions: module build plan and --no-build rejection
// ---------------------------------------------------------------------------

test("named modules default to debug tasks and debug APK outputs", () => {
  const options = parseArgs([
    "--host",
    "192.0.2.1",
    "hook",
    "loader",
    "server",
  ]);

  assert.equal(options.build, true);
  assert.equal(options.tokenFile, null);
  assert.equal(options.tokenFd, null);
  assert.deepEqual(createModuleBuildPlan(options.modules), [
    {
      module: "hook",
      task: ":hook:module:assembleDebug",
      apk: "hook/module/build/outputs/apk/debug/hook-debug.apk",
    },
    {
      module: "loader",
      task: ":hook:loader:assembleDebug",
      apk: "hook/loader/build/outputs/apk/debug/loader-debug.apk",
    },
    {
      module: "server",
      task: ":runtime:android:assembleDebug",
      apk: "runtime/android/build/outputs/apk/debug/server-debug.apk",
    },
  ]);
});

test("an explicit prebuilt APK remains a no-build path", () => {
  const options = parseArgs([
    "--host",
    "https://example.invalid/",
    "--apk",
    "artifacts/custom.apk",
    "--no-build",
  ]);

  assert.equal(options.host, "https://example.invalid");
  assert.equal(options.build, false);
  assert.deepEqual(options.modules, []);
  assert.deepEqual(options.apks, [
    path.join(repositoryRoot, "artifacts/custom.apk"),
  ]);
});

test("--no-build with named modules is rejected as potentially stale", () => {
  assert.throws(
    () => parseArgs(["--host", "192.0.2.1", "--no-build", "hook"]),
    (error) => {
      assert.match(error.message, /--no-build is incompatible with named modules/);
      assert.match(error.message, /hook/);
      return true;
    },
  );
});

test("--no-build with multiple named modules names them all in the error", () => {
  assert.throws(
    () =>
      parseArgs([
        "--host",
        "192.0.2.1",
        "--no-build",
        "hook",
        "server",
      ]),
    (error) => {
      assert.match(error.message, /hook, server/);
      return true;
    },
  );
});

test("host normalization strips trailing slash from URLs", () => {
  const options = parseArgs([
    "--host",
    "http://192.0.2.1:9090/",
    "--apk",
    "build/out.apk",
  ]);
  assert.equal(options.host, "http://192.0.2.1:9090");
});

test("host normalization adds scheme and default port for bare addresses", () => {
  const options = parseArgs([
    "--host",
    "192.0.2.1",
    "--apk",
    "build/out.apk",
  ]);
  assert.equal(options.host, "http://192.0.2.1:8080");
});

// ---------------------------------------------------------------------------
// Argv/env rejection: --token flag and PENUMBRA_ADMIN_TOKEN are not accepted
// ---------------------------------------------------------------------------

test("--token flag is rejected with a clear error message", () => {
  assert.throws(
    () =>
      parseArgs([
        "--host",
        "192.0.2.1",
        "--token",
        "secret-value",
        "--apk",
        "build/out.apk",
      ]),
    (error) => {
      assert.match(error.message, /--token is not accepted/);
      assert.match(error.message, /--token-file/);
      assert.match(error.message, /--token-fd/);
      return true;
    },
  );
});

test("--token rejection error does not contain the attempted token value", () => {
  const secretValue = "super-secret-token-abc123";
  try {
    parseArgs([
      "--host",
      "192.0.2.1",
      "--token",
      secretValue,
      "--apk",
      "build/out.apk",
    ]);
    assert.fail("expected parseArgs to throw");
  } catch (error) {
    assert.ok(
      !error.message.includes(secretValue),
      "error message must not contain the token value",
    );
  }
});

test("resolveToken ignores PENUMBRA_ADMIN_TOKEN even when set", async () => {
  const original = process.env.PENUMBRA_ADMIN_TOKEN;
  try {
    process.env.PENUMBRA_ADMIN_TOKEN = "env-token-should-be-ignored";
    const token = await resolveToken({ tokenFile: null, tokenFd: null });
    assert.equal(token, null);
  } finally {
    if (original === undefined) {
      delete process.env.PENUMBRA_ADMIN_TOKEN;
    } else {
      process.env.PENUMBRA_ADMIN_TOKEN = original;
    }
  }
});

test("resolveToken returns null when neither token-file nor token-fd is given", async () => {
  const original = process.env.PENUMBRA_ADMIN_TOKEN;
  try {
    delete process.env.PENUMBRA_ADMIN_TOKEN;
    const token = await resolveToken({ tokenFile: null, tokenFd: null });
    assert.equal(token, null);
  } finally {
    if (original !== undefined) {
      process.env.PENUMBRA_ADMIN_TOKEN = original;
    }
  }
});

// ---------------------------------------------------------------------------
// --token-file and --token-fd parsing
// ---------------------------------------------------------------------------

test("--token-file is parsed into tokenFile", () => {
  const options = parseArgs([
    "--host",
    "192.0.2.1",
    "--token-file",
    "/tmp/my-token",
    "--apk",
    "build/out.apk",
  ]);
  assert.equal(options.tokenFile, "/tmp/my-token");
  assert.equal(options.tokenFd, null);
});

test("--token-fd is parsed into tokenFd as an integer", () => {
  const options = parseArgs([
    "--host",
    "192.0.2.1",
    "--token-fd",
    "3",
    "--apk",
    "build/out.apk",
  ]);
  assert.equal(options.tokenFd, 3);
  assert.equal(options.tokenFile, null);
});

test("--token-fd 0 (stdin) is accepted", () => {
  const options = parseArgs([
    "--host",
    "192.0.2.1",
    "--token-fd",
    "0",
    "--apk",
    "build/out.apk",
  ]);
  assert.equal(options.tokenFd, 0);
});

test("--token-fd rejects non-integer values", () => {
  assert.throws(
    () =>
      parseArgs([
        "--host",
        "192.0.2.1",
        "--token-fd",
        "abc",
        "--apk",
        "build/out.apk",
      ]),
    (error) => {
      assert.match(error.message, /--token-fd requires a non-negative integer/);
      return true;
    },
  );
});

test("--token-fd rejects negative values", () => {
  assert.throws(
    () =>
      parseArgs([
        "--host",
        "192.0.2.1",
        "--token-fd",
        "-1",
        "--apk",
        "build/out.apk",
      ]),
    (error) => {
      assert.match(error.message, /--token-fd requires a non-negative integer/);
      return true;
    },
  );
});

test("specifying both --token-file and --token-fd is rejected", () => {
  assert.throws(
    () =>
      parseArgs([
        "--host",
        "192.0.2.1",
        "--token-file",
        "/tmp/tok",
        "--token-fd",
        "3",
        "--apk",
        "build/out.apk",
      ]),
    (error) => {
      assert.match(error.message, /not both/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Private input handling: readTokenFile
// ---------------------------------------------------------------------------

test("readTokenFile reads a valid owner-only token file", async () => {
  const dir = makeTempDir();
  try {
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, "  valid-token-value\n", { mode: 0o600 });
    const token = await readTokenFile(tokenFile);
    assert.equal(token, "valid-token-value");
  } finally {
    cleanupTempDir(dir);
  }
});

test("readTokenFile rejects world-readable token file", async () => {
  const dir = makeTempDir();
  try {
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, "secret-value\n", { mode: 0o600 });
    const { chmodSync } = await import("node:fs");
    chmodSync(tokenFile, 0o644);
    await assert.rejects(
      () => readTokenFile(tokenFile),
      (error) => {
        assert.match(error.message, /insecure permissions/);
        assert.ok(
          !error.message.includes("secret-value"),
          "error must not contain token value",
        );
        return true;
      },
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("readTokenFile rejects group-readable token file", async () => {
  const dir = makeTempDir();
  try {
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, "secret-value\n", { mode: 0o600 });
    const { chmodSync } = await import("node:fs");
    chmodSync(tokenFile, 0o640);
    await assert.rejects(
      () => readTokenFile(tokenFile),
      (error) => {
        assert.match(error.message, /insecure permissions/);
        return true;
      },
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("readTokenFile rejects an empty token file", async () => {
  const dir = makeTempDir();
  try {
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, "   \n\n  ", { mode: 0o600 });
    await assert.rejects(
      () => readTokenFile(tokenFile),
      (error) => {
        assert.match(error.message, /token file is empty/);
        return true;
      },
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("readTokenFile rejects a missing file", async () => {
  await assert.rejects(
    () => readTokenFile("/nonexistent/path/token-file-xyz"),
    (error) => {
      assert.match(error.message, /token file not found/);
      return true;
    },
  );
});

test("readTokenFile rejects a directory path", async () => {
  const dir = makeTempDir();
  try {
    await assert.rejects(
      () => readTokenFile(dir),
      (error) => {
        assert.match(error.message, /not a regular file/);
        return true;
      },
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test("readTokenFile trims leading and trailing whitespace", async () => {
  const dir = makeTempDir();
  try {
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, "\n\n  my-token  \n\n", { mode: 0o600 });
    const token = await readTokenFile(tokenFile);
    assert.equal(token, "my-token");
  } finally {
    cleanupTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Private input handling: readTokenFd
// ---------------------------------------------------------------------------

test("readTokenFd reads a token from an open file descriptor", async () => {
  const dir = makeTempDir();
  try {
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, "fd-token-value\n");
    const fd = openSync(tokenFile, "r");
    try {
      const token = await readTokenFd(fd);
      assert.equal(token, "fd-token-value");
    } finally {
      closeSync(fd);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test("readTokenFd rejects an empty file descriptor", async () => {
  const dir = makeTempDir();
  try {
    const emptyFile = path.join(dir, "empty");
    writeFileSync(emptyFile, "");
    const fd = openSync(emptyFile, "r");
    try {
      await assert.rejects(
        () => readTokenFd(fd),
        (error) => {
          assert.match(error.message, /empty/);
          return true;
        },
      );
    } finally {
      closeSync(fd);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test("readTokenFd rejects an invalid file descriptor", async () => {
  await assert.rejects(
    () => readTokenFd(9999),
    (error) => {
      assert.match(error.message, /failed to read token from file descriptor/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// resolveToken integration
// ---------------------------------------------------------------------------

test("resolveToken delegates to readTokenFile when tokenFile is set", async () => {
  const dir = makeTempDir();
  try {
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, "resolved-file-token\n", { mode: 0o600 });
    const token = await resolveToken({ tokenFile, tokenFd: null });
    assert.equal(token, "resolved-file-token");
  } finally {
    cleanupTempDir(dir);
  }
});

test("resolveToken delegates to readTokenFd when tokenFd is set", async () => {
  const dir = makeTempDir();
  try {
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, "resolved-fd-token\n");
    const fd = openSync(tokenFile, "r");
    try {
      const token = await resolveToken({ tokenFile: null, tokenFd: fd });
      assert.equal(token, "resolved-fd-token");
    } finally {
      closeSync(fd);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test("resolveToken rejects when both tokenFile and tokenFd are set", async () => {
  await assert.rejects(
    () => resolveToken({ tokenFile: "/some/path", tokenFd: 3 }),
    (error) => {
      assert.match(error.message, /not both/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// No token in errors/output
// ---------------------------------------------------------------------------

test("buildInstallHeaders creates Authorization header without exposing token", () => {
  const headers = buildInstallHeaders("my-secret-token");
  assert.equal(headers["Authorization"], "Bearer my-secret-token");
});

test("buildInstallHeaders produces empty headers when no token is given", () => {
  const headers = buildInstallHeaders(null);
  assert.deepEqual(headers, {});
});

test("requestInstall redacts token from server error response body", async () => {
  const secretToken = "ultra-secret-bearer-xyz789";
  const { server, url } = await startMockServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(`Forbidden: token ${secretToken} is not valid`);
    });
  });

  const dir = makeTempDir();
  try {
    const fakeApk = path.join(dir, "test.apk");
    writeFileSync(fakeApk, "not-a-real-apk");

    try {
      await requestInstall(url, [fakeApk], ["test.apk"], secretToken);
      assert.fail("expected requestInstall to throw");
    } catch (error) {
      assert.match(error.message, /install request failed \(403\)/);
      assert.ok(
        !error.message.includes(secretToken),
        "error message must not contain the token value",
      );
      assert.match(error.message, /\[REDACTED\]/);
    }
  } finally {
    server.close();
    cleanupTempDir(dir);
  }
});

test("readTokenFile error for insecure permissions does not contain the token", async () => {
  const dir = makeTempDir();
  try {
    const tokenFile = path.join(dir, "token");
    const secretValue = "my-super-secret-token-value";
    writeFileSync(tokenFile, `${secretValue}\n`, { mode: 0o600 });
    const { chmodSync } = await import("node:fs");
    chmodSync(tokenFile, 0o644);
    try {
      await readTokenFile(tokenFile);
      assert.fail("expected readTokenFile to throw");
    } catch (error) {
      assert.ok(
        !error.message.includes(secretValue),
        "error message must not contain the token value",
      );
    }
  } finally {
    cleanupTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Timeout behavior
// ---------------------------------------------------------------------------

test("waitForHealth times out when health checks keep failing", async () => {
  const { server, url } = await startMockServer((req, res) => {
    res.writeHead(503);
    res.end("not ready");
  });

  try {
    const start = Date.now();
    await assert.rejects(
      () => waitForHealth(url, 600, 150),
      (error) => {
        assert.match(error.message, /timed out/);
        return true;
      },
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 500, `elapsed ${elapsed}ms should be >= 500ms`);
    assert.ok(elapsed < 3000, `elapsed ${elapsed}ms should be < 3000ms`);
  } finally {
    server.close();
  }
});

test("waitForHealth succeeds when server responds with 200", async () => {
  const { server, url } = await startMockServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200);
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    await waitForHealth(url, 5000, 100);
  } finally {
    server.close();
  }
});

test("waitForHealth succeeds after transient failures", async () => {
  let attempts = 0;
  const { server, url } = await startMockServer((req, res) => {
    attempts++;
    if (req.url === "/api/health" && attempts >= 3) {
      res.writeHead(200);
      res.end("ok");
    } else {
      res.writeHead(503);
      res.end("not ready");
    }
  });

  try {
    await waitForHealth(url, 10_000, 100);
    assert.ok(attempts >= 3, `expected at least 3 attempts, got ${attempts}`);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Postcondition: summarizeInstallResult
// ---------------------------------------------------------------------------

test("summarizeInstallResult reports accepted result correctly", () => {
  const summary = summarizeInstallResult({
    accepted: true,
    restart_expected: true,
    apks: [{ name: "hook" }, { name: "server" }],
  });
  assert.equal(summary.accepted, true);
  assert.equal(summary.restartExpected, true);
  assert.equal(summary.apkCount, 2);
});

test("summarizeInstallResult reports rejected result correctly", () => {
  const summary = summarizeInstallResult({
    accepted: false,
    restart_expected: false,
    apks: [],
  });
  assert.equal(summary.accepted, false);
  assert.equal(summary.restartExpected, false);
  assert.equal(summary.apkCount, 0);
});

test("summarizeInstallResult handles null or malformed input", () => {
  const summary = summarizeInstallResult(null);
  assert.ok(!summary.accepted, "accepted should be falsy for null input");
  assert.ok(!summary.restartExpected, "restartExpected should be falsy for null input");
  assert.equal(summary.apkCount, 0);
});

test("summarizeInstallResult handles missing apks array", () => {
  const summary = summarizeInstallResult({
    accepted: true,
    restart_expected: false,
  });
  assert.equal(summary.accepted, true);
  assert.equal(summary.apkCount, 0);
});
