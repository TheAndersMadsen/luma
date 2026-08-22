#!/usr/bin/env python3
"""Descriptor-anchored extraction and no-replace publication of one release."""

from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import json
import os
import re
import secrets
import stat
import struct
import subprocess
import sys


SHA256 = re.compile(r"^[0-9a-f]{64}$")
REMOTE_ROOT = "/home/anders/ai-pin-revival"
MAXIMUMS = {
    "candidate.json": 2 * 1024 * 1024,
    "release.tar.gz": 512 * 1024 * 1024,
    "release.manifest.json": 16 * 1024 * 1024,
    "verify-release.py": 2 * 1024 * 1024,
}


def refuse(message: str) -> "NoReturn":
    raise SystemExit(f"release store refusal: {message}")


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def identity(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_nlink, value.st_uid, value.st_gid,
            stat.S_IMODE(value.st_mode))


def open_absolute(path: str) -> int:
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        refuse("managed path is not canonical and absolute")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.split("/")[1:]:
            if not component or component in (".", ".."):
                refuse("managed path has an unsafe component")
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def require_managed_directory(descriptor: int, label: str, *, flat: bool = False) -> os.stat_result:
    metadata = os.fstat(descriptor)
    if (not stat.S_ISDIR(metadata.st_mode) or
            (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) !=
            (os.getuid(), os.getgid(), 0o700) or (flat and metadata.st_nlink != 2)):
        refuse(f"{label} directory metadata is unsafe")
    return metadata


def open_child_directory(parent: int, name: str, label: str, *, flat: bool = False) -> tuple[int, os.stat_result]:
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    opened = require_managed_directory(descriptor, label, flat=flat)
    if identity(before) != identity(opened):
        os.close(descriptor)
        refuse(f"{label} directory moved before open")
    return descriptor, opened


def open_regular(parent: int, name: str, maximum: int) -> tuple[int, os.stat_result]:
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
            (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) !=
            (os.getuid(), os.getgid(), 0o600) or before.st_size > maximum):
        refuse(f"candidate input metadata is unsafe: {name}")
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    opened = os.fstat(descriptor)
    if identity(opened) != identity(before):
        os.close(descriptor)
        refuse(f"candidate input moved before open: {name}")
    return descriptor, opened


def read_fd(descriptor: int, metadata: os.stat_result) -> bytes:
    data = bytearray()
    offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("held input was truncated")
        data.extend(block)
        offset += len(block)
    if identity(os.fstat(descriptor)) != identity(metadata):
        refuse("held input moved while reading")
    return bytes(data)


def hash_fd(descriptor: int, metadata: os.stat_result) -> str:
    digest = hashlib.sha256()
    offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("held input was truncated while hashing")
        digest.update(block)
        offset += len(block)
    if identity(os.fstat(descriptor)) != identity(metadata):
        refuse("held input moved while hashing")
    return digest.hexdigest()


