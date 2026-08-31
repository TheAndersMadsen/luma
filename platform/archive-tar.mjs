import { accessSync, constants } from "node:fs";
import { lstat, readdir, utimes } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, isAbsolute, join } from "node:path";

const TAR_CANDIDATES = Object.freeze(
  process.platform === "darwin"
    ? ["/opt/homebrew/bin/gtar", "/usr/local/bin/gtar", "/usr/bin/tar", "/bin/tar"]
    : ["/usr/bin/tar", "/bin/tar"],
);

function resolveTar() {
  for (const command of TAR_CANDIDATES) {
    try {
      accessSync(command, constants.X_OK);
    } catch {
      continue;
    }
    const version = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (version.error || version.status !== 0) continue;
    const output = `${version.stdout}\n${version.stderr}`;
    if (/GNU tar/u.test(output)) return Object.freeze({ command, flavor: "gnu" });
    if (/bsdtar/u.test(output)) return Object.freeze({ command, flavor: "bsd" });
  }
  throw new Error("a supported GNU tar or bsdtar executable is required");
}

async function normalizeTree(parent, directory) {
  const entries = [];
  const epoch = new Date(0);

  async function visit(relative) {
    const absolute = join(parent, relative);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`release archive input must be a real file or directory: ${absolute}`);
    }
    entries.push(relative);
    if (metadata.isDirectory()) {
      const children = (await readdir(absolute)).sort();
      for (const child of children) await visit(join(relative, child));
    }
    await utimes(absolute, epoch, epoch);
  }

  await visit(directory);
  return entries;
}

export async function createReproducibleTar({ parent, directory, archive }) {
  if (![parent, archive].every((value) => typeof value === "string" && isAbsolute(value)) ||
      typeof directory !== "string" || !directory || directory !== basename(directory) ||
      directory === "." || directory === ".." || directory.includes("\0")) {
    throw new Error("invalid release archive path");
  }
  const entries = await normalizeTree(parent, directory);
  const tar = resolveTar();
  const ownership = tar.flavor === "gnu"
    ? [
      "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
      "--format=posix", "--pax-option=delete=atime,delete=ctime",
    ]
    : [
      "--uid", "0", "--gid", "0", "--numeric-owner", "--format=ustar",
      "--options", "gzip:!timestamp", "--no-acls", "--no-fflags", "--no-xattrs",
    ];
  const result = spawnSync(tar.command, [
    "--create", "--gzip", "--file", archive,
    ...ownership,
    "--no-recursion", "--directory", parent,
    ...entries,
  ], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || "tar failed");
  }
}
