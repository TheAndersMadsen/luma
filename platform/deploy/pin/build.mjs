#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  parseCanonicalPinReleaseManifestDocument,
  parsePinReleaseJson,
  parsePinReleaseHistory,
  parsePinReleaseReceiptBundle,
  verifyPinReleaseMetadata,
} from "./release.mjs";
import {
  canonicalJson as canonicalHostedJson,
  loadPolicy as loadHostedPolicy,
  parseAuthorityEvidenceBytes,
  parsePostPredicate,
  readRequest as readHostedRequest,
} from "./hosted-attestation.mjs";
import {
  OWN_CHILD_PROCESS_GROUP,
  terminateTrackedProcess,
  trackChildProcess,
  withTrackedDeadline,
} from "./bounded-process.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
export const SOURCE_ROOT = resolve(dirname(SELF_PATH), "../../..");
export const PIN_COMPATIBILITY_CERT_SHA256 =
  "d8a64e1c3a1afdc340c4b86feaacb88e2d81d66972afbd58e743b7c5b8d1cbdb";

const SIGNING_NAMES = Object.freeze([
  "PIN_SIGNING_STORE_FILE",
  "PIN_SIGNING_STORE_PASSWORD",
  "PIN_SIGNING_KEY_ALIAS",
  "PIN_SIGNING_KEY_PASSWORD",
]);
const VERSION_RE = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const MAX_VERSION_CODE = 2_147_483_647;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_CURRENT_BYTES = 1024 * 1024;
const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_AUTHORITY_BYTES = 64 * 1024 * 1024;
const BROKER_READY_TIMEOUT_MILLISECONDS = 30_000;
const BROKER_CLOSE_TIMEOUT_MILLISECONDS = 10_000;
const CAPTURED_COMMAND_TIMEOUT_MILLISECONDS = 15 * 60_000;
const DOCKER_COMMAND_TIMEOUT_MILLISECONDS = 90 * 60_000;
const HOSTED_VERIFIER_RUNTIME_POLICY_PATH = join(
  SOURCE_ROOT,
  "platform/deploy/pin/hosted-verifier-runtime-policy.json",
);
const FIXED_VERIFIER_RUNTIME_IMAGE_REFERENCE =
  "docker.io/library/node@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b";
const FIXED_VERIFIER_RUNTIME_IMAGE_ID =
  "sha256:854cb78ac3ed2e215515e3ed78bf40a955bde16fc74114051a1850e509f602e6";
const FIXED_VERIFIER_RUNTIME_NODE = "/usr/local/bin/node";
const FIXED_DOCKER = "/usr/bin/docker";
const FIXED_PYTHON = "/usr/bin/python3";
const FIXED_DOCKER_ENVIRONMENT = Object.freeze({
  HOME: "/nonexistent",
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  DOCKER_HOST: "unix:///var/run/docker.sock",
  DOCKER_CONFIG: "/nonexistent",
});
const FIXED_VERIFIER_TARGETS = Object.freeze({
  verifier: "/usr/local/libexec/ai-pin-hosted-attestation/hosted-attestation.mjs",
  policy: "/usr/local/libexec/ai-pin-hosted-attestation/hosted-attestation-policy.json",
  trustedRoot: "/usr/local/libexec/ai-pin-hosted-attestation/github-private-trusted-root.jsonl",
  boundedProcess: "/usr/local/libexec/ai-pin-hosted-attestation/bounded-process.mjs",
  githubCli: "/usr/bin/gh",
});
const HOSTED_PUBLICATION_CAPABILITIES = new WeakSet();
const HOSTED_RUN_FILES = Object.freeze({
  request: "request.json",
  preSignBundle: "pre-sign.sigstore.json",
  preSignVerification: "pre-sign-verification.json",
  releasePredicate: "release-predicate.json",
  releaseChecksums: "release-checksums.txt",
  releaseBundle: "release.sigstore.json",
  authorityEvidence: "hosted-attestation.json",
  imageId: "builder-image-id",
  verifierArchive: "gh-2.98.0-linux-amd64.tar.gz",
});
const HOSTED_AUTHORITY_EVIDENCE_FIELDS = Object.freeze([
  "provider",
  "policySha256",
  "requestSha256",
  "predicateSha256",
  "trustedRootSha256",
  "preSignBundleSha256",
  "releaseBundleSha256",
  "preSignVerificationSha256",
  "releaseVerificationSha256",
  "runnerEnvironment",
  "runnerLabel",
  "runnerArchitecture",
  "runnerInvocationUri",
  "repository",
  "sourceRef",
  "sourceDigest",
  "sourceGenerationSha256",
  "sourceTarSha256",
  "toolchainSha256",
  "builderImageId",
]);
const FIXED_GITHUB_CLI_DOWNLOAD = String.raw`
import hashlib, os, stat, sys, urllib.parse, urllib.request

url, destination, expected, maximum_text = sys.argv[1:]
maximum = int(maximum_text)
allowed = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}

class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        redirected = urllib.parse.urlparse(newurl)
        if redirected.scheme != "https" or redirected.hostname not in allowed:
            raise RuntimeError("GitHub CLI download escaped its fixed HTTPS origins")
        return super().redirect_request(request, fp, code, message, headers, newurl)

selected = urllib.parse.urlparse(url)
if selected.scheme != "https" or selected.hostname != "github.com":
    raise RuntimeError("GitHub CLI archive URL is not the fixed GitHub HTTPS origin")
parent = os.path.dirname(destination)
if not os.path.isabs(destination) or os.path.realpath(parent) != parent:
    raise RuntimeError("GitHub CLI archive destination is not canonical")
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
descriptor = os.open(destination, flags, 0o600)
digest = hashlib.sha256()
size = 0
complete = False
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirects())
    request = urllib.request.Request(url, headers={"User-Agent": "Ai-Pin-Revival-hosted-verifier/1"})
    with opener.open(request, timeout=60) as response:
        final = urllib.parse.urlparse(response.geturl())
        if final.scheme != "https" or final.hostname not in allowed:
            raise RuntimeError("GitHub CLI download ended outside its fixed HTTPS origins")
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > maximum:
                raise RuntimeError("GitHub CLI archive exceeded its fixed size bound")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                count = os.write(descriptor, view)
                if count <= 0:
                    raise RuntimeError("GitHub CLI archive write made no progress")
                view = view[count:]
    if size == 0 or digest.hexdigest() != expected:
        raise RuntimeError("GitHub CLI archive differs from its policy SHA-256")
    os.fsync(descriptor)
    os.fchmod(descriptor, 0o600)
    complete = True
finally:
    os.close(descriptor)
    if not complete:
        try:
            os.unlink(destination)
        except FileNotFoundError:
            pass
`;
const FIXED_VERIFIER_ASSET_BROKER = String.raw`
import fcntl, hashlib, json, os, posixpath, stat, sys, tarfile, zlib

required_seals = (
    getattr(fcntl, "F_SEAL_SEAL", 0x0001) |
    getattr(fcntl, "F_SEAL_SHRINK", 0x0002) |
    getattr(fcntl, "F_SEAL_GROW", 0x0004) |
    getattr(fcntl, "F_SEAL_WRITE", 0x0008)
)

def refuse(message):
    raise RuntimeError(message)

def exact(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields):
        refuse(label + " has an unexpected shape")

def identity(value):
    return tuple(getattr(value, field) for field in (
        "st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid",
        "st_size", "st_mtime_ns", "st_ctime_ns",
    ))

def open_held(path, maximum, expected_sha, label):
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.realpath(path) != path:
        refuse(label + " path is not canonical")
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or before.st_nlink != 1:
        refuse(label + " is not one regular file")
    if before.st_size <= 0 or before.st_size > maximum:
        refuse(label + " is outside its fixed size bound")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    opened = os.fstat(descriptor)
    if identity(opened) != identity(before):
        os.close(descriptor)
        refuse(label + " moved before open")
    digest = hashlib.sha256()
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    if digest.hexdigest() != expected_sha:
        os.close(descriptor)
        refuse(label + " differs from its fixed SHA-256")
    rebound = os.lstat(path)
    if identity(rebound) != identity(before) or identity(os.fstat(descriptor)) != identity(opened):
        os.close(descriptor)
        refuse(label + " changed while captured")
    os.lseek(descriptor, 0, os.SEEK_SET)
    return descriptor

def new_memfd(name, mode):
    if not hasattr(os, "memfd_create"):
        refuse("hosted verification requires Linux memfd_create")
    descriptor = os.memfd_create(
        "revival-pin-attestation-" + name,
        getattr(os, "MFD_CLOEXEC", 0x0001) | getattr(os, "MFD_ALLOW_SEALING", 0x0002),
    )
    os.fchmod(descriptor, mode)
    return descriptor

def write_all(descriptor, chunk):
    view = memoryview(chunk)
    while view:
        count = os.write(descriptor, view)
        if count <= 0:
            refuse("sealed verifier asset write made no progress")
        view = view[count:]

def finish_memfd(descriptor, expected_sha, expected_size, label):
    if os.lseek(descriptor, 0, os.SEEK_CUR) != expected_size:
        refuse(label + " size changed while sealed")
    os.fsync(descriptor)
    fcntl.fcntl(descriptor, getattr(fcntl, "F_ADD_SEALS", 1033), required_seals)
    observed = fcntl.fcntl(descriptor, getattr(fcntl, "F_GET_SEALS", 1034))
    if observed & required_seals != required_seals:
        refuse(label + " did not retain every write seal")
    os.lseek(descriptor, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    if digest.hexdigest() != expected_sha:
        refuse(label + " changed while sealed")
    os.lseek(descriptor, 0, os.SEEK_SET)

spec = json.loads(sys.argv[1])
exact(spec, ("archive", "files", "githubCli"), "asset broker request")
if not isinstance(spec["files"], list) or len(spec["files"]) != 4:
    refuse("asset broker requires exactly four fixed source files")
held = []
paths = {}
for item in spec["files"]:
    exact(item, ("maximumSize", "mode", "name", "path", "sha256"), "fixed verifier file")
    if item["name"] not in ("verifier", "policy", "trustedRoot", "boundedProcess") or item["name"] in paths:
        refuse("fixed verifier file name is not recognized")
    source = open_held(item["path"], item["maximumSize"], item["sha256"], item["name"])
    target = new_memfd(item["name"], item["mode"])
    size = 0
    try:
        while True:
            chunk = os.read(source, 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            write_all(target, chunk)
    finally:
        os.close(source)
    finish_memfd(target, item["sha256"], size, item["name"])
    held.append(target)
    paths[item["name"]] = "/proc/%d/fd/%d" % (os.getpid(), target)

archive_spec = spec["archive"]
cli = spec["githubCli"]
exact(archive_spec, ("maximumSize", "path", "sha256"), "GitHub CLI archive")
exact(cli, ("member", "memberCount", "memberMode", "mode", "sha256", "size"), "GitHub CLI binary")
archive = open_held(
    archive_spec["path"], archive_spec["maximumSize"], archive_spec["sha256"], "GitHub CLI archive",
)
target = new_memfd("github-cli", cli["mode"])
tar_payload = new_memfd("github-cli-tar", 0o400)
try:
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    decompressed_size = 0
    while True:
        chunk = os.read(archive, 1024 * 1024)
        if not chunk:
            break
        if decoder.eof:
            refuse("GitHub CLI archive has trailing compressed data")
        decoded = decoder.decompress(chunk)
        if decoder.unused_data or decoder.unconsumed_tail:
            refuse("GitHub CLI archive has concatenated or trailing data")
        decompressed_size += len(decoded)
        if decompressed_size > 256 * 1024 * 1024:
            refuse("GitHub CLI archive expands beyond its fixed bound")
        write_all(tar_payload, decoded)
    decoded = decoder.flush()
    decompressed_size += len(decoded)
    if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or decompressed_size > 256 * 1024 * 1024:
        refuse("GitHub CLI archive gzip stream is incomplete or ambiguous")
    write_all(tar_payload, decoded)
    os.fsync(tar_payload)
    fcntl.fcntl(tar_payload, getattr(fcntl, "F_ADD_SEALS", 1033), required_seals)
    if fcntl.fcntl(tar_payload, getattr(fcntl, "F_GET_SEALS", 1034)) & required_seals != required_seals:
        refuse("GitHub CLI tar payload did not retain every write seal")
    os.lseek(tar_payload, 0, os.SEEK_SET)
    with os.fdopen(os.dup(tar_payload), "rb") as stream:
        with tarfile.open(fileobj=stream, mode="r:") as package:
            members = package.getmembers()
            if len(members) != cli["memberCount"]:
                refuse("GitHub CLI archive member count changed")
            names = set()
            selected = []
            for candidate in members:
                name = candidate.name
                if (
                    not isinstance(name, str) or not name or name.startswith("/") or "\\" in name or
                    posixpath.normpath(name) != name or name == "." or
                    any(component in ("", ".", "..") for component in name.split("/")) or
                    name in names or not candidate.isfile()
                ):
                    refuse("GitHub CLI archive contains an unsafe or duplicate member")
                names.add(name)
                if name == cli["member"]:
                    selected.append(candidate)
            if len(selected) != 1:
                refuse("GitHub CLI archive does not contain exactly one fixed binary member")
            member = selected[0]
            if member.size != cli["size"] or member.mode != cli["memberMode"]:
                refuse("GitHub CLI archive member identity changed")
            logical_end = package.offset
            os.lseek(tar_payload, logical_end, os.SEEK_SET)
            tail = b""
            while True:
                chunk = os.read(tar_payload, 1024 * 1024)
                if not chunk:
                    break
                tail += chunk
                if len(tail) > 1024 * 1024:
                    refuse("GitHub CLI tar termination exceeded its fixed bound")
            if len(tail) < 1024 or any(tail):
                refuse("GitHub CLI tar has missing or nonzero trailing records")
            extracted = package.extractfile(member)
            if extracted is None:
                refuse("GitHub CLI archive member is unavailable")
            digest = hashlib.sha256()
            size = 0
            header = b""
            with extracted:
                while True:
                    chunk = extracted.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > cli["size"]:
                        refuse("GitHub CLI binary exceeded its fixed size")
                    digest.update(chunk)
                    if len(header) < 20:
                        header += chunk[:20 - len(header)]
                    write_all(target, chunk)
            if size != cli["size"] or digest.hexdigest() != cli["sha256"]:
                refuse("GitHub CLI binary differs from its fixed identity")
            if (
                len(header) < 20 or header[:4] != b"\x7fELF" or header[4] != 2 or
                header[5] != 1 or header[6] != 1 or int.from_bytes(header[18:20], "little") != 62
            ):
                refuse("GitHub CLI binary is not the fixed ELF64 little-endian x86-64 executable")
finally:
    os.close(archive)
    os.close(tar_payload)
finish_memfd(target, cli["sha256"], cli["size"], "GitHub CLI binary")
held.append(target)
paths["githubCli"] = "/proc/%d/fd/%d" % (os.getpid(), target)

if set(paths) != {"verifier", "policy", "trustedRoot", "boundedProcess", "githubCli"}:
    refuse("sealed verifier asset set is incomplete")
print(json.dumps(paths, sort_keys=True, separators=(",", ":")), flush=True)
sys.stdin.buffer.read()
for descriptor in held:
    os.close(descriptor)
`;
const LOCK_HELPER = String.raw`
import errno, fcntl, os, stat, sys
path = sys.argv[1]
flags = os.O_RDWR | os.O_CREAT
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open(path, flags, 0o600)
metadata = os.fstat(fd)
if not stat.S_ISREG(metadata.st_mode):
    print("INVALID", flush=True)
    sys.exit(74)
os.fchmod(fd, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError as error:
    if error.errno in (errno.EACCES, errno.EAGAIN):
        print("BUSY", flush=True)
        sys.exit(73)
    raise
print("READY", flush=True)
sys.stdin.buffer.read()
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
`;
const PRIVATE_ASSETS = Object.freeze([
  Object.freeze({
    path: "codex-0.144.3/codex-app-server-aarch64-unknown-linux-musl",
    sha256: "3f364d7813feb8807ac0b38fb8e02654774da1f3dd93c399a695b9e24714afc1",
  }),
  Object.freeze({
    path: "tflite-2.11.0/libtensorflowlite_jni.so",
    sha256: "8e2acc968c1a2c6b92a641fe016a2f75de0bfde87548cba9972bcc36905f57ea",
  }),
]);