def rename_no_replace(source_parent: int, source: str, destination_parent: int, destination: str) -> None:
    function = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
    if function is None:
        refuse("renameat2 is unavailable")
    if function(source_parent, os.fsencode(source), destination_parent,
                os.fsencode(destination), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def require_same_child(parent: int, name: str, expected: os.stat_result, label: str) -> None:
    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if identity(current) != identity(expected):
        refuse(f"{label} was replaced before publication")


def descriptor_path(descriptor: int, child: str | None = None) -> str:
    root = f"/proc/{os.getpid()}/fd/{descriptor}"
    return root if child is None else f"{root}/{child}"


def run_verifier(verifier: int, arguments: list[str]) -> dict:
    command = ["/usr/bin/python3", "-I", "-B", descriptor_path(verifier),
               *arguments, "--json"]
    result = subprocess.run(command, check=False, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            env={"HOME": "/nonexistent", "LANG": "C.UTF-8",
                                 "LC_ALL": "C.UTF-8", "PATH": "/usr/bin:/usr/sbin",
                                 "TZ": "UTC"})
    if result.returncode != 0:
        refuse("release verifier rejected held publication inputs")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError:
        refuse("release verifier returned invalid JSON")
    return value


def validate_verification(value: object, release_id: str) -> None:
    if (not isinstance(value, dict) or value.get("ok") is not True or
            value.get("releaseId") != release_id or value.get("profile") != "vps" or
            not isinstance(value.get("files"), int) or value["files"] <= 0):
        refuse("release verifier result does not bind the requested release")


def publish_file(source: int, source_meta: os.stat_result, destination: int, name: str) -> None:
    def accept_existing() -> bool:
        try:
            existing, existing_meta = open_regular(destination, name, source_meta.st_size)
        except FileNotFoundError:
            return False
        try:
            if (existing_meta.st_size != source_meta.st_size or
                    hash_fd(existing, existing_meta) != hash_fd(source, source_meta)):
                refuse(f"stored immutable artifact conflicts: {name}")
        finally:
            os.close(existing)
        return True

    if accept_existing():
        return
    if not hasattr(os, "O_TMPFILE"):
        refuse("anonymous atomic artifact publication is unavailable")
    try:
        output = os.open(".", os.O_WRONLY | os.O_TMPFILE, 0o600, dir_fd=destination)
    except OSError as error:
        refuse(f"anonymous atomic artifact publication failed: {error}")
    try:
        offset = 0
        while offset < source_meta.st_size:
            block = os.pread(source, min(1024 * 1024, source_meta.st_size - offset), offset)
            if not block:
                refuse("held publication input was truncated")
            written = 0
            while written < len(block):
                written += os.write(output, block[written:])
            offset += len(block)
        os.fsync(output)
        if identity(os.fstat(source)) != identity(source_meta):
            refuse("held publication input moved while copying")
        linkat = getattr(ctypes.CDLL(None, use_errno=True), "linkat", None)
        if linkat is None:
            refuse("linkat is unavailable for atomic artifact publication")
        if linkat(output, b"", destination, os.fsencode(name), 0x1000):
            error = ctypes.get_errno()
            if error != errno.EEXIST:
                raise OSError(error, os.strerror(error))
            if not accept_existing():
                refuse("artifact destination disappeared during publication")
        else:
            os.fsync(destination)
    finally:
        os.close(output)


def write_once(directory: int, name: str, payload: bytes) -> None:
    def accept_existing() -> bool:
        try:
            descriptor, metadata = open_regular(directory, name, len(payload))
        except FileNotFoundError:
            return False
        try:
            if read_fd(descriptor, metadata) != payload:
                refuse("package verification record conflicts with this publication")
        finally:
            os.close(descriptor)
        return True

    if accept_existing():
        return
    if not hasattr(os, "O_TMPFILE"):
        refuse("anonymous atomic verification publication is unavailable")
    descriptor = os.open(".", os.O_WRONLY | os.O_TMPFILE, 0o600, dir_fd=directory)
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
        linkat = getattr(ctypes.CDLL(None, use_errno=True), "linkat", None)
        if linkat is None:
            refuse("linkat is unavailable for atomic verification publication")
        if linkat(descriptor, b"", directory, os.fsencode(name), 0x1000):
            error = ctypes.get_errno()
            if error != errno.EEXIST:
                raise OSError(error, os.strerror(error))
            if not accept_existing():
                refuse("verification destination disappeared during publication")
        else:
            os.fsync(directory)
    finally:
        os.close(descriptor)


def verify_tree_metadata(directory: int, manifest: dict,
                         held_descriptors: list[tuple[str, int, os.stat_result, str | None]] | None = None) -> dict[str, tuple[object, ...]]:
    """Require the manifest's exact owner-owned, unlinked filesystem tree."""
    raw_entries = manifest.get("entries") if isinstance(manifest, dict) else None
    if not isinstance(raw_entries, list) or not raw_entries:
        refuse("release manifest has no filesystem inventory")
    expected: dict[str, dict] = {}
    for entry in raw_entries:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "size", "mode"}:
            refuse("release manifest entry schema is invalid")
        name = entry.get("path")
        if (not isinstance(name, str) or not name or name.startswith("/") or "\\" in name or
                any(part in ("", ".", "..") for part in name.split("/")) or name in expected or
                entry.get("mode") not in ("0644", "0755") or
                not isinstance(entry.get("size"), int) or isinstance(entry.get("size"), bool) or
                entry["size"] < 0 or not SHA256.fullmatch(str(entry.get("sha256")))):
            refuse("release manifest entry is unsafe")
        expected[name] = entry

    uid = os.getuid(); gid = os.getgid()

    def children(relative: str) -> dict[str, str]:
        prefix = f"{relative}/" if relative else ""
        result: dict[str, str] = {}
        for name in expected:
            if not name.startswith(prefix):
                continue
            remainder = name[len(prefix):]
            child, separator, _ = remainder.partition("/")
            kind = "directory" if separator else "file"
            if child in result and result[child] != kind:
                refuse("release manifest has a file/directory collision")
            result[child] = kind
        return result

    authority: dict[str, tuple[object, ...]] = {}

    def walk(descriptor: int, relative: str) -> None:
        wanted = children(relative)
        if set(os.listdir(descriptor)) != set(wanted):
            refuse("release tree has an extra or missing filesystem entry")
        direct_directories = 0
        for name in sorted(wanted):
            child_relative = f"{relative}/{name}" if relative else name
            before = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            mode = stat.S_IMODE(before.st_mode)
            if wanted[name] == "file":
                entry = expected[child_relative]
                if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                        (before.st_uid, before.st_gid, mode, before.st_size) !=
                        (uid, gid, int(entry["mode"], 8), entry["size"])):
                    refuse("release tree file metadata is unsafe")
                held = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
                try:
                    if identity(os.fstat(held)) != identity(before):
                        refuse("release tree file moved before open")
                    digest = hash_fd(held, before)
                    if digest != entry["sha256"]:
                        refuse("release tree file digest differs from the manifest")
                    authority[child_relative] = ("file", *identity(before), digest)
                finally:
                    if held_descriptors is None:
                        os.close(held)
                    else:
                        held_descriptors.append((child_relative, held, before, digest))
            else:
                direct_directories += 1
                if (not stat.S_ISDIR(before.st_mode) or (before.st_uid, before.st_gid) != (uid, gid) or
                        mode not in (0o700, 0o755)):
                    refuse("release tree directory metadata is unsafe")
                held = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                               dir_fd=descriptor)
                try:
                    if identity(os.fstat(held)) != identity(before):
                        refuse("release tree directory moved before open")
                    walk(held, child_relative)
                    if identity(os.fstat(held)) != identity(before):
                        refuse("release tree directory moved during verification")
                finally:
                    if held_descriptors is None:
                        os.close(held)
                    else:
                        held_descriptors.append((child_relative + "/", held, before, None))
        metadata = os.fstat(descriptor)
        if (metadata.st_uid, metadata.st_gid) != (uid, gid) or stat.S_IMODE(metadata.st_mode) not in (0o700, 0o755):
            refuse("release tree directory authority is unsafe")
        if metadata.st_nlink != 2 + direct_directories:
            refuse("release tree directory link count is unsafe")
        authority[f"{relative}/" if relative else "."] = ("directory", *identity(metadata))

    walk(directory, "")
    return authority


