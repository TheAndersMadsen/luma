import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import registry from "../../cli/registry.js";

const root = path.resolve(import.meta.dirname, "../../..");

test("registry login uses Docker's hidden prompt and the managed deploy config", () => {
  const calls = [];
  const managedConfig = "/managed/ai-pin-revival/docker";
  registry.registryCommand(["login", "--username", "octocat"], {
    operatorEnvironment() {
      return { DOCKER_CONFIG: managedConfig };
    },
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [{
    command: "docker",
    args: ["login", "ghcr.io", "--username", "octocat"],
    options: { env: { DOCKER_CONFIG: managedConfig } },
  }]);
  assert.doesNotMatch(calls[0].args.join(" "), /token|password/u);

  const production = fs.readFileSync(path.join(root, "platform/cli/production.js"), "utf8");
  assert.match(production, /operatorEnvironment\(values\)/u);
  assert.doesNotMatch(production, /DOCKER_CONFIG\s*:/u);
});

test("registry login accepts no credential-bearing argument", () => {
  assert.deepEqual(registry.parseRegistryLogin(["--username", "TheAndersMadsen"]), {
    username: "TheAndersMadsen",
  });
  for (const args of [
    ["--username", "owner", "--token", "secret"],
    ["--password", "secret"],
    ["--username", "bad user"],
  ]) {
    assert.throws(() => registry.parseRegistryLogin(args), /usage/u);
  }
});