export class PinReleaseBuildError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PinReleaseBuildError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PinReleaseBuildError(code, message);
}

function pathIsWithin(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

async function canonicalCandidate(candidate) {
  let existing = resolve(candidate);
  const suffix = [];
  while (true) {
    try {
      const canonical = await realpath(existing);
      return join(canonical, ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
}

async function requireOutsideSource(candidate, label, sourceRoot = SOURCE_ROOT) {
  const [selected, source] = await Promise.all([
    canonicalCandidate(candidate),
    realpath(sourceRoot),
  ]);
  if (pathIsWithin(source, selected)) {
    fail("source-boundary", `${label} must live outside the source tree`);
  }
}

async function requireProtectedFile(candidate, label, sourceRoot = SOURCE_ROOT) {
  const selected = resolve(candidate);
  await requireOutsideSource(selected, label, sourceRoot);
  let metadata;
  try {
    metadata = await lstat(selected);
  } catch (error) {
    if (error?.code === "ENOENT") fail("input-missing", `${label} is missing`);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
    fail("input-invalid", `${label} must be a nonempty regular file, not a link`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    fail("input-permissions", `${label} must have mode 0600`);
  }
  return selected;
}

async function requireOwnerDirectory(candidate, label, { create = false, sourceRoot = SOURCE_ROOT } = {}) {
  const selected = resolve(candidate);
  await requireOutsideSource(selected, label, sourceRoot);
  if (create) await mkdir(selected, { recursive: true, mode: 0o700 });
  let metadata;
  try {
    metadata = await lstat(selected);
  } catch (error) {
    if (error?.code === "ENOENT") fail("input-missing", `${label} is missing`);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("input-invalid", `${label} must be a real directory`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    fail("input-permissions", `${label} must not be accessible by group or other users`);
  }
  return selected;
}

async function sha256File(filename) {
  return new Promise((resolvePromise, rejectPromise) => {
    const digest = createHash("sha256");
    const input = createReadStream(filename);
    input.on("error", rejectPromise);
    input.on("data", (chunk) => digest.update(chunk));
    input.on("end", () => resolvePromise(digest.digest("hex")));
  });
}

function exactRecordFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("verifier-policy", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("verifier-policy", `${label} contains missing or unexpected fields`);
  }
}

async function readStableFixedFile(pathValue, label, maximum) {
  const selected = resolve(pathValue);
  const before = await lstat(selected, { bigint: true }).catch((error) => {
    if (error?.code === "ENOENT") fail("verifier-policy", `${label} is missing`);
    throw error;
  });
  if (
    before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n || before.size <= 0n ||
    before.size > BigInt(maximum) || (await realpath(selected)) !== selected
  ) fail("verifier-policy", `${label} is not one bounded canonical regular file`);
  const bytes = await readFile(selected);
  const after = await lstat(selected, { bigint: true });
  for (const field of ["dev", "ino", "mode", "nlink", "uid", "gid", "size", "mtimeNs", "ctimeNs"]) {
    if (after[field] !== before[field]) fail("verifier-policy", `${label} changed while read`);
  }
  return Object.freeze({ path: selected, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
}

async function loadHostedVerifierRuntimePolicy() {
  const loaded = await readStableFixedFile(
    HOSTED_VERIFIER_RUNTIME_POLICY_PATH,
    "hosted verifier runtime policy",
    64 * 1024,
  );
  let value;
  try {
    value = JSON.parse(loaded.bytes.toString("utf8"));
  } catch {
    fail("verifier-policy", "hosted verifier runtime policy is not JSON");
  }
  exactRecordFields(value, [
    "schema", "version", "platform", "imageReference", "imageId", "nodePath", "githubCli", "files",
  ], "hosted verifier runtime policy");
  if (
    value.schema !== "revival.pin-hosted-verifier-runtime-policy" || value.version !== 1 ||
    value.platform !== "linux/amd64" ||
    value.imageReference !== FIXED_VERIFIER_RUNTIME_IMAGE_REFERENCE ||
    value.imageId !== FIXED_VERIFIER_RUNTIME_IMAGE_ID ||
    value.nodePath !== FIXED_VERIFIER_RUNTIME_NODE
  ) fail("verifier-policy", "hosted verifier runtime identity differs from the fixed policy");
  exactRecordFields(value.githubCli, [
    "archiveUrl", "archiveSha256", "archiveMember", "archiveMemberMode", "archiveMemberCount",
    "binarySha256", "binarySize",
  ], "hosted verifier runtime GitHub CLI");
  if (
    value.githubCli.archiveUrl !== "https://github.com/cli/cli/releases/download/v2.98.0/gh_2.98.0_linux_amd64.tar.gz" ||
    value.githubCli.archiveSha256 !== "3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de" ||
    value.githubCli.archiveMember !== "gh_2.98.0_linux_amd64/bin/gh" ||
    value.githubCli.archiveMemberMode !== 0o755 || value.githubCli.archiveMemberCount !== 231 ||
    value.githubCli.binarySha256 !== "62885b97de6a0cd85e616cdd94bcda908bf5cf1018094385892b05cea3537163" ||
    value.githubCli.binarySize !== 41377954
  ) fail("verifier-policy", "hosted verifier GitHub CLI identity differs from the fixed policy");
  if (!Array.isArray(value.files) || value.files.length !== 4) {
    fail("verifier-policy", "hosted verifier runtime must seal exactly four checked-in files");
  }
  const expectedFiles = Object.freeze([
    Object.freeze({
      name: "verifier",
      source: "platform/deploy/pin/hosted-attestation.mjs",
      target: FIXED_VERIFIER_TARGETS.verifier,
      maximumSize: 128 * 1024,
      mode: 0o555,
    }),
    Object.freeze({
      name: "policy",
      source: "platform/deploy/pin/hosted-attestation-policy.json",
      target: FIXED_VERIFIER_TARGETS.policy,
      maximumSize: 64 * 1024,
      mode: 0o444,
    }),
    Object.freeze({
      name: "trustedRoot",
      source: "platform/deploy/pin/github-private-trusted-root.jsonl",
      target: FIXED_VERIFIER_TARGETS.trustedRoot,
      maximumSize: 128 * 1024,
      mode: 0o444,
    }),
    Object.freeze({
      name: "boundedProcess",
      source: "platform/deploy/pin/bounded-process.mjs",
      target: FIXED_VERIFIER_TARGETS.boundedProcess,
      maximumSize: 32 * 1024,
      mode: 0o555,
    }),
  ]);
  const files = [];
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const item = value.files[index];
    const expected = expectedFiles[index];
    exactRecordFields(item, ["name", "source", "target", "sha256", "maximumSize", "mode"], "hosted verifier file");
    if (
      item.name !== expected.name || item.source !== expected.source || item.target !== expected.target ||
      item.maximumSize !== expected.maximumSize || item.mode !== expected.mode || !SHA256_RE.test(item.sha256)
    ) fail("verifier-policy", `hosted verifier ${expected.name} file policy changed`);
    const source = await readStableFixedFile(join(SOURCE_ROOT, item.source), `hosted verifier ${item.name}`, item.maximumSize);
    if (source.sha256 !== item.sha256) {
      fail("verifier-policy", `hosted verifier ${item.name} differs from its checked-in runtime digest`);
    }
    files.push(Object.freeze({ ...item, path: source.path }));
  }
  const hostedPolicy = await loadHostedPolicy();
  if (
    hostedPolicy.policy.githubCli.linuxAmd64ArchiveSha256 !== value.githubCli.archiveSha256 ||
    hostedPolicy.policy.githubCli.linuxAmd64BinarySha256 !== value.githubCli.binarySha256 ||
    hostedPolicy.policy.githubCli.linuxAmd64BinarySize !== value.githubCli.binarySize ||
    hostedPolicy.policy.trustedRoot.sha256 !== files[2].sha256 ||
    hostedPolicy.sha256 !== files[1].sha256
  ) fail("verifier-policy", "hosted verifier runtime and attestation policies disagree");
  return Object.freeze({ ...value, files: Object.freeze(files), sha256: loaded.sha256 });
}

async function inspectFixedVerifierRuntime({ pullIfMissing = true } = {}) {
  let inspection;
  const inspect = async () => await runCaptured(
    FIXED_DOCKER,
    ["image", "inspect", "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}", FIXED_VERIFIER_RUNTIME_IMAGE_ID],
    { maximum: 4096 },
  );
  try {
    inspection = await inspect();
  } catch (error) {
    if (!pullIfMissing) throw error;
    await runCaptured(
      FIXED_DOCKER,
      ["pull", "--platform", "linux/amd64", FIXED_VERIFIER_RUNTIME_IMAGE_REFERENCE],
      { maximum: 64 * 1024 },
    );
    inspection = await inspect();
  }
  if (inspection.stdout !== `${FIXED_VERIFIER_RUNTIME_IMAGE_ID}|linux|amd64\n`) {
    fail("verifier-runtime", "fixed hosted verifier image content identity is unavailable or ambiguous");
  }
}

async function requireFixedGithubCliArchive(pathValue, runtimePolicy) {
  const selected = resolve(pathValue);
  await requireOutsideSource(selected, "fixed GitHub CLI verifier archive");
  const existing = await lstat(selected, { bigint: true }).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing === null) {
    await runCaptured(FIXED_PYTHON, [
      "-I", "-B", "-c", FIXED_GITHUB_CLI_DOWNLOAD,
      runtimePolicy.githubCli.archiveUrl,
      selected,
      runtimePolicy.githubCli.archiveSha256,
      String(64 * 1024 * 1024),
    ], { cwd: "/", maximum: 4096 });
  }
  const loaded = await readStableFixedFile(selected, "fixed GitHub CLI verifier archive", 64 * 1024 * 1024);
  const metadata = await lstat(selected);
  if ((metadata.mode & 0o777) !== 0o600 || loaded.sha256 !== runtimePolicy.githubCli.archiveSha256) {
    fail("verifier-runtime", "fixed GitHub CLI verifier archive identity differs");
  }
  return loaded.path;
}

export function defaultHostedVerifierCacheRoot(environment = process.env) {
  const parent = resolve(
    environment.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  );
  return join(parent, "ai-pin-revival", "hosted-verifier-v1");
}

export function hostedVerifierBrokerPlatformSupported(
  platform = process.platform,
  architecture = process.arch,
) {
  return platform === "linux" && architecture === "x64";
}

function requireHostedVerifierBrokerPlatform() {
  if (!hostedVerifierBrokerPlatformSupported()) {
    fail(
      "verifier-runtime",
      "hosted attestation verification requires the fixed Linux x64 broker host",
    );
  }
}

async function requireCachedGithubCliArchive(cacheRoot, runtimePolicy) {
  const root = await requireOwnerDirectory(
    cacheRoot ?? defaultHostedVerifierCacheRoot(),
    "hosted verifier cache",
    { create: true },
  );
  await requireOutsideSource(root, "hosted verifier cache");
  const digest = runtimePolicy.githubCli.archiveSha256;
  const archivePath = join(root, `${digest}.gh-linux-amd64.tar.gz`);
  const lock = await acquireHeldFileLock(root, `.${digest}.lock`, {
    busyCode: "verifier-cache-locked",
    failedCode: "verifier-cache-lock-failed",
    invalidCode: "verifier-cache-lock-invalid",
    lostCode: "verifier-cache-lock-lost",
    label: "hosted verifier cache",
  });
  try {
    lock.assertHeld();
    const verified = await requireFixedGithubCliArchive(archivePath, runtimePolicy);
    lock.assertHeld();
    return verified;
  } finally {
    await lock.release();
  }
}

function parseSealedVerifierPaths(source, brokerPid) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("verifier-runtime", "sealed verifier asset broker output is not JSON");
  }
  exactRecordFields(value, ["verifier", "policy", "trustedRoot", "boundedProcess", "githubCli"], "sealed verifier assets");
  const expected = new RegExp(`^/proc/${brokerPid}/fd/[1-9][0-9]*$`, "u");
  const paths = Object.values(value);
  if (paths.some((pathValue) => typeof pathValue !== "string" || !expected.test(pathValue)) || new Set(paths).size !== 5) {
    fail("verifier-runtime", "sealed verifier asset broker returned unsafe descriptor paths");
  }
  return Object.freeze(value);
}

async function startSealedVerifierAssetBroker({ runtimePolicy, archivePath }) {
  const request = JSON.stringify({
    archive: {
      path: archivePath,
      sha256: runtimePolicy.githubCli.archiveSha256,
      maximumSize: 64 * 1024 * 1024,
    },
    githubCli: {
      member: runtimePolicy.githubCli.archiveMember,
      memberMode: runtimePolicy.githubCli.archiveMemberMode,
      memberCount: runtimePolicy.githubCli.archiveMemberCount,
      sha256: runtimePolicy.githubCli.binarySha256,
      size: runtimePolicy.githubCli.binarySize,
      mode: 0o555,
    },
    files: runtimePolicy.files.map((item) => ({
      name: item.name,
      path: item.path,
      sha256: item.sha256,
      maximumSize: item.maximumSize,
      mode: item.mode,
    })),
  });
  const child = spawn(FIXED_PYTHON, ["-I", "-B", "-c", FIXED_VERIFIER_ASSET_BROKER, request], {
    cwd: "/",
    detached: OWN_CHILD_PROCESS_GROUP,
    env: { HOME: "/nonexistent", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Observe exit immediately. Attaching a new `close` listener during cleanup
  // can miss a broker that dies after READY and otherwise hang forever.
  const tracked = trackChildProcess(child, { ownsProcessGroup: OWN_CHILD_PROCESS_GROUP });
  const readyOperation = new Promise((resolvePromise, rejectPromise) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const reject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length <= 64 * 1024) stderr = Buffer.concat([stderr, chunk]);
    });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > 64 * 1024) {
        reject(new PinReleaseBuildError("verifier-runtime", "sealed verifier asset broker output exceeded its bound"));
        return;
      }
      const newline = stdout.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== stdout.length - 1) {
        reject(new PinReleaseBuildError("verifier-runtime", "sealed verifier asset broker emitted ambiguous output"));
        return;
      }
      try {
        const paths = parseSealedVerifierPaths(stdout.subarray(0, newline).toString("utf8"), child.pid);
        settled = true;
        resolvePromise(Object.freeze({ paths, stderr }));
      } catch (error) {
        reject(error);
      }
    });
    child.once("error", (error) => reject(new PinReleaseBuildError(
      "verifier-runtime", `sealed verifier asset broker could not start: ${error.message}`,
    )));
    child.once("close", (code, signal) => {
      if (!settled) reject(new PinReleaseBuildError(
        "verifier-runtime",
        `sealed verifier asset broker exited before readiness (${signal ?? code})${stderr.length ? `: ${stderr.toString("utf8").trim()}` : ""}`,
      ));
    });
  });
  let ready;
  try {
    ready = await withTrackedDeadline(tracked, readyOperation, {
      milliseconds: BROKER_READY_TIMEOUT_MILLISECONDS,
      timeoutError: () => new PinReleaseBuildError(
        "verifier-runtime",
        "sealed verifier asset broker did not become ready",
      ),
    });
  } catch (error) {
    await terminateTrackedProcess(tracked);
    throw error;
  }
  let closePromise = null;
  return Object.freeze({
    paths: ready.paths,
    async close() {
      if (closePromise !== null) return await closePromise;
      closePromise = (async () => {
        if (tracked.outcome() === null) child.stdin.end();
        const outcome = await withTrackedDeadline(tracked, tracked.close, {
          milliseconds: BROKER_CLOSE_TIMEOUT_MILLISECONDS,
          timeoutError: () => new PinReleaseBuildError(
            "verifier-runtime",
            "sealed verifier asset broker did not close within its fixed deadline",
          ),
        });
        if (outcome.code !== 0 || outcome.signal !== null || outcome.error !== null) {
          throw new PinReleaseBuildError("verifier-runtime", "sealed verifier asset broker exited uncleanly");
        }
      })();
      return await closePromise;
    },
  });
}