def require_held_tree(descriptors: list[tuple[str, int, os.stat_result, str | None]]) -> None:
    for name, descriptor, metadata, digest in descriptors:
        if identity(os.fstat(descriptor)) != identity(metadata):
            refuse(f"held release object changed through publication: {name}")
        if digest is not None and hash_fd(descriptor, metadata) != digest:
            refuse(f"held release file bytes changed through publication: {name}")


def require_same_tree(before: dict[str, tuple[object, ...]],
                      after: dict[str, tuple[object, ...]], *, renamed_root: bool) -> None:
    if set(before) != set(after):
        refuse("release tree authority inventory changed")
    for name in before:
        if name == "." and renamed_root:
            # rename(2) is allowed to update only the root directory ctime.
            left = before[name]; right = after[name]
            if left[:5] != right[:5] or left[6:] != right[6:]:
                refuse("published release root authority changed beyond rename ctime")
        elif before[name] != after[name]:
            refuse(f"release tree authority changed: {name}")


def renamed_identity(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_nlink, value.st_uid, value.st_gid,
            stat.S_IMODE(value.st_mode))


IN_MODIFY = 0x00000002
IN_ATTRIB = 0x00000004
IN_CLOSE_WRITE = 0x00000008
IN_MOVED_FROM = 0x00000040
IN_MOVED_TO = 0x00000080
IN_CREATE = 0x00000100
IN_DELETE = 0x00000200
IN_DELETE_SELF = 0x00000400
IN_MOVE_SELF = 0x00000800
IN_UNMOUNT = 0x00002000
IN_Q_OVERFLOW = 0x00004000
IN_ISDIR = 0x40000000
WATCH_MASK = (IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_MOVED_FROM |
              IN_MOVED_TO | IN_CREATE | IN_DELETE | IN_DELETE_SELF |
              IN_MOVE_SELF | IN_UNMOUNT | IN_Q_OVERFLOW)


