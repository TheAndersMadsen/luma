import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import registry from "../../cli/registry.js";

const root = path.resolve(import.meta.dirname, "../../..");

test("registry login uses Docker's hidden prompt and the managed deploy config", () => {
  const calls = [];
  const managedConfig = "/managed/luma/docker";
  registry.registryCommand(["login", "--username", "octocat"], {
    operatorEnvironment() {
      return { DOCKER_CONFIG: managedConfig };
    },
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    // A source checkout is a maintainer's machine: it keeps no update token.
    isOperatorRelease: () => false,
    saveGithubToken() {
      assert.fail("a source checkout saved an update token");
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

test("registry login on a server keeps the same token for updates, without another prompt", () => {
  const saved = [];
  const read = [];
  registry.registryCommand(["login", "--username", "octocat"], {
    operatorEnvironment: () => ({}),
    run: () => ({ status: 0 }),
    isOperatorRelease: () => true,
    credential(registryName) {
      read.push(registryName);
      return "octocat:ghp_fixtureRegistryToken0123456789";
    },
    saveGithubToken: (token) => saved.push(token),
  });
  assert.deepEqual(read, ["ghcr.io"]);
  assert.deepEqual(saved, ["ghp_fixtureRegistryToken0123456789"]);

  // Docker keeps no readable credential: nothing is saved, and login still succeeds.
  const none = [];
  registry.registryCommand(["login", "--username", "octocat"], {
    operatorEnvironment: () => ({}),
    run: () => ({ status: 0 }),
    isOperatorRelease: () => true,
    credential: () => null,
    saveGithubToken: (token) => none.push(token),
  });
  assert.deepEqual(none, []);
});