async function withFixedVerifierAuthority({ archivePath, cacheRoot, uid, gid }, action) {
  requireHostedVerifierBrokerPlatform();
  const runtimePolicy = await loadHostedVerifierRuntimePolicy();
  await inspectFixedVerifierRuntime();
  const verifiedArchive = archivePath === undefined
    ? await requireCachedGithubCliArchive(cacheRoot, runtimePolicy)
    : await requireFixedGithubCliArchive(archivePath, runtimePolicy);
  const broker = await startSealedVerifierAssetBroker({ runtimePolicy, archivePath: verifiedArchive });
  try {
    const result = await action(Object.freeze({
      paths: broker.paths,
      imageId: FIXED_VERIFIER_RUNTIME_IMAGE_ID,
      nodePath: FIXED_VERIFIER_RUNTIME_NODE,
      uid: uid ?? (typeof process.getuid === "function" ? process.getuid() : 1000),
      gid: gid ?? (typeof process.getgid === "function" ? process.getgid() : 1000),
    }));
    await inspectFixedVerifierRuntime({ pullIfMissing: false });
    return result;
  } finally {
    await broker.close();
  }
}

/** Explicit parser fixture for hostile tar/gzip coverage; never an authority route. */
export async function validateHostedVerifierArchiveFixture({ archivePath, githubCli }) {
  if (process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES !== "1") {
    fail("test-fixture-disabled", "hosted verifier archive fixtures require explicit test mode");
  }
  exactRecordFields(githubCli, [
    "archiveSha256", "archiveMember", "archiveMemberMode", "archiveMemberCount", "binarySha256", "binarySize",
  ], "hosted verifier archive fixture");
  if (
    !SHA256_RE.test(githubCli.archiveSha256) || !SHA256_RE.test(githubCli.binarySha256) ||
    typeof githubCli.archiveMember !== "string" || githubCli.archiveMember.length === 0 ||
    !Number.isInteger(githubCli.archiveMemberMode) || !Number.isInteger(githubCli.archiveMemberCount) ||
    !Number.isInteger(githubCli.binarySize) || githubCli.archiveMemberCount <= 0 || githubCli.binarySize <= 0
  ) fail("test-fixture-invalid", "hosted verifier archive fixture identity is invalid");
  const runtimePolicy = await loadHostedVerifierRuntimePolicy();
  const broker = await startSealedVerifierAssetBroker({
    archivePath: resolve(archivePath),
    runtimePolicy: Object.freeze({ ...runtimePolicy, githubCli: Object.freeze({
      ...runtimePolicy.githubCli,
      ...githubCli,
    }) }),
  });
  try {
    return Object.freeze({ sealed: true });
  } finally {
    await broker.close();
  }
}

export function parseLiteralSigningEnvironment(source, label = "signing.env") {
  const values = {};
  const allowed = new Set(SIGNING_NAMES);
  for (const [index, rawLine] of String(source).split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) fail("signing-env-invalid", `${label}:${index + 1} is not a literal export NAME=value`);
    const name = match[1];
    if (!allowed.has(name)) fail("signing-env-invalid", `${label}:${index + 1} exports an unsupported name`);
    if (Object.hasOwn(values, name)) fail("signing-env-invalid", `${label}:${index + 1} repeats ${name}`);
    const raw = match[2];
    let value;
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      const parts = raw.slice(1, -1).split("'\\''");
      if (parts.some((part) => part.includes("'"))) {
        fail("signing-env-invalid", `${label}:${index + 1} contains an invalid single-quoted literal`);
      }
      value = parts.join("'");
    } else if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      const body = raw.slice(1, -1);
      if (body.includes('"') || body.includes("\\")) {
        fail("signing-env-invalid", `${label}:${index + 1} contains an invalid double-quoted literal`);
      }
      value = body;
    } else if (/^[^\s#]+$/u.test(raw)) {
      value = raw;
    } else {
      fail("signing-env-invalid", `${label}:${index + 1} is not a literal export NAME=value`);
    }
    if (value.length === 0) fail("signing-env-invalid", `${label}:${index + 1} defines blank ${name}`);
    values[name] = value;
  }
  for (const name of SIGNING_NAMES) {
    if (!Object.hasOwn(values, name)) fail("signing-env-invalid", `${label} is missing ${name}`);
  }
  return Object.freeze(values);
}

export function validatePinReleaseVersion(version, versionCode) {
  if (typeof version !== "string" || version !== version.trim()) {
    fail("invalid-version", "--version must use YYYY-MM-DD.N");
  }
  const match = VERSION_RE.exec(version);
  if (!match) fail("invalid-version", "--version must use YYYY-MM-DD.N");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const increment = Number(match[4]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isSafeInteger(increment) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail("invalid-version", "--version must name a real UTC date and safe increment");
  }
  if (
    typeof versionCode !== "number" ||
    !Number.isSafeInteger(versionCode) ||
    versionCode <= 1 ||
    versionCode > MAX_VERSION_CODE
  ) {
    fail("invalid-version-code", `--version-code must be an integer from 2 through ${MAX_VERSION_CODE}`);
  }
  return Object.freeze({ version, versionCode });
}

// Exported so `ship.mjs` resolves the SAME local store this command publishes
// to. A second copy of this path logic is how a ship would silently read an
// empty directory and report success against a release nobody built.
export function defaultOperatorPaths(environment = process.env) {
  const configDir = resolve(
    environment.REVIVAL_CONFIG_DIR ??
      join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ai-pin-revival"),
  );
  const secretsDir = resolve(environment.REVIVAL_SECRETS_DIR ?? join(configDir, "secrets"));
  const dataDir = resolve(
    environment.REVIVAL_DATA_DIR ??
      join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "ai-pin-revival"),
  );
  return Object.freeze({
    configDir,
    secretsDir,
    dataDir,
    buildDir: resolve(environment.REVIVAL_BUILD_DIR ?? join(dataDir, "build")),
    signingEnvironment: join(secretsDir, "pin", "signing.env"),
    privateAssets: resolve(environment.REVIVAL_PIN_PRIVATE_ASSETS_DIR ?? join(configDir, "pin-assets")),
    releaseRoot: resolve(environment.REVIVAL_PIN_RELEASE_OUTPUT_DIR ?? join(dataDir, "pin-releases")),
  });
}

export async function validatePinReleaseBuildInputs(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? SOURCE_ROOT);
  const environment = options.environment ?? process.env;
  const defaults = defaultOperatorPaths(environment);
  const signingEnvironment = await requireProtectedFile(
    options.signingEnvironment ?? defaults.signingEnvironment,
    "Pin signing environment",
    sourceRoot,
  );
  const signing = parseLiteralSigningEnvironment(
    await readFile(signingEnvironment, "utf8"),
    signingEnvironment,
  );
  if (!isAbsolute(signing.PIN_SIGNING_STORE_FILE)) {
    fail("input-invalid", "PIN_SIGNING_STORE_FILE must be an absolute external path");
  }
  const compatibilitySigningStore = await requireProtectedFile(
    resolve(signing.PIN_SIGNING_STORE_FILE),
    "Pin compatibility signing store",
    sourceRoot,
  );
  const embeddedPatchSigningStore = await requireProtectedFile(
    options.embeddedPatchSigningStore ??
      environment.REVIVAL_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE ??
      compatibilitySigningStore,
    "Pin embedded-patch signing store",
    sourceRoot,
  );
  const privateAssets = await requireOwnerDirectory(
    options.privateAssets ?? defaults.privateAssets,
    "Pin private assets",
    { sourceRoot },
  );
  for (const asset of PRIVATE_ASSETS) {
    const assetPath = join(privateAssets, asset.path);
    const metadata = await lstat(assetPath).catch((error) => {
      if (error?.code === "ENOENT") fail("input-missing", `Pin private asset ${asset.path} is missing`);
      throw error;
    });
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
      fail("input-invalid", `Pin private asset ${asset.path} must be a nonempty regular file`);
    }
    if (!pathIsWithin(await realpath(privateAssets), await realpath(assetPath))) {
      fail("input-invalid", `Pin private asset ${asset.path} escapes its external root`);
    }
    if ((await sha256File(assetPath)) !== asset.sha256) {
      fail("input-digest", `Pin private asset ${asset.path} has the wrong SHA-256`);
    }
  }
  const buildDir = await requireOwnerDirectory(options.buildDir ?? defaults.buildDir, "Pin build state", {
    create: true,
    sourceRoot,
  });
  const releaseRoot = await requireOwnerDirectory(options.releaseRoot ?? defaults.releaseRoot, "Pin release store", {
    create: true,
    sourceRoot,
  });
  return Object.freeze({
    sourceRoot,
    signingEnvironment,
    compatibilitySigningStore,
    embeddedPatchSigningStore,
    privateAssets,
    buildDir,
    releaseRoot,
  });
}