def retirement_checkpoint(_label: str, _parent: int, _root: int) -> None:
    """Deterministic race-injection seam; production deliberately does nothing."""


class RetirementAuthority:
    """Held inventory for a linearizable content-addressed retirement receipt.

    The final verified watcher drain is the transaction-commit point.  The
    receipt records what moved at that point; its mutable pathname must be
    reopened nofollow and its inventory recomputed by every later reader.
    """

    def __init__(self, root: int):
        self.root = root; self.root_meta = os.fstat(root)
        if (not stat.S_ISDIR(self.root_meta.st_mode) or
                (self.root_meta.st_uid, self.root_meta.st_gid,
                 stat.S_IMODE(self.root_meta.st_mode)) !=
                (os.getuid(), os.getgid(), 0o700)):
            refuse("release retirement root metadata is unsafe")
        self.directories: list[tuple[str, int | None, str | None, int,
                                     os.stat_result, tuple[str, ...], bool]] = []
        self.files: list[tuple[str, int, int, str, os.stat_result, str]] = []
        self.owned: list[int] = []
        try:
            self._walk(root, "", self.root_meta, True, None, None)
        except BaseException:
            self.close()
            raise
        rows: list[dict[str, object]] = []
        for path, _, _, _, metadata, _, _ in self.directories:
            rows.append({"identity": list(renamed_identity(metadata)),
                         "kind": "directory", "path": path or "."})
        for path, _, _, _, metadata, digest in self.files:
            rows.append({"identity": list(renamed_identity(metadata)),
                         "kind": "file", "path": path, "sha256": digest})
        payload = json.dumps(sorted(rows, key=lambda row: str(row["path"])),
                             sort_keys=True, separators=(",", ":"),
                             ensure_ascii=False).encode()
        self.digest = hashlib.sha256(payload).hexdigest()

    def _walk(self, directory: int, relative: str, metadata: os.stat_result,
              borrowed: bool, parent: int | None, basename: str | None) -> None:
        names = tuple(sorted(os.listdir(directory))); direct_directories = 0
        self.directories.append((relative, parent, basename, directory,
                                 metadata, names, borrowed))
        for name in names:
            if not name or name in (".", "..") or "/" in name:
                refuse("release retirement contains an unsafe name")
            child_relative = f"{relative}/{name}" if relative else name
            before = os.stat(name, dir_fd=directory, follow_symlinks=False)
            mode = stat.S_IMODE(before.st_mode)
            if stat.S_ISDIR(before.st_mode):
                direct_directories += 1
                if ((before.st_uid, before.st_gid) != (os.getuid(), os.getgid()) or
                        mode not in (0o700, 0o755)):
                    refuse("release retirement contains an unsafe directory")
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=directory)
                if identity(os.fstat(child)) != identity(before):
                    os.close(child); refuse("release retirement directory moved before hold")
                self.owned.append(child)
                self._walk(child, child_relative, before, False, directory, name)
            elif stat.S_ISREG(before.st_mode):
                if ((before.st_uid, before.st_gid, before.st_nlink) !=
                        (os.getuid(), os.getgid(), 1) or
                        mode not in (0o600, 0o644, 0o755)):
                    refuse("release retirement contains an unsafe file")
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                if identity(os.fstat(child)) != identity(before):
                    os.close(child); refuse("release retirement file moved before hold")
                self.owned.append(child)
                self.files.append((child_relative, directory, child, name,
                                   before, hash_fd(child, before)))
            else:
                refuse("release retirement contains a link or special object")
        if metadata.st_nlink != 2 + direct_directories:
            refuse("release retirement directory link count is unsafe")

    def descriptors(self) -> list[int]:
        return [value[3] for value in self.directories] + [value[2] for value in self.files]

    def revalidate(self, parent: int, top_name: str, *, renamed_root: bool) -> None:
        expected = (renamed_identity(self.root_meta) if renamed_root
                    else identity(self.root_meta))
        top = os.stat(top_name, dir_fd=parent, follow_symlinks=False)
        if ((renamed_identity(top) if renamed_root else identity(top)) != expected or
                (renamed_identity(os.fstat(self.root)) if renamed_root
                 else identity(os.fstat(self.root))) != expected):
            refuse("release retirement root name changed")
        for path, parent_fd, basename, descriptor, metadata, names, is_root in self.directories:
            current = os.fstat(descriptor)
            if ((is_root and renamed_root and
                 renamed_identity(current) != renamed_identity(metadata)) or
                    (not (is_root and renamed_root) and identity(current) != identity(metadata)) or
                    tuple(sorted(os.listdir(descriptor))) != names):
                refuse(f"release retirement directory changed: {path or '.'}")
            if not is_root and identity(os.stat(str(basename), dir_fd=parent_fd,
                                                follow_symlinks=False)) != identity(metadata):
                refuse(f"release retirement directory name changed: {path}")
        for path, parent_fd, descriptor, name, metadata, digest in self.files:
            if (identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) !=
                    identity(metadata) or identity(os.fstat(descriptor)) != identity(metadata) or
                    hash_fd(descriptor, metadata) != digest):
                refuse(f"release retirement file changed: {path}")

    def close(self) -> None:
        for descriptor in reversed(self.owned):
            try: os.close(descriptor)
            except OSError: pass


