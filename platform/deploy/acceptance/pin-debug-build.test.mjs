import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const debug = require("../../cli/pin-debug.js");

function temporaryDirectories() {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "revival-pin-debug-"));
  return {
    state: path.join(rootDirectory, "state"),
    cache: path.join(rootDirectory, "cache"),
    artifacts: path.join(rootDirectory, "state", "artifacts", "device-debug"),
    imageStamp: path.join(rootDirectory, "cache", "image.sha256"),
  };
}

test("debug role selection builds only affected APK graphs", () => {
  assert.deepEqual(debug.DEBUG_ROLES, [
    "installer", "bootstrap", "hook", "server", "hook-injector",
  ]);
  assert.deepEqual(debug.rolesForChangedPath("pin/runtime/core/src/lib.rs"), ["server"]);
  assert.deepEqual(debug.rolesForChangedPath("pin/contracts/a.proto"), ["hook", "server"]);
  assert.deepEqual(debug.rolesForChangedPath("unknown/path"), debug.DEBUG_ROLES);
  assert.deepEqual(debug.selectChangedRoles([
    "pin/hook/payload/src/X.kt",
    "pin/runtime/core/src/lib.rs",
  ]), ["hook", "server"]);
});

test("debug syntax keeps explicit and changed selection separate", () => {
  assert.deepEqual(debug.parseDebugBuildSyntax([
    "--role", "server", "--role", "hook",
  ]), { requested: ["server", "hook"], changed: false, base: undefined });
  assert.deepEqual(debug.resolveDebugBuildSelection(
    debug.parseDebugBuildSyntax(["--changed", "--base", "main"]),
    () => ["pin/hook/payload/src/X.kt"],
  ).roles, ["hook"]);
  assert.throws(() => debug.parseDebugBuildSyntax([]), /at least one --role/u);
  assert.throws(
    () => debug.parseDebugBuildSyntax(["--changed", "--role", "hook"]),
    /cannot be combined/u,
  );
});

test("debug Docker invocation mounts source read-only and keeps state and caches external", () => {
  const directories = temporaryDirectories();
  const invocation = debug.pinBuilderRunInvocation(["hook", "server"], directories, "fixture:image");
  assert.equal(invocation.command, "docker");
  assert.ok(invocation.args.includes("--read-only"));
  assert.ok(invocation.args.includes(`type=bind,src=${root},dst=/workspace,readonly`));
  assert.ok(invocation.args.includes(`type=bind,src=${directories.state},dst=/state`));
  assert.ok(invocation.args.includes(`type=bind,src=${directories.cache},dst=/cache`));
  assert.deepEqual(invocation.args.slice(-5), [
    "build-debug-role", "--role", "hook", "--role", "server",
  ]);
});

test("builder image is rebuilt only when its small input fingerprint changes", () => {
  const directories = temporaryDirectories();
  const calls = [];
  const runner = (label, command, args) => {
    calls.push({ label, command, args });
    return { status: 0, signal: null, stdout: "", stderr: "" };
  };
  assert.equal(debug.ensurePinBuilderImage({
    directories,
    environment: {},
    runner,
    image: "fixture:image",
  }), true);
  assert.equal(calls[0].args[0], "build");
  calls.length = 0;
  assert.equal(debug.ensurePinBuilderImage({
    directories,
    environment: {},
    runner,
    image: "fixture:image",
  }), false);
  assert.deepEqual(calls[0].args, ["image", "inspect", "fixture:image"]);
});

test("debug command performs preflight, image check, then one Docker run", () => {
  const events = [];
  const directories = temporaryDirectories();
  debug.pinDebugBuild(["--changed"], {
    directories,
    environment: {},
    preflight() { events.push("preflight"); },
    pathResolver() {
      events.push("changed-paths");
      return ["pin/runtime/core/src/lib.rs"];
    },
    ensureImage() { events.push("image"); },
    runner(label, command, args) {
      events.push({ label, command, args });
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(events.slice(0, 3), ["preflight", "changed-paths", "image"]);
  assert.equal(events[3].label, "Build Pin debug APKs");
  assert.deepEqual(events[3].args.slice(-3), ["build-debug-role", "--role", "server"]);
});