async function builderImageTag(sourceRoot) {
  const digest = createHash("sha256");
  for (const filename of [
    "platform/containers/pin-builder/Dockerfile",
    "platform/containers/pin-builder/debug-store.py",
    "platform/containers/pin-builder/entrypoint.sh",
    "platform/containers/pin-builder/publish-debug-set.sh",
    "platform/containers/pin-builder/toolchain.json",
    "platform/deploy/pin/hosted-attestation.mjs",
    "platform/deploy/pin/bounded-process.mjs",
    "platform/deploy/pin/hosted-attestation-policy.json",
    "platform/deploy/pin/github-private-trusted-root.jsonl",
    "pin/gradle/wrapper/gradle-wrapper.properties",
    "pin/injector/gradle/wrapper/gradle-wrapper.properties",
  ]) {
    digest.update(filename);
    digest.update(await readFile(join(sourceRoot, filename)));
  }
  return `ai-pin-revival/pin-builder:release-${digest.digest("hex").slice(0, 20)}`;
}

export function createDockerBuildInvocation({ sourceRoot, image, iidFile }) {
  if (iidFile !== undefined && !isAbsolute(iidFile)) {
    fail("invalid-run-root", "Docker builder IID file must be absolute");
  }
  return Object.freeze({
    command: FIXED_DOCKER,
    args: Object.freeze([
      "build",
      "--platform", "linux/amd64",
      "--file", join(sourceRoot, "platform/containers/pin-builder/Dockerfile"),
      "--tag", image,
      ...(iidFile === undefined ? [] : ["--iidfile", iidFile]),
      sourceRoot,
    ]),
  });
}

function mount(source, destination, readOnly = false) {
  return `type=bind,src=${source},dst=${destination}${readOnly ? ",readonly" : ""}`;
}

export function createDockerRunInvocation({
  sourceRoot,
  stateRoot,
  cacheRoot,
  signingEnvironment,
  compatibilitySigningStore,
  embeddedPatchSigningStore,
  privateAssets,
  hostedRequest,
  preSignBundle,
  image,
  version,
  versionCode,
  uid = typeof process.getuid === "function" ? process.getuid() : 1000,
  gid = typeof process.getgid === "function" ? process.getgid() : 1000,
  cargoJobs = 4,
}) {
  if (!isAbsolute(hostedRequest ?? "") || !isAbsolute(preSignBundle ?? "")) {
    fail("hosted-attestation-required", "signed build-release requires absolute hosted request and pre-sign bundle paths");
  }
  return Object.freeze({
    command: FIXED_DOCKER,
    args: Object.freeze([
      "run", "--rm", "--init", "--platform", "linux/amd64", "--read-only",
      "--network", "none",
      "--user", `${uid}:${gid}`,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "512",
      "--memory", "6g",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=2147483648",
      "--mount", mount(sourceRoot, "/workspace", true),
      "--mount", mount(stateRoot, "/state"),
      "--mount", mount(cacheRoot, "/cache"),
      "--mount", mount(signingEnvironment, "/run/secrets/pin/signing.env", true),
      "--mount", mount(compatibilitySigningStore, "/run/secrets/pin/compatibility.keystore", true),
      "--mount", mount(embeddedPatchSigningStore, "/run/secrets/pin/embedded-patch.keystore", true),
      "--mount", mount(privateAssets, "/run/private-assets", true),
      "--mount", mount(hostedRequest, "/run/hosted-release/request.json", true),
      "--mount", mount(preSignBundle, "/run/hosted-release/pre-sign.sigstore.json", true),
      "--env", "HOME=/state/home",
      "--env", "GRADLE_USER_HOME=/cache/gradle",
      "--env", "CARGO_HOME=/cache/cargo",
      "--env", "NPM_CONFIG_CACHE=/cache/npm",
      "--env", "ANDROID_USER_HOME=/cache/android",
      // runtime/core's build script embeds a pinned MiniLM ONNX model that it
      // pulls from the Hugging Face hub. Point it at the shared cache so the
      // networked phase can populate it and the offline phase can read it back;
      // the files are SHA-256 verified there, so a warm cache is not a weaker input.
      "--env", "EMBED_MODEL_CACHE_DIR=/cache/hf",
      // Cargo defaults to one rustc per visible CPU, and the container sees the
      // host's full count while being held to the memory limit above. The Rust
      // graph here has several crates that each need most of a gigabyte to
      // compile, so the default fan-out drives the cgroup out of memory and the
      // kernel reaps the Gradle daemon — which surfaces as the daemon
      // "disappearing" rather than as an OOM. Cap the fan-out to fit the cap,
      // which also makes the build's resource profile the same on any host.
      "--env", `CARGO_BUILD_JOBS=${cargoJobs}`,
      image,
      "build-release",
      "--version", version,
      "--version-code", String(versionCode),
    ]),
  });
}

export function createDockerPrefetchInvocation({
  sourceRoot,
  stateRoot,
  cacheRoot,
  image,
  version,
  versionCode,
  uid = typeof process.getuid === "function" ? process.getuid() : 1000,
  gid = typeof process.getgid === "function" ? process.getgid() : 1000,
}) {
  return Object.freeze({
    command: FIXED_DOCKER,
    args: Object.freeze([
      "run", "--rm", "--init", "--platform", "linux/amd64", "--read-only",
      "--user", `${uid}:${gid}`,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "512",
      "--memory", "6g",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=2147483648",
      "--mount", mount(sourceRoot, "/workspace", true),
      "--mount", mount(stateRoot, "/state"),
      "--mount", mount(cacheRoot, "/cache"),
      "--env", "HOME=/state/home",
      "--env", "GRADLE_USER_HOME=/cache/gradle",
      "--env", "CARGO_HOME=/cache/cargo",
      "--env", "NPM_CONFIG_CACHE=/cache/npm",
      "--env", "ANDROID_USER_HOME=/cache/android",
      // runtime/core's build script embeds a pinned MiniLM ONNX model that it
      // pulls from the Hugging Face hub. Point it at the shared cache so the
      // networked phase can populate it and the offline phase can read it back;
      // the files are SHA-256 verified there, so a warm cache is not a weaker input.
      "--env", "EMBED_MODEL_CACHE_DIR=/cache/hf",
      image,
      "prefetch-release",
      "--version", version,
      "--version-code", String(versionCode),
    ]),
  });
}

function requireAbsolutePaths(values, label) {
  for (const value of values) {
    if (!isAbsolute(value ?? "")) fail("hosted-attestation-required", `${label} requires canonical absolute paths`);
  }
}