class RetirementMonitor:
    def __init__(self, parent: int, authority: RetirementAuthority):
        library = ctypes.CDLL(None, use_errno=True)
        initializer = getattr(library, "inotify_init1", None)
        self.add_watch = getattr(library, "inotify_add_watch", None)
        if initializer is None or self.add_watch is None:
            refuse("kernel retirement watches are unavailable")
        self.fd = initializer(os.O_CLOEXEC | os.O_NONBLOCK)
        if self.fd < 0:
            error = ctypes.get_errno(); raise OSError(error, os.strerror(error))
        self.parent_watch = self._add(parent); self.root_watch = -1
        for descriptor in authority.descriptors():
            watch = self._add(descriptor)
            if descriptor == authority.root: self.root_watch = watch

    def _add(self, descriptor: int) -> int:
        watch = self.add_watch(self.fd, os.fsencode(f"/proc/self/fd/{descriptor}"), WATCH_MASK)
        if watch < 0:
            error = ctypes.get_errno(); self.close(); raise OSError(error, os.strerror(error))
        return watch

    def events(self) -> list[tuple[int, int, int, str]]:
        result = []
        while True:
            try: payload = os.read(self.fd, 1024 * 1024)
            except BlockingIOError: break
            if not payload: break
            offset = 0
            while offset < len(payload):
                watch, mask, cookie, length = struct.unpack_from("iIII", payload, offset)
                raw = payload[offset + 16:offset + 16 + length]
                result.append((watch, mask & ~IN_ISDIR, cookie,
                               os.fsdecode(raw.split(b"\0", 1)[0])))
                offset += 16 + length
        return result

    def expect_rename(self, source: str, destination: str) -> None:
        moved_from = moved_to = None; root_move = 0
        for watch, mask, cookie, name in self.events():
            if watch == self.parent_watch and mask == IN_MOVED_FROM and name == source:
                moved_from = cookie
            elif watch == self.parent_watch and mask == IN_MOVED_TO and name == destination:
                moved_to = cookie
            elif watch == self.root_watch and mask == IN_MOVE_SELF and not name:
                root_move += 1
            else:
                refuse("unexpected filesystem event during release retirement")
        if not moved_from or moved_from != moved_to or root_move != 1:
            refuse("kernel did not attest the exact release retirement rename")

    def assert_quiet(self) -> None:
        if self.events(): refuse("unexpected filesystem event after release retirement")

    def close(self) -> None:
        if getattr(self, "fd", -1) >= 0:
            os.close(self.fd); self.fd = -1


