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
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "luma-pin-debug-"));
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
  assert.deepEqual(
    debug.rolesForChangedPath("pin/device-installer/bootstrap/src/main/AndroidManifest.xml"),
    ["bootstrap"],
  );
  assert.deepEqual(debug.rolesForChangedPath("pin/contracts/a.proto"), ["hook", "server"]);
  assert.deepEqual(debug.rolesForChangedPath("unknown/path"), debug.DEBUG_ROLES);
  assert.deepEqual(debug.selectChangedRoles([
    "pin/hook/module/src/X.kt",
    "pin/runtime/core/src/lib.rs",
  ]), ["hook", "server"]);
});

test("bootstrap builds use the renamed helper module", () => {
  const entrypoint = fs.readFileSync(
    path.join(root, "platform", "containers", "pin-builder", "entrypoint.sh"),
    "utf8",
  );
  assert.match(entrypoint, /:bootstrap:assembleRelease/u);
  assert.match(entrypoint, /device-installer\/bootstrap\/build\/outputs\/apk/u);
  assert.doesNotMatch(entrypoint, /:exploit:/u);
  assert.doesNotMatch(entrypoint, /device-installer\/exploit\//u);
});

test("APKs reach the host-mounted outputs owner-only without a chmod Docker Desktop refuses", () => {
  const entrypoint = fs.readFileSync(
    path.join(root, "platform", "containers", "pin-builder", "entrypoint.sh"),
    "utf8",
  );
  const code = entrypoint.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /\binstall -m\b/u);
  assert.match(code, /copy_private\(\) \{\n  \(umask 077 && cp -- "\$1" "\$2"\)\n\}/u);
  assert.match(code, /copy_private "\$\{apk\}" "\$\{RELEASE_ROOT\}\/\$\{role\}\.apk"/u);
  assert.match(code, /copy_private "\$\{matches\[0\]\}" "\$\{DEBUG_ARTIFACT_ROOT\}\/\$\{role\}\.apk"/u);
});

test("debug syntax keeps explicit and changed selection separate", () => {
  assert.deepEqual(debug.parseDebugBuildSyntax([
    "--role", "server", "--role", "hook",
  ]), { requested: ["server", "hook"], changed: false, base: undefined });
  assert.deepEqual(debug.resolveDebugBuildSelection(
    debug.parseDebugBuildSyntax(["--changed", "--base", "main"]),
    () => ["pin/hook/module/src/X.kt"],
  ).roles, ["hook"]);
  assert.throws(() => debug.parseDebugBuildSyntax([]), /at least one --role/u);
  assert.throws(
    () => debug.parseDebugBuildSyntax(["--changed", "--role", "hook"]),
    /cannot be combined/u,
  );
});

test("debug Docker invocation mounts source read-only and keeps state and caches external", () => {
  const directories = temporaryDirectories();
  const invocation = debug.pinBuilderRunInvocation(
    ["hook", "server"], directories, "fixture:image", "arm64",
  );
  assert.equal(invocation.command, "docker");
  assert.deepEqual(invocation.args.slice(0, 5), [
    "run", "--rm", "--init", "--platform", "linux/arm64",
  ]);
  assert.ok(invocation.args.includes("--read-only"));
  assert.ok(invocation.args.includes(`type=bind,src=${root},dst=/workspace,readonly`));
  assert.ok(invocation.args.includes(`type=bind,src=${directories.state},dst=/state`));
  assert.ok(invocation.args.includes(`type=bind,src=${directories.cache},dst=/cache`));
  assert.deepEqual(invocation.args.slice(-5), [
    "build-debug-role", "--role", "hook", "--role", "server",
  ]);
});

test("the Pin check's builder run mounts the checkout and stock reference read-only in its own state", () => {
  const directories = temporaryDirectories();
  const reference = path.join(os.tmpdir(), "luma-stock-reference-fixture");
  const invocation = debug.pinBuilderCheckInvocation(directories, reference, "fixture:image", "arm64");
  assert.equal(invocation.command, "docker");
  assert.deepEqual(invocation.args.slice(0, 5), ["run", "--rm", "--init", "--platform", "linux/arm64"]);
  assert.ok(invocation.args.includes("--read-only"));
  assert.ok(invocation.args.includes(`type=bind,src=${root},dst=/workspace,readonly`));
  assert.ok(invocation.args.includes(`type=bind,src=${directories.state},dst=/state`));
  assert.ok(invocation.args.includes(`type=bind,src=${directories.cache},dst=/cache`));
  assert.ok(invocation.args.includes(`type=bind,src=${reference},dst=/luma-data/stock-reference,readonly`));
  assert.deepEqual(invocation.args.slice(-2), ["fixture:image", "check-unit"]);
  assert.equal(debug.pinBuilderCheckInvocation(directories, null, "fixture:image", "arm64").args
    .some((value) => value.includes("/luma-data")), false);
  // The check never shares a worktree with a debug build. The caches are shared.
  assert.notEqual(debug.checkDirectories().state, debug.debugDirectories().state);
  assert.equal(debug.checkDirectories().cache, debug.debugDirectories().cache);
  assert.equal(debug.checkDirectories().imageStamp, debug.debugDirectories().imageStamp);
});

test("debug builder uses the native Docker platform", () => {
  assert.deepEqual(
    debug.pinBuilderBuildInvocation("fixture:image", "x64").args.slice(0, 3),
    ["build", "--platform", "linux/amd64"],
  );
  assert.equal(debug.nativeDockerPlatform("arm64"), "linux/arm64");
  assert.throws(() => debug.nativeDockerPlatform("riscv64"), /do not support/u);
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

test("debug command resolves changes, checks its image, then runs Docker once", () => {
  const events = [];
  const directories = temporaryDirectories();
  debug.pinDebugBuild(["--changed"], {
    directories,
    environment: {},
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
  assert.deepEqual(events.slice(0, 2), ["changed-paths", "image"]);
  assert.equal(events[2].label, "Build Pin debug APKs");
  assert.deepEqual(events[2].args.slice(-3), ["build-debug-role", "--role", "server"]);
});