function hostedVerifierDockerBase({ verifierAuthority }) {
  if (
    verifierAuthority === null || typeof verifierAuthority !== "object" ||
    verifierAuthority.imageId !== FIXED_VERIFIER_RUNTIME_IMAGE_ID ||
    verifierAuthority.nodePath !== FIXED_VERIFIER_RUNTIME_NODE ||
    !Number.isInteger(verifierAuthority.uid) || !Number.isInteger(verifierAuthority.gid)
  ) fail("verifier-runtime", "hosted verification has no fixed sealed verifier authority");
  exactRecordFields(
    verifierAuthority.paths,
    ["verifier", "policy", "trustedRoot", "boundedProcess", "githubCli"],
    "sealed hosted verifier paths",
  );
  const brokerPaths = Object.values(verifierAuthority.paths);
  if (
    brokerPaths.some((pathValue) => typeof pathValue !== "string" || !/^\/proc\/[1-9][0-9]*\/fd\/[1-9][0-9]*$/u.test(pathValue)) ||
    new Set(brokerPaths).size !== 5
  ) fail("verifier-runtime", "hosted verification asset descriptors are unsafe");
  return [
    "run", "--rm", "--init", "--platform", "linux/amd64", "--read-only",
    "--pull", "never",
    "--network", "none",
    "--user", `${verifierAuthority.uid}:${verifierAuthority.gid}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", "64",
    "--memory", "1g",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
    "--mount", mount(verifierAuthority.paths.verifier, FIXED_VERIFIER_TARGETS.verifier, true),
    "--mount", mount(verifierAuthority.paths.policy, FIXED_VERIFIER_TARGETS.policy, true),
    "--mount", mount(verifierAuthority.paths.trustedRoot, FIXED_VERIFIER_TARGETS.trustedRoot, true),
    "--mount", mount(verifierAuthority.paths.boundedProcess, FIXED_VERIFIER_TARGETS.boundedProcess, true),
    "--mount", mount(verifierAuthority.paths.githubCli, FIXED_VERIFIER_TARGETS.githubCli, true),
    "--entrypoint", FIXED_VERIFIER_RUNTIME_NODE,
  ];
}

export function createDockerPreVerificationInvocation({
  requestPath,
  preSignBundlePath,
  outputRoot,
  verifierAuthority,
}) {
  requireAbsolutePaths([requestPath, preSignBundlePath, outputRoot], "pre-sign verification");
  return Object.freeze({
    command: FIXED_DOCKER,
    args: Object.freeze([
      ...hostedVerifierDockerBase({ verifierAuthority }),
      "--mount", mount(requestPath, "/run/hosted-release/request.json", true),
      "--mount", mount(preSignBundlePath, "/run/hosted-release/pre-sign.sigstore.json", true),
      "--mount", mount(outputRoot, "/verified-output"),
      FIXED_VERIFIER_RUNTIME_IMAGE_ID,
      FIXED_VERIFIER_TARGETS.verifier,
      "verify-pre",
      "--request", "/run/hosted-release/request.json",
      "--bundle", "/run/hosted-release/pre-sign.sigstore.json",
      "--output", "/verified-output/pre-sign-verification.json",
    ]),
  });
}

export function createDockerReleaseVerificationInvocation({
  requestPath,
  preSignBundlePath,
  releaseBundlePath,
  predicatePath,
  artifactRoot,
  outputRoot,
  verifierAuthority,
}) {
  requireAbsolutePaths(
    [requestPath, preSignBundlePath, releaseBundlePath, predicatePath, artifactRoot, outputRoot],
    "five-APK verification",
  );
  return Object.freeze({
    command: FIXED_DOCKER,
    args: Object.freeze([
      ...hostedVerifierDockerBase({ verifierAuthority }),
      "--mount", mount(requestPath, "/run/hosted-release/request.json", true),
      "--mount", mount(preSignBundlePath, "/run/hosted-release/pre-sign.sigstore.json", true),
      "--mount", mount(releaseBundlePath, "/run/hosted-release/release.sigstore.json", true),
      "--mount", mount(predicatePath, "/run/hosted-release/release-predicate.json", true),
      "--mount", mount(artifactRoot, "/release-artifacts", true),
      "--mount", mount(outputRoot, "/verified-output"),
      FIXED_VERIFIER_RUNTIME_IMAGE_ID,
      FIXED_VERIFIER_TARGETS.verifier,
      "verify-release",
      "--request", "/run/hosted-release/request.json",
      "--pre-bundle", "/run/hosted-release/pre-sign.sigstore.json",
      "--release-bundle", "/run/hosted-release/release.sigstore.json",
      "--predicate", "/run/hosted-release/release-predicate.json",
      "--artifact-root", "/release-artifacts",
      "--output", "/verified-output/hosted-attestation.json",
    ]),
  });
}

export function createDockerVpsCandidateVerificationInvocation({
  receiptPath,
  bundlePath,
  candidateRoot,
  outputRoot,
  verifierAuthority,
}) {
  requireAbsolutePaths(
    [receiptPath, bundlePath, candidateRoot, outputRoot],
    "hosted VPS candidate verification",
  );
  return Object.freeze({
    command: FIXED_DOCKER,
    args: Object.freeze([
      ...hostedVerifierDockerBase({ verifierAuthority }),
      "--mount", mount(receiptPath, "/run/hosted-vps/receipt.json", true),
      "--mount", mount(bundlePath, "/run/hosted-vps/provider.sigstore.json", true),
      "--mount", mount(candidateRoot, "/run/hosted-vps/candidate", true),
      "--mount", mount(outputRoot, "/verified-output"),
      FIXED_VERIFIER_RUNTIME_IMAGE_ID,
      FIXED_VERIFIER_TARGETS.verifier,
      "verify-vps-candidate",
      "--receipt", "/run/hosted-vps/receipt.json",
      "--bundle", "/run/hosted-vps/provider.sigstore.json",
      "--candidate-root", "/run/hosted-vps/candidate",
      "--output", "/verified-output/evidence.json",
      "--verification-output", "/verified-output/verification.json",
    ]),
  });
}

async function defaultCommandRunner(invocation) {
  if (invocation.command !== FIXED_DOCKER) {
    fail("command-invalid", "Pin release Docker execution must use the fixed host binary");
  }
  const processHandle = spawn(invocation.command, invocation.args, {
    cwd: SOURCE_ROOT,
    detached: OWN_CHILD_PROCESS_GROUP,
    stdio: "inherit",
    // Docker executable, daemon endpoint and client configuration are all a
    // positive fixed set. Ambient PATH/DOCKER_HOST/context/config values can
    // neither replace the CLI nor redirect an authoritative verifier/build.
    env: FIXED_DOCKER_ENVIRONMENT,
  });
  const tracked = trackChildProcess(processHandle, { ownsProcessGroup: OWN_CHILD_PROCESS_GROUP });
  const outcome = await withTrackedDeadline(tracked, tracked.close, {
    milliseconds: DOCKER_COMMAND_TIMEOUT_MILLISECONDS,
    timeoutError: () => new PinReleaseBuildError(
      "command-timeout",
      `${basename(invocation.command)} exceeded its fixed wall-clock deadline`,
    ),
  });
  if (outcome.error !== null) {
    throw new PinReleaseBuildError(
      "command-failed",
      `${basename(invocation.command)} could not start: ${outcome.error.message}`,
    );
  }
  if (outcome.code !== 0 || outcome.signal !== null) {
    throw new PinReleaseBuildError(
      "command-failed",
      `${basename(invocation.command)} exited unsuccessfully`,
    );
  }
}

async function runCaptured(command, args, {
  cwd = SOURCE_ROOT,
  maximum = 1024 * 1024,
  timeoutMilliseconds = CAPTURED_COMMAND_TIMEOUT_MILLISECONDS,
} = {}) {
  const environment = {
    HOME: "/nonexistent",
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  if (command === FIXED_DOCKER) Object.assign(environment, {
    DOCKER_HOST: FIXED_DOCKER_ENVIRONMENT.DOCKER_HOST,
    DOCKER_CONFIG: FIXED_DOCKER_ENVIRONMENT.DOCKER_CONFIG,
  });
  const child = spawn(command, args, {
    cwd,
    detached: OWN_CHILD_PROCESS_GROUP,
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  const tracked = trackChildProcess(child, { ownsProcessGroup: OWN_CHILD_PROCESS_GROUP });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outputExceeded = false;
  let forcedTermination = null;
  const terminateForFailure = () => {
    if (forcedTermination === null) {
      forcedTermination = terminateTrackedProcess(tracked, { graceMilliseconds: 1 });
      void forcedTermination.catch(() => undefined);
    }
  };
  const append = (current, chunk) => {
    if (outputExceeded) return current;
    if (current.length + chunk.length > maximum) {
      outputExceeded = true;
      terminateForFailure();
      return current;
    }
    return Buffer.concat([current, chunk]);
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  const outcome = await withTrackedDeadline(tracked, tracked.close, {
    milliseconds: timeoutMilliseconds,
    timeoutError: () => new PinReleaseBuildError(
      "command-timeout",
      `${basename(command)} exceeded its fixed wall-clock deadline`,
    ),
  });
  if (forcedTermination !== null) await forcedTermination;
  if (outputExceeded) {
    throw new PinReleaseBuildError("command-output", `${basename(command)} output exceeded its bound`);
  }
  if (outcome.error !== null) {
    throw new PinReleaseBuildError(
      "command-failed",
      `${basename(command)} could not start: ${outcome.error.message}`,
    );
  }
  if (outcome.code !== 0 || outcome.signal !== null) {
    throw new PinReleaseBuildError(
      "command-failed",
      `${basename(command)} exited unsuccessfully${stderr.length ? `: ${stderr.toString("utf8").trim()}` : ""}`,
    );
  }
  return Object.freeze({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
}

function hostedRunLayout(runRoot) {
  const root = resolve(runRoot);
  const attestationRoot = join(root, "attestation");
  const stateRoot = join(root, "state");
  const cacheRoot = join(root, "cache");
  return Object.freeze({
    root,
    attestationRoot,
    stateRoot,
    cacheRoot,
    requestPath: join(attestationRoot, HOSTED_RUN_FILES.request),
    preSignBundlePath: join(attestationRoot, HOSTED_RUN_FILES.preSignBundle),
    preSignVerificationPath: join(attestationRoot, HOSTED_RUN_FILES.preSignVerification),
    releasePredicatePath: join(attestationRoot, HOSTED_RUN_FILES.releasePredicate),
    releaseChecksumsPath: join(attestationRoot, HOSTED_RUN_FILES.releaseChecksums),
    releaseBundlePath: join(attestationRoot, HOSTED_RUN_FILES.releaseBundle),
    imageIdPath: join(attestationRoot, HOSTED_RUN_FILES.imageId),
    verifierArchivePath: join(attestationRoot, HOSTED_RUN_FILES.verifierArchive),
    stagingRoot: join(stateRoot, "release-output"),
  });
}

async function requireFreshHostedRunRoot(runRoot) {
  if (!isAbsolute(runRoot ?? "")) fail("invalid-run-root", "--run-root must be an absolute external directory");
  const selected = await requireOwnerDirectory(runRoot, "hosted Pin release run", { create: true });
  if ((await readdir(selected)).length !== 0) {
    fail("run-not-fresh", "hosted Pin release prepare requires an empty run root");
  }
  const layout = hostedRunLayout(selected);
  for (const directory of [layout.attestationRoot, layout.stateRoot, layout.cacheRoot]) {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
  }
  for (const child of ["android", "cargo", "gradle", "hf", "npm"]) {
    await mkdir(join(layout.cacheRoot, child), { mode: 0o700 });
  }
  return layout;
}

async function requireHostedRunRoot(runRoot) {
  if (!isAbsolute(runRoot ?? "")) fail("invalid-run-root", "--run-root must be an absolute external directory");
  return hostedRunLayout(await requireOwnerDirectory(runRoot, "hosted Pin release run"));
}

function parseSourceGenerationIdentity(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("source-identity", "sealed native source identity is not JSON");
  }
  const fields = Object.keys(value ?? {}).sort();
  if (
    fields.join(",") !== "generationSha256,schema,tarSha256,version" ||
    value.schema !== "revival.pin-source-generation-identity" || value.version !== 1 ||
    !SHA256_RE.test(value.generationSha256) || !SHA256_RE.test(value.tarSha256)
  ) {
    fail("source-identity", "sealed native source identity has an unexpected shape");
  }
  return Object.freeze(value);
}

async function captureNativeSourceIdentity(sourceRoot) {
  const helper = join(sourceRoot, "platform/containers/pin-builder/debug-store.py");
  const result = await runCaptured(
    "/usr/bin/python3",
    ["-B", helper, "describe-native-source", sourceRoot],
    { cwd: sourceRoot, maximum: 64 * 1024 },
  );
  return parseSourceGenerationIdentity(result.stdout.trim());
}

async function cleanSourceDigest(sourceRoot) {
  const status = await runCaptured(
    "/usr/bin/git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: sourceRoot, maximum: 4 * 1024 * 1024 },
  );
  if (status.stdout !== "") fail("source-dirty", "hosted release source must be an exact clean checkout");
  const revision = (await runCaptured(
    "/usr/bin/git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { cwd: sourceRoot, maximum: 4096 },
  )).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) fail("source-identity", "hosted source commit is invalid");
  return revision;
}

async function toolchainDigest(sourceRoot) {
  return await sha256File(join(sourceRoot, "platform/containers/pin-builder/toolchain.json"));
}

async function readBuilderImageId(pathValue) {
  const loaded = await requireProtectedFile(pathValue, "immutable builder image ID");
  const value = (await readFile(loaded, "utf8")).trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) fail("builder-image", "Docker did not emit an immutable image ID");
  return value;
}

async function assertBuilderImagePresent(imageId) {
  const actual = (await runCaptured(
    FIXED_DOCKER,
    ["image", "inspect", "--format", "{{.Id}}", imageId],
    { maximum: 4096 },
  )).stdout.trim();
  if (actual !== imageId) fail("builder-image", "immutable builder image ID is unavailable or changed");
}

async function assertRequestMatchesPointOfUse(sourceRoot, request) {
  const [sourceDigest, sourceIdentity, currentToolchain] = await Promise.all([
    cleanSourceDigest(sourceRoot),
    captureNativeSourceIdentity(sourceRoot),
    toolchainDigest(sourceRoot),
  ]);
  if (
    request.sourceDigest !== sourceDigest ||
    request.sourceGenerationSha256 !== sourceIdentity.generationSha256 ||
    request.sourceTarSha256 !== sourceIdentity.tarSha256 ||
    request.toolchainSha256 !== currentToolchain
  ) {
    fail("request-stale", "hosted release request differs from the current sealed source/toolchain generation");
  }
  await assertBuilderImagePresent(request.builderImageId);
}

function artifactAttestationSet(receipts) {
  return Object.freeze(PIN_RELEASE_ARTIFACT_ROLES.map((role) => {
    const item = receipts.artifacts.find((artifact) => artifact.role === role);
    if (!item) fail("builder-output", `signed output is missing ${role}`);
    return Object.freeze({ role, name: `${role}.apk`, sha256: item.sha256, size: item.size });
  }));
}

function syntheticTestAuthorityEvidence(version, receipts) {
  const artifacts = artifactAttestationSet(receipts);
  const policy = Buffer.from('{}\n');
  const trustedRoot = Buffer.from('{}\n');
  const preBundle = Buffer.from('{}\n');
  const releaseBundle = Buffer.from('{}\n');
  const verification = Buffer.from('{}\n');
  const request = Buffer.from(canonicalHostedJson({
    schema: "revival.pin-hosted-release-request",
    version: 1,
    policySha256: createHash("sha256").update(policy).digest("hex"),
    repository: "TheAndersMadsen/ai-pin-revival",
    sourceRef: "refs/heads/main",
    sourceDigest: "0".repeat(40),
    sourceGenerationSha256: "1".repeat(64),
    sourceTarSha256: "2".repeat(64),
    builderImageId: `sha256:${"3".repeat(64)}`,
    toolchainSha256: "4".repeat(64),
    versionName: version,
    versionCode: receipts.artifacts[0].versionCode,
    roles: PIN_RELEASE_ARTIFACT_ROLES,
  }));
  const requestSha256 = createHash("sha256").update(request).digest("hex");
  const preSignBundleSha256 = createHash("sha256").update(preBundle).digest("hex");
  const runnerInvocationUri = "https://github.com/TheAndersMadsen/ai-pin-revival/actions/runs/1/attempts/1";
  const predicate = Buffer.from(canonicalHostedJson({
    schema: "revival.pin-hosted-five-apk",
    version: 1,
    requestSha256,
    preSignBundleSha256,
    runnerInvocationUri,
    artifacts,
  }));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  return Buffer.from(canonicalHostedJson({
    schema: "revival.pin-hosted-release-evidence",
    version: 1,
    provider: "github-actions-sigstore",
    policySha256: digest(policy),
    requestSha256,
    predicateSha256: digest(predicate),
    trustedRootSha256: digest(trustedRoot),
    preSignBundleSha256,
    releaseBundleSha256: digest(releaseBundle),
    preSignVerificationSha256: digest(verification),
    releaseVerificationSha256: digest(verification),
    runnerEnvironment: "github-hosted",
    runnerLabel: "ubuntu-24.04",
    runnerArchitecture: "x64",
    runnerInvocationUri,
    repository: "TheAndersMadsen/ai-pin-revival",
    sourceRef: "refs/heads/main",
    sourceDigest: "0".repeat(40),
    sourceGenerationSha256: "1".repeat(64),
    sourceTarSha256: "2".repeat(64),
    toolchainSha256: "4".repeat(64),
    builderImageId: `sha256:${"3".repeat(64)}`,
    artifacts,
    payloads: {
      policyBase64: policy.toString("base64"),
      requestBase64: request.toString("base64"),
      predicateBase64: predicate.toString("base64"),
      trustedRootBase64: trustedRoot.toString("base64"),
      preSignBundleBase64: preBundle.toString("base64"),
      releaseBundleBase64: releaseBundle.toString("base64"),
      preSignVerificationBase64: verification.toString("base64"),
      releaseVerificationBase64: verification.toString("base64"),
    },
  }));
}

export async function parseBuilderMetadata({ stagingRoot, version, versionCode }) {
  const metadataPath = join(stagingRoot, "release-metadata.tsv");
  const metadataStat = await lstat(metadataPath).catch((error) => {
    if (error?.code === "ENOENT") fail("builder-output", "pinned builder did not emit release metadata");
    throw error;
  });
  if (metadataStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.size > MAX_METADATA_BYTES) {
    fail("builder-output", "pinned builder release metadata is not a bounded regular file");
  }
  const lines = (await readFile(metadataPath, "utf8")).split(/\r?\n/u).filter(Boolean);
  if (lines.length !== PIN_RELEASE_ARTIFACT_ROLES.length) {
    fail("builder-output", "pinned builder did not emit exactly five release roles");
  }
  const artifacts = [];
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 7) fail("builder-output", "pinned builder metadata has an invalid row");
    const [role, packageName, actualVersion, rawVersionCode, signerSha256, recordedSha256, rawSize] = fields;
    if (!PIN_RELEASE_ARTIFACT_ROLES.includes(role)) fail("builder-output", "pinned builder emitted an unknown role");
    if (packageName !== PIN_RELEASE_PACKAGE_BY_ROLE[role]) fail("builder-output", `${role} package identity changed`);
    if (actualVersion !== version || rawVersionCode !== String(versionCode)) {
      fail("builder-output", `${role} version identity changed`);
    }
    if (signerSha256 !== PIN_COMPATIBILITY_CERT_SHA256) fail("builder-output", `${role} signer identity changed`);
    if (!SHA256_RE.test(recordedSha256) || !/^[1-9][0-9]*$/u.test(rawSize)) {
      fail("builder-output", `${role} byte identity is invalid`);
    }
    const name = `${role}.apk`;
    const apk = join(stagingRoot, name);
    const apkStat = await lstat(apk).catch((error) => {
      if (error?.code === "ENOENT") fail("builder-output", `${role} APK is missing`);
      throw error;
    });
    if (apkStat.isSymbolicLink() || !apkStat.isFile() || apkStat.size !== Number(rawSize)) {
      fail("builder-output", `${role} APK size or file type changed after pinned verification`);
    }
    if ((await sha256File(apk)) !== recordedSha256) {
      fail("builder-output", `${role} APK changed after pinned verification`);
    }
    artifacts.push({
      role,
      path: name,
      name,
      package: packageName,
      versionName: actualVersion,
      versionCode,
      size: apkStat.size,
      sha256: recordedSha256,
      signerSha256,
    });
  }
  return parsePinReleaseReceiptBundle({ schemaVersion: 1, artifacts });
}

async function syncFile(filename) {
  const handle = await open(filename, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!(["EINVAL", "ENOTSUP"].includes(error?.code))) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(filename, contents) {
  const temporary = join(dirname(filename), `.${basename(filename)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    await chmod(filename, 0o600);
    await syncDirectory(dirname(filename));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function acquireHeldFileLock(root, name, {
  busyCode,
  failedCode,
  invalidCode,
  lostCode,
  label,
}) {
  const lockPath = join(root, name);
  const existing = await lstat(lockPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    fail(invalidCode, `${label} lock is not a regular file`);
  }

  const helper = spawn(FIXED_PYTHON, ["-I", "-B", "-c", LOCK_HELPER, lockPath], {
    cwd: root,
    detached: OWN_CHILD_PROCESS_GROUP,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      HOME: "/nonexistent",
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
  });
  const tracked = trackChildProcess(helper, { ownsProcessGroup: OWN_CHILD_PROCESS_GROUP });
  let settled = false;
  let ready = false;
  let released = false;
  let lockFailure = null;
  let stdout = "";
  let stderr = "";
  const readyOperation = new Promise((resolvePromise, rejectPromise) => {
    const reject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    helper.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > 1024) {
        reject(new PinReleaseBuildError(failedCode, `${label} lock helper output was invalid`));
        return;
      }
      const response = stdout.split(/\r?\n/u)[0];
      if (response === "READY") {
        ready = true;
        settled = true;
        resolvePromise();
      } else if (response === "BUSY") {
        reject(new PinReleaseBuildError(busyCode, `another ${label} operation is active`));
      } else if (response === "INVALID") {
        reject(new PinReleaseBuildError(invalidCode, `${label} lock is invalid`));
      }
    });
    helper.stderr.on("data", (chunk) => {
      if (stderr.length <= 4096) stderr += chunk.toString("utf8");
    });
    helper.once("close", (code) => {
      if (ready) {
        if (!released) {
          lockFailure = new PinReleaseBuildError(
            lostCode,
            `${label} lock helper exited unexpectedly with status ${code ?? "unknown"}`,
          );
        }
        return;
      }
      if (settled) return;
      settled = true;
      rejectPromise(new PinReleaseBuildError(
        code === 73 ? busyCode : failedCode,
        code === 73
          ? `another ${label} operation is active`
          : `${label} lock helper exited before acquisition${stderr ? `: ${stderr.trim()}` : ""}`,
      ));
    });
  });
  try {
    await withTrackedDeadline(tracked, readyOperation, {
      milliseconds: 5_000,
      timeoutError: () => new PinReleaseBuildError(
        failedCode,
        `${label} lock helper did not become ready`,
      ),
    });
  } catch (error) {
    await terminateTrackedProcess(tracked);
    throw error;
  }
  void tracked.exit.then((outcome) => {
    if (ready && !released) {
      lockFailure = new PinReleaseBuildError(
        lostCode,
        `${label} lock helper exited unexpectedly (${outcome.signal ?? outcome.code ?? outcome.error?.message ?? "unknown"})`,
      );
    }
  });

  let releasePromise = null;
  return Object.freeze({
    assertHeld() {
      if (lockFailure || tracked.outcome() !== null) {
        throw lockFailure ?? new PinReleaseBuildError(
          lostCode,
          `${label} lock helper exited unexpectedly`,
        );
      }
    },
    async release() {
      if (releasePromise !== null) return await releasePromise;
      released = true;
      releasePromise = (async () => {
        if (tracked.outcome() === null) helper.stdin.end();
        await withTrackedDeadline(tracked, tracked.close, {
          milliseconds: BROKER_CLOSE_TIMEOUT_MILLISECONDS,
          timeoutError: () => new PinReleaseBuildError(
            lostCode,
            `${label} lock helper did not close within its fixed deadline`,
          ),
        });
      })();
      return await releasePromise;
    },
  });
}