def retire_named_tree(parent: int, name: str, held: int,
                      expected: os.stat_result) -> str:
    authority: RetirementAuthority | None = None
    monitor: RetirementMonitor | None = None
    retired = ""
    try:
        authority = RetirementAuthority(held)
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if identity(current) != identity(expected) or identity(os.fstat(held)) != identity(expected):
            refuse("release staging authority changed before retirement watches")
        retired = f".release-retired-{authority.digest[:32]}"
        monitor = RetirementMonitor(parent, authority)
        authority.revalidate(parent, name, renamed_root=False); monitor.assert_quiet()
        retirement_checkpoint("before-quarantine", parent, held)
        authority.revalidate(parent, name, renamed_root=False); monitor.assert_quiet()
        rename_no_replace(parent, name, parent, retired)
        retirement_checkpoint("after-quarantine", parent, held)
        monitor.expect_rename(name, retired)
        authority.revalidate(parent, retired, renamed_root=True); os.fsync(parent)
        retirement_checkpoint("before-final-proof", parent, held)
        authority.revalidate(parent, retired, renamed_root=True); monitor.assert_quiet()
        retirement_checkpoint("after-final-proof", parent, held)
        authority.revalidate(parent, retired, renamed_root=True); monitor.assert_quiet()
        retirement_checkpoint("before-return", parent, held)
        authority.revalidate(parent, retired, renamed_root=True); monitor.assert_quiet()
        retirement_checkpoint("transaction-close", parent, held)
        authority.revalidate(parent, retired, renamed_root=True); monitor.assert_quiet()
        # LINEARIZATION POINT: this final complete drain commits only the
        # content-addressed inventory receipt, never continued ownership of a
        # same-UID-writable pathname.  Later access must reproduce the receipt.
        retirement_checkpoint("transaction-commit", parent, held)
        retirement_checkpoint("post-commit", parent, held)
        return retired
    finally:
        if monitor is not None: monitor.close()
        if authority is not None: authority.close()


def verify_retirement_receipt(parent: int, receipt: str) -> str:
    """Reopen and reproduce a release-store retirement receipt before use."""
    prefix = ".release-retired-"
    suffix = receipt.removeprefix(prefix) if receipt.startswith(prefix) else ""
    if (len(suffix) != 32 or
            any(value not in "0123456789abcdef" for value in suffix)):
        refuse("release retirement receipt name is invalid")
    held = os.open(receipt, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                   dir_fd=parent)
    authority: RetirementAuthority | None = None
    try:
        authority = RetirementAuthority(held)
        authority.revalidate(parent, receipt, renamed_root=False)
        if authority.digest[:32] != suffix:
            refuse("release retirement receipt differs from current bytes")
        return authority.digest
    finally:
        if authority is not None: authority.close()
        os.close(held)


