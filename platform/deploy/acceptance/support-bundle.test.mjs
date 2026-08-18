import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "revival");

test("support bundle is an external mode-0600 fixed redacted allowlist", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-support-"));
  try {
    const output = path.join(temporary, "support.json");
    const sentinel = "wearer-secret-sentinel";
    const result = spawnSync(process.execPath, [cli, "support-bundle", "--output", output, "--json"], {
      cwd: root,
      env: {
        ...process.env,
        REVIVAL_BACKUP_DIR: path.join(temporary, "backups"),
        REVIVAL_SECRET_SENTINEL: sentinel,
        REVIVAL_ENV_FILE: path.join(temporary, "runtime.env"),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const contents = fs.readFileSync(output, "utf8");
    assert.doesNotMatch(contents, new RegExp(sentinel));
    const bundle = JSON.parse(contents);
    assert.deepEqual(Object.keys(bundle), [
      "schemaVersion", "generatedAt", "product", "cli", "host", "capabilities", "contracts", "privacy",
    ]);
    assert.deepEqual(bundle.privacy, {
      environmentIncluded: false,
      runtimeConfigurationIncluded: false,
      logsIncluded: false,
      serialsIncluded: false,
      wearerDataIncluded: false,
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("support bundle refuses output inside the source tree", () => {
  const output = path.join(root, ".forbidden-support.json");
  const result = spawnSync(process.execPath, [cli, "support-bundle", "--output", output], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the source tree/);
  assert.equal(fs.existsSync(output), false);
});