async function acquirePublishLock(releaseRoot) {
  return await acquireHeldFileLock(releaseRoot, ".publish.lock", {
    busyCode: "publish-locked",
    failedCode: "publish-lock-failed",
    invalidCode: "publish-lock-invalid",
    lostCode: "publish-lock-lost",
    label: "Pin release publication",
  });
}

async function readHistory(releaseRoot) {
  const historyPath = join(releaseRoot, "history.json");
  let metadata;
  try {
    metadata = await lstat(historyPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_HISTORY_BYTES) {
    fail("history-invalid", "Pin release history must be a bounded regular file");
  }
  const source = await readFile(historyPath, "utf8");
  return parsePinReleaseHistory(parsePinReleaseJson(source, "Pin release history"));
}

async function readCurrentManifest(releaseRoot) {
  const currentPath = join(releaseRoot, "current.json");
  const metadata = await lstat(currentPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_CURRENT_BYTES) {
    fail("current-invalid", "Pin current release must be a bounded regular file");
  }
  const canonical = await readFile(currentPath, "utf8");
  const manifest = parseCanonicalPinReleaseManifestDocument(canonical);
  return Object.freeze({ manifest, canonical });
}

async function verifyPublishedRelease(directory, manifest, canonical) {
  const expectedEntries = [
    "manifest.json",
    ...manifest.artifacts.map((artifact) => artifact.name),
    ...(manifest.authority === undefined ? [] : [manifest.authority.name]),
  ].sort();
  const actualEntries = (await readdir(directory)).sort();
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    fail("release-equivocation", "immutable release contains missing or unexpected entries");
  }
  const manifestPath = join(directory, "manifest.json");
  const manifestStat = await lstat(manifestPath).catch(() => null);
  if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    fail("release-equivocation", "immutable release manifest is not a regular file");
  }
  const actualManifest = await readFile(manifestPath, "utf8").catch(() => "");
  if (actualManifest !== canonical) fail("release-equivocation", "immutable release manifest differs for the same releaseId");
  for (const artifact of manifest.artifacts) {
    const filename = join(directory, artifact.name);
    const metadata = await lstat(filename).catch(() => null);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== artifact.size) {
      fail("release-equivocation", `${artifact.role} immutable artifact differs for the same releaseId`);
    }
    if ((await sha256File(filename)) !== artifact.sha256) {
      fail("release-equivocation", `${artifact.role} immutable artifact hash differs for the same releaseId`);
    }
  }
  if (manifest.authority !== undefined) {
    const filename = join(directory, manifest.authority.name);
    const metadata = await lstat(filename).catch(() => null);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== manifest.authority.size) {
      fail("release-equivocation", "immutable hosted attestation evidence differs for the same releaseId");
    }
    if ((await sha256File(filename)) !== manifest.authority.sha256) {
      fail("release-equivocation", "immutable hosted attestation evidence hash differs for the same releaseId");
    }
  }
}

async function verifyHistoryRelease(releasesRoot, entry) {
  const immutableDirectory = join(releasesRoot, entry.releaseId);
  const immutableDirectoryStat = await lstat(immutableDirectory).catch(() => null);
  if (!immutableDirectoryStat || immutableDirectoryStat.isSymbolicLink() || !immutableDirectoryStat.isDirectory()) {
    fail("history-current-mismatch", "Pin release history entry has no real immutable directory");
  }
  const immutableCanonical = await readFile(join(immutableDirectory, "manifest.json"), "utf8").catch(() => {
    fail("history-current-mismatch", "Pin release history entry has no immutable manifest");
  });
  const immutableManifest = parseCanonicalPinReleaseManifestDocument(immutableCanonical);
  const immutableDigest = createHash("sha256").update(immutableCanonical).digest("hex");
  if (
    immutableManifest.releaseId !== entry.releaseId ||
    immutableManifest.version !== entry.version ||
    immutableManifest.artifacts[0].versionCode !== entry.versionCode ||
    immutableDigest !== entry.manifestSha256
  ) {
    fail("history-current-mismatch", "Pin release history entry differs from its immutable manifest");
  }
  await verifyPublishedRelease(immutableDirectory, immutableManifest, immutableCanonical);
  return Object.freeze({ manifest: immutableManifest, canonical: immutableCanonical });
}

async function verifyPublicationState(releaseRoot, releasesRoot) {
  const [historyValue, current] = await Promise.all([
    readHistory(releaseRoot),
    readCurrentManifest(releaseRoot),
  ]);
  if (historyValue === null) {
    if (current !== null) {
      fail("history-missing", "Pin current release exists without its anti-rollback history");
    }
    if ((await readdir(releasesRoot)).length !== 0) {
      fail("history-missing", "immutable Pin releases exist without anti-rollback metadata");
    }
    return Object.freeze({ schemaVersion: 1, releases: Object.freeze([]) });
  }
  const history = historyValue;
  const tail = history.releases.at(-1);
  if (!tail) {
    if (current !== null) fail("history-current-mismatch", "empty Pin release history has a current release");
    return history;
  }

  const immutable = await verifyHistoryRelease(releasesRoot, tail);
  if (current === null) {
    // Publication writes history before current. Recover only that exact,
    // byte-verified interrupted state while the kernel lock is held.
    await atomicWrite(join(releaseRoot, "current.json"), immutable.canonical);
  } else if (current.canonical !== immutable.canonical) {
    const previous = history.releases.at(-2);
    if (!previous || current.manifest.releaseId !== previous.releaseId) {
      fail("history-current-mismatch", "Pin current release differs from the anti-rollback history tail");
    }
    const priorImmutable = await verifyHistoryRelease(releasesRoot, previous);
    if (current.canonical !== priorImmutable.canonical) {
      fail("history-current-mismatch", "Pin current release differs from its prior anti-rollback entry");
    }
    // A crash after history publication can leave current exactly one entry
    // behind. No other mismatch is eligible for automatic repair.
    await atomicWrite(join(releaseRoot, "current.json"), immutable.canonical);
  }
  return history;
}