def quarantine_failed_name(parent: int, name: str,
                           expected_inode: tuple[int, int]) -> None:
    try:
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if (current.st_dev, current.st_ino) != expected_inode:
        refuse("failed release name contains a foreign substitute")
    held = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                   dir_fd=parent)
    try:
        retire_named_tree(parent, name, held, current)
    finally:
        os.close(held)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--candidate-id", required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--record", required=True)
    arguments = parser.parse_args()
    if arguments.root != REMOTE_ROOT or not SHA256.fullmatch(arguments.candidate_id) or not SHA256.fullmatch(arguments.release_id):
        refuse("root, candidate ID, or release ID is invalid")
    if (os.path.dirname(arguments.record) != f"{REMOTE_ROOT}/deployments" or
            not re.fullmatch(r"[A-Za-z0-9._-]{8,96}", os.path.basename(arguments.record))):
        refuse("deployment record is outside the protected store")

    root = open_absolute(REMOTE_ROOT)
    descriptors = [root]
    publication_holds: list[tuple[str, int, os.stat_result, str | None]] = []
    staging_fd: int | None = None
    releases: int | None = None
    staging_name = f".{arguments.release_id}.incoming"
    try:
        require_managed_directory(root, "remote root")
        candidate_store, _ = open_child_directory(root, "release-candidates", "candidate store")
        releases, _ = open_child_directory(root, "releases", "release store")
        manifests, _ = open_child_directory(root, "manifests", "manifest store")
        packages, _ = open_child_directory(root, "packages", "package store")
        deployments, _ = open_child_directory(root, "deployments", "deployment store")
        record, _ = open_child_directory(deployments, os.path.basename(arguments.record),
                                         "deployment record")
        candidate, candidate_meta = open_child_directory(candidate_store, arguments.candidate_id,
                                                         "candidate", flat=True)
        descriptors.extend((candidate_store, releases, manifests, packages,
                            deployments, record, candidate))
        held: dict[str, tuple[int, os.stat_result]] = {}
        for name, maximum in MAXIMUMS.items():
            held[name] = open_regular(candidate, name, maximum)
            descriptors.append(held[name][0])
        held_authority = {name: (identity(metadata), hash_fd(descriptor, metadata))
                          for name, (descriptor, metadata) in held.items()}

        def require_held_inputs() -> None:
            for name, (descriptor, metadata) in held.items():
                expected_identity, expected_digest = held_authority[name]
                if (identity(os.fstat(descriptor)) != expected_identity or
                        hash_fd(descriptor, metadata) != expected_digest):
                    refuse(f"held candidate input changed through use: {name}")

        descriptor_bytes = read_fd(*held["candidate.json"])
        try:
            descriptor = json.loads(descriptor_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError):
            refuse("candidate descriptor is invalid JSON")
        body = descriptor.get("body") if isinstance(descriptor, dict) else None
        if (not isinstance(body, dict) or descriptor_bytes != canonical(descriptor) + b"\n" or
                descriptor.get("schema") != "revival.release-candidate" or
                descriptor.get("schemaVersion") != 4 or
                descriptor.get("candidateId") != arguments.candidate_id or
                hashlib.sha256(canonical(body)).hexdigest() != arguments.candidate_id or
                not isinstance(body.get("release"), dict) or
                body["release"].get("id") != arguments.release_id):
            refuse("candidate descriptor does not bind the requested publication")
        if body.get("authority") != {
                "origin": "github-hosted-actions",
                "productionUse": "requires-point-of-use-provider-evidence"}:
            refuse("candidate is not eligible for production publication")
        file_inventory = body.get("files")
        if not isinstance(file_inventory, list):
            refuse("candidate descriptor file inventory is invalid")
        inventory = {item.get("role"): item for item in file_inventory if isinstance(item, dict)}
        for role, name in (("release-archive", "release.tar.gz"),
                           ("release-manifest", "release.manifest.json"),
                           ("release-verifier", "verify-release.py")):
            entry = inventory.get(role)
            descriptor_fd, metadata = held[name]
            if (not isinstance(entry, dict) or entry.get("size") != metadata.st_size or
                    entry.get("sha256") != hash_fd(descriptor_fd, metadata)):
                refuse(f"held {role} differs from the candidate descriptor")

        manifest_data = read_fd(*held["release.manifest.json"])
        try:
            manifest_value = json.loads(manifest_data)
        except (UnicodeDecodeError, json.JSONDecodeError):
            refuse("release manifest is invalid JSON")
        manifest_payload = ({"schemaVersion": manifest_value.get("schemaVersion"),
                             "profile": manifest_value.get("profile"),
                             "entries": manifest_value.get("entries")}
                            if isinstance(manifest_value, dict) else None)
        if (not isinstance(manifest_value, dict) or
                set(manifest_value) != {"schemaVersion", "profile", "releaseId", "entries"} or
                manifest_value.get("schemaVersion") != 1 or manifest_value.get("profile") != "vps" or
                manifest_value.get("releaseId") != arguments.release_id or
                hashlib.sha256(json.dumps(manifest_payload, separators=(",", ":"),
                                          ensure_ascii=False).encode()).hexdigest() != arguments.release_id):
            refuse("release manifest does not bind the requested release")

        verifier_fd = held["verify-release.py"][0]
        archive_fd = held["release.tar.gz"][0]
        manifest_fd = held["release.manifest.json"][0]
        verifier_arguments = ["--archive", descriptor_path(archive_fd),
                              "--manifest", descriptor_path(manifest_fd),
                              "--expect-release-id", arguments.release_id]
        try:
            destination_meta = os.stat(arguments.release_id, dir_fd=releases,
                                       follow_symlinks=False)
        except FileNotFoundError:
            destination_meta = None
        if destination_meta is None:
            try:
                os.mkdir(staging_name, 0o700, dir_fd=releases)
            except FileExistsError:
                refuse("stale incoming release staging directory exists")
            staging_fd, _ = open_child_directory(releases, staging_name,
                                                 "incoming release", flat=True)
            descriptors.append(staging_fd)
            archive_result = run_verifier(verifier_fd, [*verifier_arguments,
                "--extract", descriptor_path(staging_fd, "tree")])
            validate_verification(archive_result, arguments.release_id)
            tree, tree_meta = open_child_directory(staging_fd, "tree", "extracted release")
            descriptors.append(tree)
            tree_result = run_verifier(verifier_fd, ["--tree", descriptor_path(tree),
                "--manifest", descriptor_path(manifest_fd),
                "--expect-release-id", arguments.release_id])
            validate_verification(tree_result, arguments.release_id)
            tree_authority = verify_tree_metadata(tree, manifest_value, publication_holds)
            if identity(os.fstat(tree)) != identity(tree_meta):
                refuse("extracted release moved before publication")
            require_same_child(staging_fd, "tree", tree_meta, "extracted release")
            require_same_tree(tree_authority, verify_tree_metadata(tree, manifest_value), renamed_root=False)
            moved_release = False
            try:
                rename_no_replace(staging_fd, "tree", releases, arguments.release_id)
                moved_release = True
                published_meta = os.stat(arguments.release_id, dir_fd=releases, follow_symlinks=False)
                if (published_meta.st_dev, published_meta.st_ino) != (tree_meta.st_dev, tree_meta.st_ino):
                    refuse("published release identity differs from the verified tree")
                require_same_tree(tree_authority, verify_tree_metadata(tree, manifest_value), renamed_root=True)
                require_held_tree(publication_holds)
                require_same_child(releases, arguments.release_id, published_meta, "published release")
                os.fsync(releases)
            except BaseException as error:
                if moved_release:
                    try:
                        quarantine_failed_name(releases, arguments.release_id,
                                               (tree_meta.st_dev, tree_meta.st_ino))
                    except BaseException:
                        pass
                elif isinstance(error, OSError) and error.errno == errno.EEXIST:
                    refuse("release destination appeared during no-replace publication")
                raise
            retire_named_tree(releases, staging_name, staging_fd,
                              os.fstat(staging_fd))
            staging_fd = None
            archive_state = "published"
        else:
            if not stat.S_ISDIR(destination_meta.st_mode):
                refuse("release destination is not a directory")
            tree, tree_meta = open_child_directory(releases, arguments.release_id,
                                                   "retained release")
            descriptors.append(tree)
            archive_result = run_verifier(verifier_fd, verifier_arguments)
            validate_verification(archive_result, arguments.release_id)
            tree_result = run_verifier(verifier_fd, ["--tree", descriptor_path(tree),
                "--manifest", descriptor_path(manifest_fd),
                "--expect-release-id", arguments.release_id])
            validate_verification(tree_result, arguments.release_id)
            retained_authority = verify_tree_metadata(tree, manifest_value)
            require_same_tree(retained_authority, verify_tree_metadata(tree, manifest_value), renamed_root=False)
            if identity(os.fstat(tree)) != identity(tree_meta):
                refuse("retained release moved during verification")
            require_same_child(releases, arguments.release_id, tree_meta, "retained release")
            archive_state = "existing"

        if identity(os.fstat(candidate)) != identity(candidate_meta):
            refuse("candidate moved during release publication")
        require_held_inputs()
        require_held_tree(publication_holds)
        publish_file(*held["release.manifest.json"], manifests,
                     f"{arguments.release_id}.json")
        publish_file(*held["release.tar.gz"], packages,
                     f"{arguments.release_id}.tar.gz")
        verification = canonical(archive_result) + b"\n" + canonical(tree_result) + b"\n"
        write_once(record, "package-verification.json", verification)
        require_held_inputs()
        # Artifact and evidence publication can take long enough for an
        # adversarial same-UID rename.  Re-walk every published release name
        # against the pre-rename authority immediately before reporting it
        # eligible for pointer visibility.
        final_authority = tree_authority if archive_state == "published" else retained_authority
        require_same_tree(final_authority, verify_tree_metadata(tree, manifest_value),
                          renamed_root=(archive_state == "published"))
        require_held_tree(publication_holds)
        current_release = os.stat(arguments.release_id, dir_fd=releases,
                                  follow_symlinks=False)
        if ((current_release.st_dev, current_release.st_ino) !=
                (tree_meta.st_dev, tree_meta.st_ino)):
            refuse("release name changed before publication acknowledgement")
        print(json.dumps({"ok": True, "state": archive_state,
                          "releaseId": arguments.release_id},
                         sort_keys=True, separators=(",", ":")))
    finally:
        for _, descriptor, _, _ in reversed(publication_holds):
            try:
                os.close(descriptor)
            except OSError:
                pass
        if staging_fd is not None and releases is not None:
            try:
                retire_named_tree(releases, staging_name, staging_fd,
                                  os.fstat(staging_fd))
            except (OSError, SystemExit):
                pass
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


if __name__ == "__main__":
    main()
