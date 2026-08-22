#!/usr/bin/env python3
"""Execute one manifest-bound release program from continuously held objects.

The release root, manifest, every directory, and every regular file are opened
without following links.  The exact manifest inventory, metadata, and digests
are checked before execution and revalidated after it.  Safety-critical shell
libraries are exposed to the child as individual descriptor paths so sourcing
them cannot reopen mutable release names.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys


SHA256 = re.compile(r"^[0-9a-f]{64}$")
DOCKER_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
REMOTE_ROOT = "/home/anders/ai-pin-revival"
MAX_MANIFEST = 16 * 1024 * 1024
TRUSTED_PATH = "/usr/bin:/usr/sbin"
TRUSTED_EXECUTABLES = {
    "bash": "/usr/bin/bash",
    "docker": "/usr/bin/docker",
    "node": "/usr/bin/node",
    "python": "/usr/bin/python3",
    "sudo": "/usr/bin/sudo",
}
CANDIDATE_HELPER_REFERENCE = (
    "node:22.18.0-alpine3.22@"
    "sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b"
)
HELD_ENV_BINDINGS = {
    "platform/deploy/vps/remote/common.sh": "REVIVAL_HELD_COMMON",
    "platform/deploy/vps/remote/domain.sh": "REVIVAL_HELD_DOMAIN",
    "platform/deploy/vps/remote/domain.py": "REVIVAL_HELD_DOMAIN_PY",
    "platform/deploy/vps/remote/transaction.py": "REVIVAL_HELD_TRANSACTION",
    "platform/deploy/vps/remote/carry-baseline.py": "REVIVAL_HELD_CARRY_BASELINE",
    "platform/deploy/vps/remote/candidate-runtime.py": "REVIVAL_HELD_CANDIDATE_RUNTIME",
    "platform/deploy/vps/remote/candidate-authority-exec.py": "REVIVAL_HELD_CANDIDATE_AUTHORITY_EXEC",
    "platform/deploy/vps/remote/release-store.py": "REVIVAL_HELD_RELEASE_STORE",
    "platform/deploy/vps/remote/held-release-exec.py": "REVIVAL_HELD_EXEC",
    "platform/deploy/vps/remote/held-compose.py": "REVIVAL_HELD_COMPOSE",
    "platform/deploy/candidate-store.py": "REVIVAL_HELD_CANDIDATE_STORE",
    "platform/deploy/release-candidate.mjs": "REVIVAL_HELD_CANDIDATE_VERIFIER",
    # Preflight must prove the live edge certificate against the exact trust
    # root embedded in this reviewed release.  Expose the already-open sealed
    # object; a logical release pathname is not certificate authority.
    "platform/deploy/pin/activate.mjs": "REVIVAL_HELD_PIN_ACTIVATE",
    "platform/deploy/vps/verify-release.py": "REVIVAL_HELD_RELEASE_VERIFIER",
}
REQUIRED_MEMFD_SEALS = (
    getattr(fcntl, "F_SEAL_SEAL", 0x0001) |
    getattr(fcntl, "F_SEAL_SHRINK", 0x0002) |
    getattr(fcntl, "F_SEAL_GROW", 0x0004) |
    getattr(fcntl, "F_SEAL_WRITE", 0x0008)
)


def refuse(message: str) -> "NoReturn":
    raise SystemExit(f"held release execution refusal: {message}")


def identity(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_nlink, value.st_uid, value.st_gid,
            stat.S_IMODE(value.st_mode))


def open_directory(path: str) -> int:
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        refuse("release directory is not canonical and absolute")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.split("/")[1:]:
            if not component or component in (".", ".."):
                refuse("release directory has an unsafe component")
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor); descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def open_file(path: str, maximum: int) -> tuple[int, os.stat_result]:
    parent = open_directory(os.path.dirname(path))
    try:
        name = os.path.basename(path)
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                before.st_uid != os.getuid() or before.st_gid != os.getgid() or
                before.st_size > maximum or stat.S_IMODE(before.st_mode) not in (0o600, 0o644, 0o755)):
            refuse("release manifest metadata is unsafe")
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        opened = os.fstat(descriptor)
        if identity(opened) != identity(before):
            os.close(descriptor)
            refuse("release manifest moved before open")
        return descriptor, opened
    finally:
        os.close(parent)


def read_fd(descriptor: int, metadata: os.stat_result) -> bytes:
    data = bytearray(); offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("held release file was truncated")
        data.extend(block); offset += len(block)
    if identity(os.fstat(descriptor)) != identity(metadata):
        refuse("held release file changed while reading")
    return bytes(data)


def hash_fd(descriptor: int, metadata: os.stat_result) -> str:
    digest = hashlib.sha256(); offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("held release file was truncated while hashing")
        digest.update(block); offset += len(block)
    if identity(os.fstat(descriptor)) != identity(metadata):
        refuse("held release file changed while hashing")
    return digest.hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


def parse_manifest(payload: bytes, expected: str) -> dict[str, dict]:
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        refuse("release manifest is invalid JSON")
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "profile", "releaseId", "entries"}:
        refuse("release manifest schema is invalid")
    body = {"schemaVersion": value.get("schemaVersion"), "profile": value.get("profile"),
            "entries": value.get("entries")}
    if (value.get("schemaVersion") != 1 or value.get("profile") != "vps" or
            value.get("releaseId") != expected or
            hashlib.sha256(canonical(body)).hexdigest() != expected):
        refuse("release manifest does not reproduce the requested release ID")
    result: dict[str, dict] = {}
    if not isinstance(value["entries"], list) or not value["entries"]:
        refuse("release manifest inventory is empty")
    for entry in value["entries"]:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "size", "mode"}:
            refuse("release manifest entry schema is invalid")
        name = entry.get("path")
        if (not isinstance(name, str) or not name or name.startswith("/") or "\\" in name or
                any(part in ("", ".", "..") for part in name.split("/")) or name in result or
                entry.get("mode") not in ("0644", "0755") or
                not isinstance(entry.get("size"), int) or isinstance(entry.get("size"), bool) or
                entry["size"] < 0 or not SHA256.fullmatch(str(entry.get("sha256")))):
            refuse("release manifest entry is unsafe")
        result[name] = entry
    return result


def hold_tree(root: int, entries: dict[str, dict]) -> tuple[dict[str, tuple[int, os.stat_result, str]], list[tuple[int, os.stat_result, str]]]:
    uid = os.getuid(); gid = os.getgid()
    files: dict[str, tuple[int, os.stat_result, str]] = {}
    directories: list[tuple[int, os.stat_result, str]] = []

    def expected_children(relative: str) -> dict[str, str]:
        prefix = f"{relative}/" if relative else ""
        children: dict[str, str] = {}
        for name in entries:
            if not name.startswith(prefix):
                continue
            remainder = name[len(prefix):]
            child, separator, _ = remainder.partition("/")
            kind = "directory" if separator else "file"
            if child in children and children[child] != kind:
                refuse("release inventory has a file/directory collision")
            children[child] = kind
        return children

    def walk(directory: int, relative: str) -> None:
        wanted = expected_children(relative)
        if set(os.listdir(directory)) != set(wanted):
            refuse("release tree has an extra or missing entry")
        direct_directories = 0
        for name in sorted(wanted):
            child_relative = f"{relative}/{name}" if relative else name
            before = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if wanted[name] == "directory":
                direct_directories += 1
                if (not stat.S_ISDIR(before.st_mode) or
                        (before.st_uid, before.st_gid) != (uid, gid) or
                        stat.S_IMODE(before.st_mode) not in (0o700, 0o755)):
                    refuse("release directory metadata is unsafe")
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=directory)
                opened = os.fstat(child)
                if identity(opened) != identity(before):
                    os.close(child); refuse("release directory moved before open")
                directories.append((child, opened, child_relative))
                walk(child, child_relative)
            else:
                entry = entries[child_relative]
                if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                        (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_size) !=
                        (uid, gid, int(entry["mode"], 8), entry["size"])):
                    refuse("release file metadata is unsafe")
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                opened = os.fstat(child)
                if identity(opened) != identity(before):
                    os.close(child); refuse("release file moved before open")
                digest = hash_fd(child, opened)
                if digest != entry["sha256"]:
                    os.close(child); refuse("release file digest differs from manifest")
                files[child_relative] = (child, opened, digest)
        metadata = os.fstat(directory)
        if (not stat.S_ISDIR(metadata.st_mode) or
                (metadata.st_uid, metadata.st_gid) != (uid, gid) or
                stat.S_IMODE(metadata.st_mode) not in (0o700, 0o755) or
                metadata.st_nlink != 2 + direct_directories):
            refuse("release directory authority is unsafe")

    root_meta = os.fstat(root)
    directories.append((root, root_meta, "."))
    walk(root, "")
    return files, directories


def require_unchanged(files: dict[str, tuple[int, os.stat_result, str]],
                      directories: list[tuple[int, os.stat_result, str]]) -> None:
    directory_map = {name: descriptor for descriptor, _, name in directories}
    expected_children: dict[str, set[str]] = {name: set() for name in directory_map}
    for name in [*directory_map, *files]:
        if name == ".":
            continue
        parent_name = os.path.dirname(name) or "."
        expected_children.setdefault(parent_name, set()).add(os.path.basename(name.rstrip("/")))
    for descriptor, metadata, name in directories:
        if identity(os.fstat(descriptor)) != identity(metadata):
            refuse(f"held release directory changed through execution: {name}")
        if set(os.listdir(descriptor)) != expected_children.get(name, set()):
            refuse(f"release directory name inventory changed through execution: {name}")
        if name != ".":
            parent_name = os.path.dirname(name) or "."
            current = os.stat(os.path.basename(name), dir_fd=directory_map[parent_name],
                              follow_symlinks=False)
            if identity(current) != identity(metadata):
                refuse(f"release directory name no longer resolves to held object: {name}")
    for name, (descriptor, metadata, digest) in files.items():
        if identity(os.fstat(descriptor)) != identity(metadata) or hash_fd(descriptor, metadata) != digest:
            refuse(f"held release file changed through execution: {name}")
        parent_name = os.path.dirname(name) or "."
        current = os.stat(os.path.basename(name), dir_fd=directory_map[parent_name],
                          follow_symlinks=False)
        if identity(current) != identity(metadata):
            refuse(f"release file name no longer resolves to held object: {name}")


def create_sealed_snapshots(
        files: dict[str, tuple[int, os.stat_result, str]], entry: str
) -> dict[str, tuple[int, os.stat_result, str]]:
    """Copy every executable dependency into an immutable sealed memfd.

    Holding an ordinary read descriptor is not sufficient execution authority:
    its owner can still modify that same inode while an interpreter is reading
    it.  These snapshots are sealed against writes, growth, and truncation
    before any child starts.  The original release descriptors remain held and
    are revalidated after the child, so mutation is both unable to affect the
    executed bytes and still makes the operation fail closed.
    """
    if not hasattr(os, "memfd_create") or not hasattr(fcntl, "F_ADD_SEALS") or not hasattr(fcntl, "F_GET_SEALS"):
        refuse("sealed in-memory execution authority is unavailable")
    selected = {entry, *(path for path in HELD_ENV_BINDINGS if path in files)}
    selected.update(path for path in files
                    if path.startswith("platform/deploy/vps/remote/lib/") and
                    path.endswith(".sh") and "/" not in path[len("platform/deploy/vps/remote/lib/"):])
    snapshots: dict[str, tuple[int, os.stat_result, str]] = {}
    try:
        for path in sorted(selected):
            if path not in files:
                refuse(f"required held execution dependency is absent: {path}")
            source, metadata, digest = files[path]
            flags = getattr(os, "MFD_CLOEXEC", 0x0001) | getattr(os, "MFD_ALLOW_SEALING", 0x0002)
            snapshot = os.memfd_create("revival-held-" + os.path.basename(path), flags)
            try:
                offset = 0
                while offset < metadata.st_size:
                    block = os.pread(source, min(1024 * 1024, metadata.st_size - offset), offset)
                    if not block:
                        refuse("held release dependency was truncated while snapshotting")
                    written = 0
                    while written < len(block):
                        written += os.write(snapshot, block[written:])
                    offset += len(block)
                if identity(os.fstat(source)) != identity(metadata):
                    refuse("held release dependency changed while snapshotting")
                os.fchmod(snapshot, stat.S_IMODE(metadata.st_mode))
                fcntl.fcntl(snapshot, fcntl.F_ADD_SEALS, REQUIRED_MEMFD_SEALS)
                seals = fcntl.fcntl(snapshot, fcntl.F_GET_SEALS)
                if seals & REQUIRED_MEMFD_SEALS != REQUIRED_MEMFD_SEALS:
                    refuse("held release dependency memfd is not fully sealed")
                snapshot_meta = os.fstat(snapshot)
                if (snapshot_meta.st_size != metadata.st_size or
                        stat.S_IMODE(snapshot_meta.st_mode) != stat.S_IMODE(metadata.st_mode) or
                        hash_fd(snapshot, snapshot_meta) != digest):
                    refuse("sealed execution snapshot differs from release authority")
                snapshots[path] = (snapshot, snapshot_meta, digest)
            except BaseException:
                os.close(snapshot)
                raise
        return snapshots
    except BaseException:
        for snapshot, _, _ in snapshots.values():
            os.close(snapshot)
        raise


def held_path(descriptor: int) -> str:
    # Every descriptor below is explicitly listed in subprocess.pass_fds.  Use
    # proc-self names so the authority survives Bash -> Node/Python dispatches
    # without reopening a pathname owned by this (or any other) process.
    return f"/proc/self/fd/{descriptor}"


def trusted_host_executables() -> dict[str, str]:
    """Authenticate the fixed host runtime without consulting PATH or env."""
    for directory in TRUSTED_PATH.split(":"):
        metadata = os.stat(directory, follow_symlinks=False)
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or
                metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) & 0o022):
            refuse("trusted executable directory is missing or writable")
    for label, path in TRUSTED_EXECUTABLES.items():
        if not path.startswith("/usr/bin/") or os.path.dirname(path) != "/usr/bin":
            refuse(f"trusted {label} executable policy is invalid")
        link = os.lstat(path)
        if link.st_uid != 0 or link.st_gid != 0:
            refuse(f"trusted {label} executable name is not root-owned")
        resolved = os.path.realpath(path)
        if os.path.dirname(resolved) != "/usr/bin":
            refuse(f"trusted {label} executable resolves outside /usr/bin")
        before = os.stat(resolved, follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or
                before.st_gid != 0 or stat.S_IMODE(before.st_mode) & 0o022 or
                not stat.S_IMODE(before.st_mode) & 0o111):
            refuse(f"trusted {label} executable metadata is unsafe")
        descriptor = os.open(resolved, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            if identity(os.fstat(descriptor)) != identity(before):
                refuse(f"trusted {label} executable moved before open")
        finally:
            os.close(descriptor)
    return dict(TRUSTED_EXECUTABLES)


def validate_authority_paths(tree: str, manifest: str, release_id: str) -> None:
    retained = (tree == f"{REMOTE_ROOT}/releases/{release_id}" and
                manifest == f"{REMOTE_ROOT}/manifests/{release_id}.json")
    bootstrap_tree = f"{REMOTE_ROOT}/incoming/{release_id}/verified-driver"
    bootstrap_prefix = re.escape(f"{REMOTE_ROOT}/incoming/{release_id}/.candidate-")
    bootstrap_match = re.fullmatch(
        bootstrap_prefix + r"([0-9a-f]{64})\.partial/\1/release\.manifest\.json",
        manifest)
    bootstrap = tree == bootstrap_tree and bootstrap_match is not None
    if not (retained or bootstrap):
        refuse("release tree and manifest are outside the protected authority stores")


def child_environment(root: int, manifest: int,
                      files: dict[str, tuple[int, os.stat_result, str]],
                      logical_root: str, release_id: str, entry: str,
                      helper_image: str) -> dict[str, str]:
    # This is deliberately a positive environment. In particular, do not copy
    # PATH, exported Bash functions, loader/language options, HOME/XDG state,
    # proxy variables, or tool configuration from the caller. The selected
    # release receives only fixed host-runtime policy and descriptor authority.
    docker_config = f"{REMOTE_ROOT}/private/docker-cli-empty"
    inherited_docker = {name: value for name, value in os.environ.items()
                        if name.upper().startswith("DOCKER_")}
    if inherited_docker not in ({}, {"DOCKER_HOST": "unix:///var/run/docker.sock",
                                     "DOCKER_CONFIG": docker_config}):
        refuse("ambient Docker daemon/config selection is forbidden")
    if helper_image != CANDIDATE_HELPER_REFERENCE and not DOCKER_ID.fullmatch(helper_image):
        refuse("backup helper image authority is invalid")
    environment = {
        "DOCKER_CONFIG": docker_config,
        "DOCKER_HOST": "unix:///var/run/docker.sock",
        "HOME": "/nonexistent",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": TRUSTED_PATH,
        "TZ": "UTC",
        "HELPER_IMAGE": helper_image,
        "REVIVAL_HOST_BASH": TRUSTED_EXECUTABLES["bash"],
        "REVIVAL_HOST_DOCKER": TRUSTED_EXECUTABLES["docker"],
        "REVIVAL_HOST_NODE": TRUSTED_EXECUTABLES["node"],
        "REVIVAL_HOST_PYTHON": TRUSTED_EXECUTABLES["python"],
        "REVIVAL_HOST_SUDO": TRUSTED_EXECUTABLES["sudo"],
    }
    if entry == "platform/deploy/vps/remote/staging-smoke.sh":
        trace = os.environ.get("REVIVAL_STAGING_SMOKE_TRACE", "0")
        evidence = os.environ.get("REVIVAL_STAGING_SMOKE_EVIDENCE", "")
        if trace not in ("0", "1"):
            refuse("staging smoke trace selection is invalid")
        if evidence:
            deployment_prefix = f"{REMOTE_ROOT}/deployments/"
            if (not evidence.startswith(deployment_prefix) or
                    not evidence.endswith("/staging-smoke-evidence") or
                    any(part in ("", ".", "..")
                        for part in evidence[len(deployment_prefix):].split("/"))):
                refuse("staging smoke evidence path is outside the deployment store")
            environment["REVIVAL_STAGING_SMOKE_EVIDENCE"] = evidence
        environment["REVIVAL_STAGING_SMOKE_TRACE"] = trace
    environment["REVIVAL_HELD_RELEASE_ROOT"] = held_path(root)
    environment["REVIVAL_HELD_RELEASE_ROOT_FD"] = str(root)
    environment["REVIVAL_HELD_RELEASE_MANIFEST_FD"] = str(manifest)
    # These values are not authority on their own.  They name the exact tree and
    # identity whose descriptors this process is retaining, so entry points can
    # make their historical path/topology assertions without deriving a bogus
    # root from /proc/<pid>/fd/<entry>.
    environment["REVIVAL_HELD_RELEASE_LOGICAL_ROOT"] = logical_root
    environment["REVIVAL_HELD_RELEASE_ID"] = release_id
    for relative, variable in HELD_ENV_BINDINGS.items():
        if relative in files:
            environment[variable] = held_path(files[relative][0])
    prefix = "platform/deploy/vps/remote/lib/"
    for relative, (descriptor, _, _) in files.items():
        if relative.startswith(prefix) and relative.endswith(".sh") and "/" not in relative[len(prefix):]:
            stem = relative[len(prefix):-3].upper().replace("-", "_")
            environment[f"REVIVAL_HELD_COMMON_LIB_{stem}"] = held_path(descriptor)
    return environment


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tree", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--expect-release-id", required=True)
    parser.add_argument("--entry", required=True)
    parser.add_argument("--interpreter", choices=("bash", "python", "node"), required=True)
    parser.add_argument("--helper-image", default=CANDIDATE_HELPER_REFERENCE)
    parser.add_argument("--privileged", action="store_true")
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    if not SHA256.fullmatch(arguments.expect_release_id):
        refuse("requested release ID is invalid")
    validate_authority_paths(arguments.tree, arguments.manifest,
                             arguments.expect_release_id)
    if (arguments.entry.startswith("/") or "\\" in arguments.entry or
            any(part in ("", ".", "..") for part in arguments.entry.split("/"))):
        refuse("release entry path is unsafe")
    if arguments.arguments[:1] == ["--"]:
        arguments.arguments = arguments.arguments[1:]

    manifest_fd, manifest_meta = open_file(arguments.manifest, MAX_MANIFEST)
    root = open_directory(arguments.tree)
    files: dict[str, tuple[int, os.stat_result, str]] = {}
    directories: list[tuple[int, os.stat_result, str]] = []
    snapshots: dict[str, tuple[int, os.stat_result, str]] = {}
    try:
        entries = parse_manifest(read_fd(manifest_fd, manifest_meta), arguments.expect_release_id)
        if arguments.entry not in entries:
            refuse("requested program is absent from the release manifest")
        files, directories = hold_tree(root, entries)
        snapshots = create_sealed_snapshots(files, arguments.entry)
        entry_fd = snapshots[arguments.entry][0]
        executables = trusted_host_executables()
        executable = executables[arguments.interpreter]
        if arguments.privileged and arguments.interpreter != "python":
            refuse("privileged held execution is restricted to Python helpers")
        standard_input = None
        if arguments.privileged:
            sudo = executables["sudo"]
            # sudo normally closes non-standard descriptors.  Stream the bytes
            # from the already-open, digest-checked descriptor instead of asking
            # it to reopen a release pathname or relying on closefrom_override.
            command = [sudo, "-n", executable, "-I", "-B", "-", *arguments.arguments]
            standard_input = os.fdopen(os.dup(entry_fd), "rb", closefd=True)
        elif arguments.interpreter == "bash":
            command = [executable, "--noprofile", "--norc", held_path(entry_fd), *arguments.arguments]
        elif arguments.interpreter == "python":
            command = [executable, "-I", "-B", held_path(entry_fd), *arguments.arguments]
        else:
            # Node resolves its main module through realpath unless this option
            # is present.  A sealed memfd deliberately has no filesystem name,
            # so ordinary Node fails with ENOENT on `/memfd:... (deleted)`.
            # The internal held flags are consumed before the public CLI and
            # bind the verifier to this independently held root and manifest.
            command = [executable, "--preserve-symlinks", "--preserve-symlinks-main", held_path(entry_fd),
                       "--held-release-root-fd", str(root),
                       "--held-release-manifest-fd", str(manifest_fd),
                       "--held-release-id", arguments.expect_release_id,
                       *arguments.arguments]
        inherited = tuple({manifest_fd, root, *(item[0] for item in files.values()),
                           *(item[0] for item in snapshots.values()),
                           *(item[0] for item in directories)})
        try:
            result = subprocess.run(command, check=False,
                                    env=child_environment(root, manifest_fd, snapshots, arguments.tree,
                                                          arguments.expect_release_id, arguments.entry,
                                                          arguments.helper_image),
                                    pass_fds=inherited, cwd=held_path(root), stdin=standard_input)
        finally:
            if standard_input is not None:
                standard_input.close()
        require_unchanged(files, directories)
        if identity(os.fstat(manifest_fd)) != identity(manifest_meta):
            refuse("release manifest changed through execution")
        rebound_manifest, rebound_manifest_meta = open_file(arguments.manifest, MAX_MANIFEST)
        try:
            if identity(rebound_manifest_meta) != identity(manifest_meta):
                refuse("release manifest name no longer resolves to held authority")
        finally:
            os.close(rebound_manifest)
        rebound_root = open_directory(arguments.tree)
        try:
            if identity(os.fstat(rebound_root)) != identity(directories[0][1]):
                refuse("release root name no longer resolves to held authority")
        finally:
            os.close(rebound_root)
        raise SystemExit(result.returncode)
    finally:
        for descriptor, _, _ in snapshots.values():
            try: os.close(descriptor)
            except OSError: pass
        for descriptor, _, _ in files.values():
            try: os.close(descriptor)
            except OSError: pass
        for descriptor, _, _ in reversed(directories):
            if descriptor != root:
                try: os.close(descriptor)
                except OSError: pass
        os.close(root); os.close(manifest_fd)


if __name__ == "__main__":
    main()