async function publishPinReleaseCore({
  releaseRoot,
  stagingRoot,
  version,
  receipts,
  authorityBytes = null,
  testFixtureAuthority = false,
}) {
  const safeReleaseRoot = await requireOwnerDirectory(releaseRoot, "Pin release store", { create: true });
  const safeStagingRoot = await requireOwnerDirectory(stagingRoot, "Pin release staging", { create: false });
  const releasesRoot = await requireOwnerDirectory(join(safeReleaseRoot, "releases"), "Pin immutable releases", {
    create: true,
  });
  const publicationLock = await acquirePublishLock(safeReleaseRoot);

  let incoming;
  try {
    publicationLock.assertHeld();
    const history = await verifyPublicationState(safeReleaseRoot, releasesRoot);
    publicationLock.assertHeld();
    let authority = null;
    let verifiedAuthority = null;
    if (authorityBytes !== null) {
      if (!Buffer.isBuffer(authorityBytes) || authorityBytes.length === 0 || authorityBytes.length > MAX_AUTHORITY_BYTES) {
        fail("authority-invalid", "hosted release authority evidence is not bounded bytes");
      }
      if (testFixtureAuthority) {
        if (process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES !== "1") {
          fail("authority-invalid", "synthetic authority is available only to explicit test fixtures");
        }
        try {
          verifiedAuthority = { evidence: JSON.parse(authorityBytes.toString("utf8")) };
        } catch {
          fail("authority-invalid", "synthetic authority evidence is not JSON");
        }
      } else {
        try {
          verifiedAuthority = await parseAuthorityEvidenceBytes(authorityBytes, {
            expectedArtifacts: artifactAttestationSet(receipts),
          });
        } catch (error) {
          fail("authority-invalid", `hosted release authority evidence is inconsistent: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const evidence = verifiedAuthority.evidence;
      authority = Object.freeze({
        kind: "github-hosted-native-x64",
        name: "hosted-attestation.json",
        size: authorityBytes.length,
        sha256: createHash("sha256").update(authorityBytes).digest("hex"),
        provider: evidence.provider,
        policySha256: evidence.policySha256,
        requestSha256: evidence.requestSha256,
        predicateSha256: evidence.predicateSha256,
        trustedRootSha256: evidence.trustedRootSha256,
        preSignBundleSha256: evidence.preSignBundleSha256,
        releaseBundleSha256: evidence.releaseBundleSha256,
        preSignVerificationSha256: evidence.preSignVerificationSha256,
        releaseVerificationSha256: evidence.releaseVerificationSha256,
        runnerEnvironment: evidence.runnerEnvironment,
        runnerLabel: evidence.runnerLabel,
        runnerArchitecture: evidence.runnerArchitecture,
        runnerInvocationUri: evidence.runnerInvocationUri,
        repository: evidence.repository,
        sourceRef: evidence.sourceRef,
        sourceDigest: evidence.sourceDigest,
        sourceGenerationSha256: evidence.sourceGenerationSha256,
        sourceTarSha256: evidence.sourceTarSha256,
        toolchainSha256: evidence.toolchainSha256,
        builderImageId: evidence.builderImageId,
      });
    }
    const priorHostedManifests = [];
    if (authority !== null && !testFixtureAuthority) {
      for (const entry of history.releases) {
        const prior = await verifyHistoryRelease(releasesRoot, entry);
        if (prior.manifest.schemaVersion !== 2 || prior.manifest.authority === undefined) {
          fail("candidate-history", "authoritative hosted release store contains an evidence-free candidate history entry");
        }
        priorHostedManifests.push(prior.manifest);
      }
    }
    const manifest = createPinReleaseManifest({ version, receipts, authority });
    if (
      authority !== null && !testFixtureAuthority &&
      (
        verifiedAuthority.request.versionName !== manifest.version ||
        manifest.artifacts.some((artifact) => artifact.versionCode !== verifiedAuthority.request.versionCode)
      )
    ) fail("authority-replay", "published release version differs from its exact attested request");
    for (const prior of priorHostedManifests) {
      if (
        prior.releaseId !== manifest.releaseId &&
        (
          prior.authority.requestSha256 === manifest.authority.requestSha256 ||
          prior.authority.runnerInvocationUri === manifest.authority.runnerInvocationUri
        )
      ) fail("authority-replay", "a prior release already consumed this hosted request or run identity");
    }
    const canonical = canonicalPinReleaseManifestJson(manifest);
    const verified = verifyPinReleaseMetadata({
      manifest,
      receipts,
      expectedSigner: PIN_COMPATIBILITY_CERT_SHA256,
      history,
    });
    const finalDirectory = join(releasesRoot, manifest.releaseId);
    let finalStat = null;
    try {
      finalStat = await lstat(finalDirectory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (finalStat) {
      if (finalStat.isSymbolicLink() || !finalStat.isDirectory()) {
        fail("release-equivocation", "immutable release path is not a real directory");
      }
      await verifyPublishedRelease(finalDirectory, manifest, canonical);
    } else {
      incoming = await mkdtemp(join(releasesRoot, `.${manifest.releaseId}.incoming-`));
      await chmod(incoming, 0o700);
      for (const artifact of manifest.artifacts) {
        const source = join(safeStagingRoot, artifact.name);
        const destination = join(incoming, artifact.name);
        await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
        await chmod(destination, 0o600);
        const copiedStat = await lstat(destination);
        if (copiedStat.size !== artifact.size || (await sha256File(destination)) !== artifact.sha256) {
          fail("artifact-changed", `${artifact.role} APK changed while it was published`);
        }
        await syncFile(destination);
      }
      if (manifest.authority !== undefined) {
        const destination = join(incoming, manifest.authority.name);
        await writeFile(destination, authorityBytes, { mode: 0o600, flag: "wx" });
        if ((await sha256File(destination)) !== manifest.authority.sha256) {
          fail("authority-changed", "hosted attestation evidence changed while published");
        }
        await syncFile(destination);
      }
      const immutableManifest = join(incoming, "manifest.json");
      await writeFile(immutableManifest, canonical, { mode: 0o600, flag: "wx" });
      await syncFile(immutableManifest);
      await syncDirectory(incoming);
      publicationLock.assertHeld();
      await rename(incoming, finalDirectory);
      incoming = undefined;
      await syncDirectory(releasesRoot);
    }

    const lastHistory = history.releases.at(-1);
    const releases = lastHistory?.releaseId === verified.historyEntry.releaseId
      ? [...history.releases]
      : [...history.releases, verified.historyEntry];
    const nextHistory = parsePinReleaseHistory({ schemaVersion: 1, releases });
    publicationLock.assertHeld();
    await atomicWrite(join(safeReleaseRoot, "history.json"), `${JSON.stringify(nextHistory)}\n`);
    publicationLock.assertHeld();
    await atomicWrite(join(safeReleaseRoot, "current.json"), canonical);
    publicationLock.assertHeld();

    return Object.freeze({
      schemaVersion: 1,
      releaseId: manifest.releaseId,
      version: manifest.version,
      versionCode: manifest.artifacts[0].versionCode,
      signerSha256: PIN_COMPATIBILITY_CERT_SHA256,
      releaseDirectory: finalDirectory,
      currentManifest: join(safeReleaseRoot, "current.json"),
      artifacts: Object.freeze(manifest.artifacts.map((artifact) => Object.freeze({
        role: artifact.role,
        sha256: artifact.sha256,
        size: artifact.size,
      }))),
    });
  } finally {
    if (incoming) await rm(incoming, { recursive: true, force: true }).catch(() => undefined);
    await publicationLock.release();
  }
}

/**
 * Low-level publication is deliberately available only to synthetic tests.
 * No product CLI imports this symbol; its structurally v2 evidence is marked by
 * a non-production policy payload and can never pass the cryptographic parser.
 */
export async function publishPinReleaseFixture(options) {
  if (process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES !== "1") {
    fail("test-fixture-disabled", "legacy candidate publication exists only in explicit test-fixture mode");
  }
  return await publishPinReleaseCore({
    ...options,
    authorityBytes: syntheticTestAuthorityEvidence(options.version, options.receipts),
    testFixtureAuthority: true,
  });
}

async function publishPinRelease(options) {
  const capability = options?.hostedPublicationCapability;
  if (
    capability === null || typeof capability !== "object" ||
    !HOSTED_PUBLICATION_CAPABILITIES.has(capability)
  ) {
    fail("hosted-attestation-required", "Pin release publication requires a fresh exact-five hosted attestation capability");
  }
  HOSTED_PUBLICATION_CAPABILITIES.delete(capability);
  return await publishPinReleaseCore(options);
}

export async function prepareHostedPinRelease(options) {
  if (process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES === "1") {
    fail("test-mode", "authoritative hosted preparation rejects legacy test-fixture mode");
  }
  const requestVersion = validatePinReleaseVersion(options.version, options.versionCode);
  const sourceRoot = resolve(options.sourceRoot ?? SOURCE_ROOT);
  const layout = await requireFreshHostedRunRoot(options.runRoot);
  const policyRecord = await loadHostedPolicy();
  const verifierRuntimePolicy = await loadHostedVerifierRuntimePolicy();
  await inspectFixedVerifierRuntime();
  await requireFixedGithubCliArchive(layout.verifierArchivePath, verifierRuntimePolicy);
  const [sourceDigest, beforeIdentity, currentToolchain] = await Promise.all([
    cleanSourceDigest(sourceRoot),
    captureNativeSourceIdentity(sourceRoot),
    toolchainDigest(sourceRoot),
  ]);
  const image = await builderImageTag(sourceRoot);
  await defaultCommandRunner(createDockerBuildInvocation({
    sourceRoot,
    image,
    iidFile: layout.imageIdPath,
  }));
  await chmod(layout.imageIdPath, 0o600);
  const imageId = await readBuilderImageId(layout.imageIdPath);
  await assertBuilderImagePresent(imageId);
  await defaultCommandRunner(createDockerPrefetchInvocation({
    sourceRoot,
    stateRoot: layout.stateRoot,
    cacheRoot: layout.cacheRoot,
    image: imageId,
    ...requestVersion,
    uid: options.uid,
    gid: options.gid,
  }));
  const [afterDigest, afterIdentity, afterToolchain] = await Promise.all([
    cleanSourceDigest(sourceRoot),
    captureNativeSourceIdentity(sourceRoot),
    toolchainDigest(sourceRoot),
  ]);
  if (
    afterDigest !== sourceDigest ||
    afterIdentity.generationSha256 !== beforeIdentity.generationSha256 ||
    afterIdentity.tarSha256 !== beforeIdentity.tarSha256 ||
    afterToolchain !== currentToolchain
  ) {
    fail("source-changed", "source/toolchain generation changed during credential-free preparation");
  }
  const request = {
    schema: "revival.pin-hosted-release-request",
    version: 1,
    policySha256: policyRecord.sha256,
    repository: policyRecord.policy.repository,
    sourceRef: policyRecord.policy.sourceRef,
    sourceDigest,
    sourceGenerationSha256: beforeIdentity.generationSha256,
    sourceTarSha256: beforeIdentity.tarSha256,
    builderImageId: imageId,
    toolchainSha256: currentToolchain,
    versionName: requestVersion.version,
    versionCode: requestVersion.versionCode,
    roles: policyRecord.policy.roles,
  };
  await atomicWrite(layout.requestPath, canonicalHostedJson(request));
  const loaded = await readHostedRequest(layout.requestPath, policyRecord);
  return Object.freeze({
    phase: "prepare",
    runRoot: layout.root,
    requestPath: loaded.path,
    requestSha256: loaded.sha256,
    builderImageId: imageId,
  });
}

export async function signHostedPinRelease(options) {
  if (process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES === "1") {
    fail("test-mode", "authoritative hosted signing rejects legacy test-fixture mode");
  }
  const requestedVersion = validatePinReleaseVersion(options.version, options.versionCode);
  const sourceRoot = resolve(options.sourceRoot ?? SOURCE_ROOT);
  const layout = await requireHostedRunRoot(options.runRoot);
  const policyRecord = await loadHostedPolicy();
  const requestFile = await readHostedRequest(layout.requestPath, policyRecord);
  if (
    requestFile.value.versionName !== requestedVersion.version ||
    requestFile.value.versionCode !== requestedVersion.versionCode
  ) fail("request-stale", "hosted request version differs from signing invocation");
  await requireProtectedFile(layout.preSignBundlePath, "pre-sign Sigstore bundle", sourceRoot);
  if (await lstat(layout.preSignVerificationPath).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  })) fail("run-not-fresh", "hosted signing phase was already attempted");

  // First authoritative call-graph gate. Nothing below this point has opened a
  // signing env, keystore, embedded key, private release asset, or release
  // store. Verifier code/tool/root come from a separate fixed runtime and
  // fully write-sealed memfds; the unverified request cannot select them.
  await assertRequestMatchesPointOfUse(sourceRoot, requestFile.value);
  await withFixedVerifierAuthority({
    archivePath: layout.verifierArchivePath,
    uid: options.uid,
    gid: options.gid,
  }, async (verifierAuthority) => {
    await defaultCommandRunner(createDockerPreVerificationInvocation({
      requestPath: layout.requestPath,
      preSignBundlePath: layout.preSignBundlePath,
      outputRoot: layout.attestationRoot,
      verifierAuthority,
    }));
  });
  await requireProtectedFile(layout.preSignVerificationPath, "verified pre-sign result", sourceRoot);
  await assertRequestMatchesPointOfUse(sourceRoot, requestFile.value);

  // This is deliberately the first call that reads signing/private inputs.
  const inputs = await validatePinReleaseBuildInputs({ ...options, sourceRoot });
  await defaultCommandRunner(createDockerRunInvocation({
    ...inputs,
    stateRoot: layout.stateRoot,
    cacheRoot: layout.cacheRoot,
    hostedRequest: layout.requestPath,
    preSignBundle: layout.preSignBundlePath,
    image: requestFile.value.builderImageId,
    version: requestedVersion.version,
    versionCode: requestedVersion.versionCode,
    uid: options.uid,
    gid: options.gid,
  }));
  await assertRequestMatchesPointOfUse(sourceRoot, requestFile.value);
  const receipts = await parseBuilderMetadata({
    stagingRoot: layout.stagingRoot,
    version: requestedVersion.version,
    versionCode: requestedVersion.versionCode,
  });
  const preVerificationSource = await readFile(layout.preSignVerificationPath, "utf8");
  let preVerification;
  try {
    preVerification = JSON.parse(preVerificationSource);
  } catch {
    fail("pre-verification", "verified pre-sign result is not JSON");
  }
  if (preVerificationSource !== canonicalHostedJson(preVerification) || typeof preVerification.runUri !== "string") {
    fail("pre-verification", "verified pre-sign result is not canonical or has no run identity");
  }
  const artifacts = artifactAttestationSet(receipts);
  const predicate = {
    schema: "revival.pin-hosted-five-apk",
    version: 1,
    requestSha256: requestFile.sha256,
    preSignBundleSha256: await sha256File(layout.preSignBundlePath),
    runnerInvocationUri: preVerification.runUri,
    artifacts,
  };
  parsePostPredicate(predicate, {
    policy: policyRecord.policy,
    requestSha256: requestFile.sha256,
    preSignBundleSha256: predicate.preSignBundleSha256,
    runnerInvocationUri: preVerification.runUri,
  });
  await atomicWrite(layout.releasePredicatePath, canonicalHostedJson(predicate));
  await atomicWrite(
    layout.releaseChecksumsPath,
    artifacts.map((artifact) => `${artifact.sha256} *${artifact.name}`).join("\n") + "\n",
  );
  return Object.freeze({
    phase: "sign",
    runRoot: layout.root,
    predicatePath: layout.releasePredicatePath,
    subjectChecksumsPath: layout.releaseChecksumsPath,
    artifacts,
  });
}

export async function publishHostedPinRelease(options) {
  if (process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES === "1") {
    fail("test-mode", "authoritative hosted publication rejects legacy test-fixture mode");
  }
  const requestedVersion = validatePinReleaseVersion(options.version, options.versionCode);
  const sourceRoot = resolve(options.sourceRoot ?? SOURCE_ROOT);
  const layout = await requireHostedRunRoot(options.runRoot);
  const policyRecord = await loadHostedPolicy();
  const requestFile = await readHostedRequest(layout.requestPath, policyRecord);
  if (
    requestFile.value.versionName !== requestedVersion.version ||
    requestFile.value.versionCode !== requestedVersion.versionCode
  ) fail("request-stale", "hosted request version differs from publication invocation");
  await Promise.all([
    requireProtectedFile(layout.preSignBundlePath, "pre-sign Sigstore bundle", sourceRoot),
    requireProtectedFile(layout.releaseBundlePath, "five-APK Sigstore bundle", sourceRoot),
    requireProtectedFile(layout.releasePredicatePath, "five-APK predicate", sourceRoot),
  ]);
  await assertRequestMatchesPointOfUse(sourceRoot, requestFile.value);
  const receipts = await parseBuilderMetadata({
    stagingRoot: layout.stagingRoot,
    version: requestedVersion.version,
    versionCode: requestedVersion.versionCode,
  });
  const verificationRoot = await mkdtemp(join(layout.root, "publication-verification-"));
  await chmod(verificationRoot, 0o700);
  try {
    // Publication point-of-use re-verification consumes both provider bundles
    // and all five APKs again. The separately fixed, sealed verifier runtime —
    // never request.builderImageId — is the only executable authority here.
    await withFixedVerifierAuthority({
      archivePath: layout.verifierArchivePath,
      uid: options.uid,
      gid: options.gid,
    }, async (verifierAuthority) => {
      await defaultCommandRunner(createDockerReleaseVerificationInvocation({
        requestPath: layout.requestPath,
        preSignBundlePath: layout.preSignBundlePath,
        releaseBundlePath: layout.releaseBundlePath,
        predicatePath: layout.releasePredicatePath,
        artifactRoot: layout.stagingRoot,
        outputRoot: verificationRoot,
        verifierAuthority,
      }));
    });
    const evidencePath = join(verificationRoot, HOSTED_RUN_FILES.authorityEvidence);
    const safeEvidence = await requireProtectedFile(evidencePath, "fresh hosted release evidence", sourceRoot);
    const authorityBytes = await readFile(safeEvidence);
    const expectedArtifacts = artifactAttestationSet(receipts);
    await parseAuthorityEvidenceBytes(authorityBytes, {
      expectedRequestSha256: requestFile.sha256,
      expectedArtifacts,
    });
    const capability = Object.freeze({});
    HOSTED_PUBLICATION_CAPABILITIES.add(capability);
    const defaults = defaultOperatorPaths(options.environment ?? process.env);
    return await publishPinRelease({
      hostedPublicationCapability: capability,
      releaseRoot: options.releaseRoot ?? defaults.releaseRoot,
      stagingRoot: layout.stagingRoot,
      version: requestedVersion.version,
      receipts,
      authorityBytes,
    });
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }
}

async function parsePersistedHostedAuthorityBinding({ authorityBytes, expectedArtifacts, manifest }) {
  const parsed = await parseAuthorityEvidenceBytes(authorityBytes, { expectedArtifacts });
  for (const field of HOSTED_AUTHORITY_EVIDENCE_FIELDS) {
    if (manifest.authority[field] !== parsed.evidence[field]) {
      fail(
        "authority-replay",
        `persisted release authority ${field} differs from its exact verified evidence`,
      );
    }
  }
  if (
    parsed.request.versionName !== manifest.version ||
    manifest.artifacts.some((artifact) => artifact.versionCode !== parsed.request.versionCode)
  ) {
    fail(
      "authority-replay",
      "persisted release version identity differs from its attested hosted request",
    );
  }
  return parsed;
}

/** Structural replay fixture. Cryptographic authority is deliberately absent. */
export async function parsePersistedHostedAuthorityBindingFixture(options) {
  if (process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES !== "1") {
    fail("test-fixture-disabled", "persisted hosted binding fixtures require explicit test mode");
  }
  return await parsePersistedHostedAuthorityBinding(options);
}

/**
 * Verify a file-only GitHub-hosted VPS candidate handoff with the same sealed
 * gh binary, trusted root, fixed Docker runtime, and non-self-hosted policy as
 * the Pin release lane.  This verifies provenance only; it does not deploy,
 * load an image, read a secret, or grant a remote publication capability.
 */
export async function verifyHostedVpsCandidateHandoff({
  receiptPath,
  bundlePath,
  candidateRoot,
  outputRoot,
  verifierCacheRoot,
  uid,
  gid,
}) {
  const output = await requireOwnerDirectory(
    outputRoot,
    "hosted VPS candidate verification output",
    { create: false },
  );
  await withFixedVerifierAuthority({
    cacheRoot: verifierCacheRoot ?? defaultHostedVerifierCacheRoot(),
    uid,
    gid,
  }, async (verifierAuthority) => {
    await defaultCommandRunner(createDockerVpsCandidateVerificationInvocation({
      receiptPath: resolve(receiptPath),
      bundlePath: resolve(bundlePath),
      candidateRoot: resolve(candidateRoot),
      outputRoot: output,
      verifierAuthority,
    }));
  });
  const evidencePath = await requireProtectedFile(
    join(output, "evidence.json"),
    "hosted VPS candidate verification evidence",
  );
  const verificationPath = await requireProtectedFile(
    join(output, "verification.json"),
    "hosted VPS candidate canonical verifier output",
  );
  return Object.freeze({
    evidencePath,
    evidenceBytes: await readFile(evidencePath),
    verificationPath,
    verificationBytes: await readFile(verificationPath),
  });
}

/**
 * Re-establish persisted release authority at a later publication boundary
 * (notably `pin release ship`). The evidence sidecar is only storage until the
 * separately pinned verifier runtime verifies both embedded bundles against
 * the five files again; a parsed JSON claim alone never grants authority.
 */
export async function reverifyPersistedHostedRelease({
  releaseDirectory,
  manifest,
  verifierCacheRoot,
  uid,
  gid,
}) {
  if (
    manifest?.schemaVersion !== 2 || manifest?.authority?.kind !== "github-hosted-native-x64" ||
    manifest.authority.name !== HOSTED_RUN_FILES.authorityEvidence
  ) fail("hosted-attestation-required", "persisted release has no recognized hosted authority");
  const directory = await requireOwnerDirectory(releaseDirectory, "persisted hosted release", { create: false });
  const evidencePath = await requireProtectedFile(
    join(directory, manifest.authority.name),
    "persisted hosted release evidence",
  );
  const metadata = await lstat(evidencePath);
  if (metadata.size !== manifest.authority.size || (await sha256File(evidencePath)) !== manifest.authority.sha256) {
    fail("authority-changed", "persisted hosted release evidence differs from its manifest digest");
  }
  const authorityBytes = await readFile(evidencePath);
  const expectedArtifacts = Object.freeze(PIN_RELEASE_ARTIFACT_ROLES.map((role) => {
    const artifact = manifest.artifacts.find((candidate) => candidate.role === role);
    if (!artifact) fail("authority-invalid", `persisted release is missing ${role}`);
    return Object.freeze({ role, name: artifact.name, sha256: artifact.sha256, size: artifact.size });
  }));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "revival-pin-authority-reverify-"));
  await chmod(temporaryRoot, 0o700);
  const inputRoot = join(temporaryRoot, "input");
  const outputRoot = join(temporaryRoot, "output");
  await mkdir(inputRoot, { mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  const paths = {
    requestPath: join(inputRoot, HOSTED_RUN_FILES.request),
    preSignBundlePath: join(inputRoot, HOSTED_RUN_FILES.preSignBundle),
    releaseBundlePath: join(inputRoot, HOSTED_RUN_FILES.releaseBundle),
    predicatePath: join(inputRoot, HOSTED_RUN_FILES.releasePredicate),
  };
  try {
    return await withFixedVerifierAuthority({
      cacheRoot: verifierCacheRoot ?? defaultHostedVerifierCacheRoot(),
      uid,
      gid,
    }, async (verifierAuthority) => {
      // The fixed executable/runtime/tool/root authority is captured before
      // any evidence claim is parsed. Historical builderImageId remains only
      // provider-signed request data and can never select point-of-use code.
      const parsed = await parsePersistedHostedAuthorityBinding({
        authorityBytes,
        expectedArtifacts,
        manifest,
      });
      const payloads = parsed.evidence.payloads;
      for (const [pathValue, field] of [
        [paths.requestPath, "requestBase64"],
        [paths.preSignBundlePath, "preSignBundleBase64"],
        [paths.releaseBundlePath, "releaseBundleBase64"],
        [paths.predicatePath, "predicateBase64"],
      ]) await writeFile(pathValue, Buffer.from(payloads[field], "base64"), { mode: 0o600, flag: "wx" });
      await defaultCommandRunner(createDockerReleaseVerificationInvocation({
        ...paths,
        artifactRoot: directory,
        outputRoot,
        verifierAuthority,
      }));
      const fresh = await readFile(join(outputRoot, HOSTED_RUN_FILES.authorityEvidence));
      if (!fresh.equals(authorityBytes)) {
        fail("authority-changed", "fresh point-of-use verification differs from persisted hosted evidence");
      }
      const after = await lstat(evidencePath);
      if (after.size !== metadata.size || (await sha256File(evidencePath)) !== manifest.authority.sha256) {
        fail("authority-changed", "persisted hosted evidence changed during point-of-use verification");
      }
      return Object.freeze({
        requestSha256: parsed.evidence.requestSha256,
        releaseBundleSha256: parsed.evidence.releaseBundleSha256,
        runnerInvocationUri: parsed.evidence.runnerInvocationUri,
      });
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function buildAndPublishPinRelease(options) {
  fail(
    "hosted-attestation-required",
    "local all-in-one signed Pin release build is candidate-only; use the pinned GitHub-hosted prepare, pre-attest, sign, post-attest, publish workflow",
  );
}

function help() {
  process.stdout.write(
    "Usage: ./revival pin release build --version YYYY-MM-DD.N --version-code INTEGER\n" +
    "       node platform/deploy/pin/build.mjs build --hosted-phase prepare|sign|publish\n" +
    "            --run-root ABSOLUTE_PATH --version YYYY-MM-DD.N --version-code INTEGER [--json]\n" +
    "\nThe all-in-one local command is candidate-only and refuses before opening signing inputs.\n" +
    "Authoritative releases use the pinned GitHub-hosted x64 workflow: prepare binds clean source,\n" +
    "toolchain and builder image; sign requires its provider-signed pre-attestation; publish\n" +
    "re-verifies both bundles and the exact five APK roles. This proves GitHub-hosted trusted-\n" +
    "workflow provenance, not bare metal or the absence of a hypervisor. No phase runs ADB.\n",
  );
}

function parseCli(argumentsList) {
  let version;
  let rawVersionCode;
  let hostedPhase;
  let runRoot;
  let json = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--version") version = argumentsList[++index];
    else if (argument === "--version-code") rawVersionCode = argumentsList[++index];
    else if (argument === "--hosted-phase") hostedPhase = argumentsList[++index];
    else if (argument === "--run-root") runRoot = argumentsList[++index];
    else if (argument === "--json") json = true;
    else fail("usage", `unknown build option: ${argument ?? ""}`);
  }
  if (!version || !rawVersionCode || !/^[1-9][0-9]*$/u.test(rawVersionCode)) {
    fail("usage", "build requires --version YYYY-MM-DD.N and --version-code INTEGER");
  }
  if (hostedPhase !== undefined) {
    if (!["prepare", "sign", "publish"].includes(hostedPhase) || !isAbsolute(runRoot ?? "")) {
      fail("usage", "--hosted-phase requires prepare|sign|publish and an absolute --run-root");
    }
  } else if (runRoot !== undefined) {
    fail("usage", "--run-root requires --hosted-phase");
  }
  return Object.freeze({ version, versionCode: Number(rawVersionCode), hostedPhase, runRoot, json });
}

async function main(argumentsList) {
  if (argumentsList.length === 0 || ["help", "--help", "-h"].includes(argumentsList[0])) {
    help();
    return;
  }
  const command = argumentsList.shift();
  if (command !== "build") fail("usage", "expected build");
  if (argumentsList.length === 1 && ["help", "--help", "-h"].includes(argumentsList[0])) {
    help();
    return;
  }
  const request = parseCli(argumentsList);
  const result = request.hostedPhase === "prepare"
    ? await prepareHostedPinRelease(request)
    : request.hostedPhase === "sign"
      ? await signHostedPinRelease(request)
      : request.hostedPhase === "publish"
        ? await publishHostedPinRelease(request)
        : await buildAndPublishPinRelease(request);
  if (request.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      request.hostedPhase
        ? `[implemented] completed hosted Pin release phase ${request.hostedPhase}${result.releaseId ? ` for ${result.releaseId}` : ""}\n`
        : `[implemented] built and published Pin release ${result.releaseId}\n`,
    );
    process.stdout.write(`[unknown] no physical Pin was inspected or modified by this host-only command.\n`);
  }
}

if (resolve(process.argv[1] ?? "") === SELF_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pin-release-build: ${message}\n`);
    process.exitCode = error?.code === "usage" ? 64 : 1;
  });
}
