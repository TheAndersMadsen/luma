import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = new URL("../../../", import.meta.url);

test("Center's committed setup projection matches the root contract", async () => {
  const result = spawnSync(process.execPath, ["platform/setup/generate.mjs", "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const [model, generated] = await Promise.all([
    readFile(
      new URL("../../../center/src/lib/pin-setup/steps.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../../center/src/lib/pin-setup/generated/journey.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(model, /from "\.\/generated\/journey"/);
  assert.doesNotMatch(
    model,
    /(?:from|import\()\s*["'][^"']*contracts\/operator-setup\.json/,
  );
  assert.match(generated, /\.\/revival pin release import/);
  assert.doesNotMatch(generated, /pin release (?:build|ship)/);
  assert.match(generated, /"centerRoute": "\/wifi"/);
});
