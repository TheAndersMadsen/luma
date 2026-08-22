import assert from "node:assert/strict";
import { spawnSync as actualSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  ROOTED_SOURCE_HELPER_SHA256,
  readStableRootedEntries,
  resolveTrustedPython3,
} = require("../../cli/rooted-source.js");

const darwinOnly = process.platform === "darwin"
  ? false
  : "requires a real Darwin kernel and macOS openat implementation";

function mockStat(kind, { mode, uid = 0n, symbolic = false } = {}) {
  return {
    dev: 1n,
    ino: kind === "file" ? 2n : 1n,
    mode: mode ?? (kind === "file" ? 0o100755n : 0o040755n),
    nlink: 1n,
    uid,
    gid: 0n,
    size: 1n,
    mtimeNs: 1n,
    ctimeNs: 1n,
    isSymbolicLink: () => symbolic,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
  };
}

test("Darwin pathname authority accepts only a canonical root-owned executable and ancestry", () => {
  const candidate = "/usr/bin/python3";
  const lstatSync = (entry) => mockStat(entry === candidate ? "file" : "directory");
  assert.equal(resolveTrustedPython3({
    candidates: [candidate],
    realpathSync: (entry) => entry,
    lstatSync,
    accessSync: () => {},
    requireRootOwned: true,
    requireCanonicalPath: true,
  }).path, candidate);

  assert.throws(
    () => resolveTrustedPython3({
      candidates: [candidate],
      realpathSync: (entry) => entry,
      lstatSync: (entry) => mockStat(entry === candidate ? "file" : "directory", {
        uid: entry === candidate ? 501n : 0n,
      }),
      accessSync: () => {},
      requireRootOwned: true,
      requireCanonicalPath: true,
    }),
    /no secure Python 3/u,
  );
  assert.throws(
    () => resolveTrustedPython3({
      candidates: [candidate],
      realpathSync: () => "/System/Library/python3",
      lstatSync: (entry) => mockStat(entry === candidate ? "file" : "directory", {
        symbolic: entry === candidate,
      }),
      accessSync: () => {},
      requireRootOwned: true,
      requireCanonicalPath: true,
    }),
    /no secure Python 3/u,
  );
  assert.throws(
    () => resolveTrustedPython3({
      candidates: [candidate],
      realpathSync: (entry) => entry,
      lstatSync: (entry) => mockStat(entry === candidate ? "file" : "directory", {
        mode: entry === "/usr" ? 0o040775n : undefined,
      }),
      accessSync: () => {},
      requireRootOwned: true,
      requireCanonicalPath: true,
    }),
    /no secure Python 3/u,
  );
});

test("the real Darwin rooted reader uses a trusted helper and refuses every link/root substitution", {
  skip: darwinOnly,
}, () => {
  // macOS commonly exposes /var as a symlink to /private/var. Start beneath
  // the canonical temp root so this test exercises its own fixtures rather
  // than deliberately tripping the root-ancestor symlink guard on /var.
  const canonicalTemp = fs.realpathSync.native(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(canonicalTemp, "revival-darwin-rooted-"));
  try {
    const source = path.join(fixture, "source");
    fs.mkdirSync(source, { mode: 0o700 });
    fs.writeFileSync(path.join(source, "plain.txt"), "inside\n", { mode: 0o600 });

    const invocations = [];
    const result = readStableRootedEntries(source, ["plain.txt"], "Darwin CI rooted reader", {
      spawnSync(command, args, options) {
        invocations.push({ command, args: [...args], options: { ...options } });
        return actualSpawnSync(command, args, options);
      },
    });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].kind, "file");
    assert.equal(result.entries[0].data.toString("utf8"), "inside\n");
    assert.equal(invocations.length, 1);

    const invocation = invocations[0];
    const trustedPython = resolveTrustedPython3();
    assert.equal(invocation.command, trustedPython.path);
    assert.ok([
      "/usr/bin/python3",
      "/Library/Developer/CommandLineTools/usr/bin/python3",
    ].includes(trustedPython.path));
    assert.equal(fs.realpathSync.native(trustedPython.path), trustedPython.path);
    assert.equal(trustedPython.receipt.uid, "0");
    for (const ancestor of trustedPython.ancestry) {
      const metadata = fs.lstatSync(ancestor.path);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.isDirectory(), true);
      assert.equal(metadata.uid, 0);
      assert.equal(metadata.mode & 0o022, 0);
    }
    assert.deepEqual(invocation.args.slice(0, 3), ["-I", "-B", "-c"]);
    assert.equal(
      createHash("sha256").update(invocation.args[3]).digest("hex"),
      ROOTED_SOURCE_HELPER_SHA256,
    );
    assert.match(invocation.args[3], /class RootedReader:/u);
    assert.doesNotMatch(invocation.args[3], /rooted-source-helper\.py/u);
    assert.deepEqual(Object.keys(invocation.options.env).sort(), [
      "LANG",
      "LC_ALL",
      "PYTHONDONTWRITEBYTECODE",
      "PYTHONNOUSERSITE",
    ]);
    assert.deepEqual(invocation.options.env, {
      LANG: "C",
      LC_ALL: "C",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
    });
    assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(invocation.options.encoding, "utf8");

    const outside = path.join(fixture, "outside.txt");
    fs.writeFileSync(outside, "outside\n", { mode: 0o600 });
    fs.symlinkSync(outside, path.join(source, "linked.txt"));
    assert.throws(
      () => readStableRootedEntries(source, ["linked.txt"], "Darwin symlink fixture"),
      /symbolic links are forbidden/u,
    );

    fs.linkSync(outside, path.join(source, "hard-linked.txt"));
    assert.throws(
      () => readStableRootedEntries(source, ["hard-linked.txt"], "Darwin hardlink fixture"),
      /hard-linked files are forbidden/u,
    );

    const realAncestor = path.join(fixture, "real-ancestor");
    const realAncestorSource = path.join(realAncestor, "nested", "source");
    fs.mkdirSync(realAncestorSource, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(realAncestorSource, "file.txt"), "real\n", { mode: 0o600 });
    const linkedAncestor = path.join(fixture, "linked-ancestor");
    fs.symlinkSync(realAncestor, linkedAncestor);
    assert.throws(
      () => readStableRootedEntries(
        path.join(linkedAncestor, "nested", "source"),
        ["file.txt"],
        "Darwin linked root ancestor fixture",
      ),
      /source root ancestors must not be symbolic links/u,
    );

    const replaceableAncestor = path.join(fixture, "replaceable-ancestor");
    const originalRoot = path.join(replaceableAncestor, "nested", "source");
    fs.mkdirSync(originalRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(originalRoot, "file.txt"), "original\n", { mode: 0o600 });
    const original = readStableRootedEntries(
      originalRoot,
      ["file.txt"],
      "Darwin original root fixture",
    );
    fs.renameSync(replaceableAncestor, `${replaceableAncestor}.displaced`);
    fs.mkdirSync(originalRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(originalRoot, "file.txt"), "replacement\n", { mode: 0o600 });
    assert.throws(
      () => readStableRootedEntries(
        originalRoot,
        ["file.txt"],
        "Darwin substituted root ancestor fixture",
        { expectedRoot: original.rootReceipt },
      ),
      /root changed|source root changed/u,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
