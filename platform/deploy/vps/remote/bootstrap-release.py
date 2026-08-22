#!/usr/bin/env python3
"""Extract the first release driver with held, no-follow filesystem authority.

This helper is streamed by the local deployment bootstrap.  It does not execute
candidate code.  It holds the candidate archive/manifest/verifier, independently
reproduces the release ID and every archive entry, builds an owner-only tree via
dirfds, and publishes that exact inode with RENAME_NOREPLACE.  The manifest-held
release executor takes over immediately after this bootstrap boundary.
"""

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
import tarfile


REMOTE_ROOT = "/home/anders/ai-pin-revival"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_MANIFEST = 16 * 1024 * 1024
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_EXTRACTED = 1024 * 1024 * 1024
REQUIRED_PROTOCOL = {
    "platform/deploy/release-candidate.mjs",
    "platform/deploy/vps/verify-release.py",
    "platform/deploy/vps/remote/bootstrap-release.py",
    "platform/deploy/vps/remote/candidate-authority-exec.py",
    "platform/deploy/vps/remote/common.sh",
    "platform/deploy/vps/remote/deploy.sh",
    "platform/deploy/vps/remote/held-release-exec.py",
}


def refuse(message: str) -> "NoReturn":
    raise SystemExit(f"release bootstrap refusal: {message}")


def identity(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_nlink, value.st_uid, value.st_gid,
            stat.S_IMODE(value.st_mode))


def stable_inode(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_nlink, value.st_uid,
            value.st_gid, stat.S_IMODE(value.st_mode))


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
            os.close(descriptor); descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def require_directory(descriptor: int, label: str) -> os.stat_result:
    value = os.fstat(descriptor)
    if (not stat.S_ISDIR(value.st_mode) or
            (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode)) !=
            (os.getuid(), os.getgid(), 0o700)):
        refuse(f"{label} directory metadata is unsafe")
    return value


def open_child_directory(parent: int, name: str, label: str) -> tuple[int, os.stat_result]:
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         dir_fd=parent)
    opened = require_directory(descriptor, label)
    if identity(opened) != identity(before):
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
    result = bytearray(); offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("held input was truncated")
        result.extend(block); offset += len(block)
    if identity(os.fstat(descriptor)) != identity(metadata):
        refuse("held input changed while reading")
    return bytes(result)


def hash_fd(descriptor: int, metadata: os.stat_result) -> str:
    digest = hashlib.sha256(); offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("held file was truncated while hashing")
        digest.update(block); offset += len(block)
    if identity(os.fstat(descriptor)) != identity(metadata):
        refuse("held file changed while hashing")
    return digest.hexdigest()


def parse_manifest(payload: bytes, expected_id: str) -> tuple[dict, dict[str, dict]]:
    try:
        manifest = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        refuse("release manifest is invalid JSON")
    if not isinstance(manifest, dict) or set(manifest) != {
            "schemaVersion", "profile", "releaseId", "entries"}:
        refuse("release manifest schema is invalid")
    body = {"schemaVersion": manifest.get("schemaVersion"),
            "profile": manifest.get("profile"), "entries": manifest.get("entries")}
    canonical = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
    if (manifest.get("schemaVersion") != 1 or manifest.get("profile") != "vps" or
            manifest.get("releaseId") != expected_id or
            hashlib.sha256(canonical).hexdigest() != expected_id):
        refuse("release manifest does not reproduce the requested release ID")
    entries: dict[str, dict] = {}
    if not isinstance(manifest["entries"], list) or not manifest["entries"]:
        refuse("release manifest inventory is empty")
    for entry in manifest["entries"]:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "size", "mode"}:
            refuse("release manifest entry schema is invalid")
        name = entry.get("path")
        if (not isinstance(name, str) or not name or name.startswith("/") or "\\" in name or
                any(part in ("", ".", "..") for part in name.split("/")) or name in entries or
                entry.get("mode") not in ("0644", "0755") or
                not isinstance(entry.get("size"), int) or isinstance(entry.get("size"), bool) or
                entry["size"] < 0 or not SHA256.fullmatch(str(entry.get("sha256")))):
            refuse("release manifest entry is unsafe")
        entries[name] = entry
    if not REQUIRED_PROTOCOL <= set(entries):
        refuse("release omits bootstrap protocol material")
    return manifest, entries


def expected_children(entries: dict[str, dict], relative: str) -> dict[str, str]:
    prefix = f"{relative}/" if relative else ""
    result: dict[str, str] = {}
    for path in entries:
        if not path.startswith(prefix):
            continue
        remainder = path[len(prefix):]
        child, separator, _ = remainder.partition("/")
        kind = "directory" if separator else "file"
        if child in result and result[child] != kind:
            refuse("release inventory contains a file/directory collision")
        result[child] = kind
    return result


def hold_tree(root: int, entries: dict[str, dict]) -> tuple[
        dict[str, tuple[int, os.stat_result, str]],
        list[tuple[int, os.stat_result, str]]]:
    uid = os.getuid(); gid = os.getgid()
    files: dict[str, tuple[int, os.stat_result, str]] = {}
    directories: list[tuple[int, os.stat_result, str]] = []

    def walk(directory: int, relative: str) -> None:
        wanted = expected_children(entries, relative)
        if set(os.listdir(directory)) != set(wanted):
            refuse("release tree has an extra or missing entry")
        direct_directories = 0
        for name in sorted(wanted):
            child_relative = f"{relative}/{name}" if relative else name
            before = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if wanted[name] == "directory":
                direct_directories += 1
                if (not stat.S_ISDIR(before.st_mode) or
                        (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) !=
                        (uid, gid, 0o700)):
                    refuse("release tree directory metadata is unsafe")
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
                    refuse("release tree file metadata is unsafe")
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                opened = os.fstat(child)
                if identity(opened) != identity(before):
                    os.close(child); refuse("release file moved before open")
                digest = hash_fd(child, opened)
                if digest != entry["sha256"]:
                    os.close(child); refuse("release tree digest differs from manifest")
                files[child_relative] = (child, opened, digest)
        value = os.fstat(directory)
        if (not stat.S_ISDIR(value.st_mode) or
                (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink) !=
                (uid, gid, 0o700, 2 + direct_directories)):
            refuse("release tree directory authority is unsafe")

    root_meta = os.fstat(root)
    directories.append((root, root_meta, ".")); walk(root, "")
    return files, directories


def revalidate_tree(files: dict[str, tuple[int, os.stat_result, str]],
                    directories: list[tuple[int, os.stat_result, str]],
                    *, root_rename: bool = False) -> None:
    directory_map = {name: descriptor for descriptor, _, name in directories}
    children: dict[str, set[str]] = {name: set() for name in directory_map}
    for name in [*directory_map, *files]:
        if name == ".":
            continue
        parent = os.path.dirname(name) or "."
        children.setdefault(parent, set()).add(os.path.basename(name))
    for descriptor, before, name in directories:
        after = os.fstat(descriptor)
        if ((root_rename and name == "." and stable_inode(after) != stable_inode(before)) or
                (not (root_rename and name == ".") and identity(after) != identity(before))):
            refuse("held release directory changed")
        if set(os.listdir(descriptor)) != children.get(name, set()):
            refuse("held release directory inventory changed")
    for name, (descriptor, before, digest) in files.items():
        if identity(os.fstat(descriptor)) != identity(before) or hash_fd(descriptor, before) != digest:
            refuse(f"held release file changed: {name}")


def rename_no_replace(source_parent: int, source: str, destination_parent: int,
                      destination: str) -> None:
    function = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
    if function is None:
        refuse("renameat2 is unavailable")
    if function(source_parent, os.fsencode(source), destination_parent,
                os.fsencode(destination), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def ensure_directory(root: int, parts: list[str]) -> int:
    current = os.dup(root)
    try:
        for name in parts:
            try:
                os.mkdir(name, 0o700, dir_fd=current)
            except FileExistsError:
                pass
            before = os.stat(name, dir_fd=current, follow_symlinks=False)
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=current)
            opened = os.fstat(child)
            if (identity(opened) != identity(before) or
                    (opened.st_uid, opened.st_gid, stat.S_IMODE(opened.st_mode)) !=
                    (os.getuid(), os.getgid(), 0o700)):
                os.close(child); refuse("extraction directory authority changed")
            os.close(current); current = child
        return current
    except BaseException:
        os.close(current); raise


def extract_archive(archive: int, archive_meta: os.stat_result, staging: int,
                    entries: dict[str, dict]) -> None:
    seen: list[str] = []; total = 0
    stream = os.fdopen(os.dup(archive), "rb", closefd=True)
    try:
        try:
            bundle = tarfile.open(fileobj=stream, mode="r:gz")
        except (OSError, tarfile.TarError):
            refuse("release archive cannot be opened")
        with bundle:
            for member in bundle:
                name = member.name
                if (not member.isreg() or name not in entries or name in seen or
                        name.startswith("/") or "\\" in name or
                        any(part in ("", ".", "..") for part in name.split("/"))):
                    refuse("release archive contains an unexpected member")
                entry = entries[name]
                if member.size != entry["size"] or stat.S_IMODE(member.mode) != int(entry["mode"], 8):
                    refuse("release archive metadata differs from manifest")
                total += member.size
                if total > MAX_EXTRACTED:
                    refuse("release archive exceeds the extraction limit")
                parent = ensure_directory(staging, name.split("/")[:-1])
                output = -1
                try:
                    output = os.open(name.split("/")[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                                     os.O_NOFOLLOW, int(entry["mode"], 8), dir_fd=parent)
                    os.fchmod(output, int(entry["mode"], 8))
                    digest = hashlib.sha256(); source = bundle.extractfile(member)
                    if source is None:
                        refuse("release archive member cannot be read")
                    try:
                        while True:
                            block = source.read(1024 * 1024)
                            if not block:
                                break
                            digest.update(block); offset = 0
                            while offset < len(block):
                                offset += os.write(output, block[offset:])
                    finally:
                        source.close()
                    os.fsync(output)
                    if digest.hexdigest() != entry["sha256"]:
                        refuse("release archive member digest differs from manifest")
                finally:
                    if output >= 0:
                        os.close(output)
                    os.close(parent)
                seen.append(name)
        if seen != list(entries):
            refuse("release archive inventory differs from manifest")
        if identity(os.fstat(archive)) != identity(archive_meta):
            refuse("held release archive changed during extraction")
    finally:
        stream.close()


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

    Success records the exact tree at the final verified watcher drain.  It
    does not make a same-UID-writable pathname immutable; every later reader
    must reopen nofollow and reproduce the returned receipt.
    """

    def __init__(self, root: int):
        self.root = root; self.root_meta = os.fstat(root)
        if (not stat.S_ISDIR(self.root_meta.st_mode) or
                (self.root_meta.st_uid, self.root_meta.st_gid,
                 stat.S_IMODE(self.root_meta.st_mode)) !=
                (os.getuid(), os.getgid(), 0o700)):
            refuse("bootstrap retirement root metadata is unsafe")
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
                refuse("bootstrap retirement contains an unsafe name")
            child_relative = f"{relative}/{name}" if relative else name
            value = os.stat(name, dir_fd=directory, follow_symlinks=False)
            mode = stat.S_IMODE(value.st_mode)
            if stat.S_ISDIR(value.st_mode):
                direct_directories += 1
                if ((value.st_uid, value.st_gid, mode) !=
                        (os.getuid(), os.getgid(), 0o700)):
                    refuse("bootstrap retirement contains an unsafe directory")
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=directory)
                if identity(os.fstat(child)) != identity(value):
                    os.close(child); refuse("bootstrap retirement directory moved before hold")
                self.owned.append(child)
                self._walk(child, child_relative, value, False, directory, name)
            elif stat.S_ISREG(value.st_mode):
                if ((value.st_uid, value.st_gid, value.st_nlink) !=
                        (os.getuid(), os.getgid(), 1) or
                        mode not in (0o600, 0o644, 0o755)):
                    refuse("bootstrap retirement contains an unsafe file")
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                if identity(os.fstat(child)) != identity(value):
                    os.close(child); refuse("bootstrap retirement file moved before hold")
                self.owned.append(child)
                self.files.append((child_relative, directory, child, name,
                                   value, hash_fd(child, value)))
            else:
                refuse("bootstrap retirement contains a link or special object")
        if metadata.st_nlink != 2 + direct_directories:
            refuse("bootstrap retirement directory link count is unsafe")

    def descriptors(self) -> list[int]:
        return [value[3] for value in self.directories] + [value[2] for value in self.files]

    def revalidate(self, parent: int, top_name: str, *, renamed_root: bool) -> None:
        expected = (renamed_identity(self.root_meta) if renamed_root
                    else identity(self.root_meta))
        top = os.stat(top_name, dir_fd=parent, follow_symlinks=False)
        if ((renamed_identity(top) if renamed_root else identity(top)) != expected or
                (renamed_identity(os.fstat(self.root)) if renamed_root
                 else identity(os.fstat(self.root))) != expected):
            refuse("bootstrap retirement root name changed")
        for path, parent_fd, basename, descriptor, metadata, names, is_root in self.directories:
            current = os.fstat(descriptor)
            if ((is_root and renamed_root and
                 renamed_identity(current) != renamed_identity(metadata)) or
                    (not (is_root and renamed_root) and identity(current) != identity(metadata)) or
                    tuple(sorted(os.listdir(descriptor))) != names):
                refuse(f"bootstrap retirement directory changed: {path or '.'}")
            if not is_root and identity(os.stat(str(basename), dir_fd=parent_fd,
                                                follow_symlinks=False)) != identity(metadata):
                refuse(f"bootstrap retirement directory name changed: {path}")
        for path, parent_fd, descriptor, name, metadata, digest in self.files:
            if (identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) !=
                    identity(metadata) or identity(os.fstat(descriptor)) != identity(metadata) or
                    hash_fd(descriptor, metadata) != digest):
                refuse(f"bootstrap retirement file changed: {path}")

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
                refuse("unexpected filesystem event during bootstrap retirement")
        if not moved_from or moved_from != moved_to or root_move != 1:
            refuse("kernel did not attest the exact bootstrap retirement rename")

    def assert_quiet(self) -> None:
        if self.events(): refuse("unexpected filesystem event after bootstrap retirement")

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
            refuse("bootstrap staging authority changed before retirement watches")
        retired = f".bootstrap-retired-{authority.digest[:32]}"
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
        # LINEARIZATION POINT: the complete watcher drain above commits the
        # receipt.  A later mutation is rejected by receipt verification; it
        # does not retroactively change this historical inventory fact.
        retirement_checkpoint("transaction-commit", parent, held)
        retirement_checkpoint("post-commit", parent, held)
        return retired
    finally:
        if monitor is not None: monitor.close()
        if authority is not None: authority.close()


def verify_retirement_receipt(parent: int, receipt: str) -> str:
    """Reopen and reproduce a bootstrap retirement receipt before use."""
    prefix = ".bootstrap-retired-"
    suffix = receipt.removeprefix(prefix) if receipt.startswith(prefix) else ""
    if (len(suffix) != 32 or
            any(value not in "0123456789abcdef" for value in suffix)):
        refuse("bootstrap retirement receipt name is invalid")
    held = os.open(receipt, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                   dir_fd=parent)
    authority: RetirementAuthority | None = None
    try:
        authority = RetirementAuthority(held)
        authority.revalidate(parent, receipt, renamed_root=False)
        if authority.digest[:32] != suffix:
            refuse("bootstrap retirement receipt differs from current bytes")
        return authority.digest
    finally:
        if authority is not None: authority.close()
        os.close(held)


def close_tree(files: dict[str, tuple[int, os.stat_result, str]],
               directories: list[tuple[int, os.stat_result, str]], root: int) -> None:
    for descriptor, _, _ in files.values():
        try: os.close(descriptor)
        except OSError: pass
    for descriptor, _, _ in reversed(directories):
        if descriptor != root:
            try: os.close(descriptor)
            except OSError: pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--candidate-id", required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--driver-root", required=True)
    arguments = parser.parse_args()
    if not SHA256.fullmatch(arguments.candidate_id) or not SHA256.fullmatch(arguments.release_id):
        refuse("candidate or release identity is invalid")
    incoming = f"{REMOTE_ROOT}/incoming/{arguments.release_id}"
    transport = f"{incoming}/.candidate-{arguments.candidate_id}.partial"
    if (arguments.candidate != f"{transport}/{arguments.candidate_id}" or
            arguments.driver_root != f"{incoming}/verified-driver"):
        refuse("bootstrap paths do not match the requested identities")

    candidate = open_absolute(arguments.candidate)
    incoming_fd = open_absolute(incoming)
    held: list[tuple[int, os.stat_result]] = []
    staging = -1; staging_name = ""
    try:
        require_directory(candidate, "candidate")
        require_directory(incoming_fd, "incoming")
        archive, archive_meta = open_regular(candidate, "release.tar.gz", MAX_ARCHIVE)
        manifest_fd, manifest_meta = open_regular(candidate, "release.manifest.json", MAX_MANIFEST)
        verifier, verifier_meta = open_regular(candidate, "verify-release.py", 2 * 1024 * 1024)
        held.extend(((archive, archive_meta), (manifest_fd, manifest_meta), (verifier, verifier_meta)))
        _, entries = parse_manifest(read_fd(manifest_fd, manifest_meta), arguments.release_id)
        verifier_entry = entries["platform/deploy/vps/verify-release.py"]
        if (verifier_entry["size"] != verifier_meta.st_size or
                verifier_entry["sha256"] != hash_fd(verifier, verifier_meta)):
            refuse("candidate verifier copy differs from the release manifest")

        try:
            final, _ = open_child_directory(incoming_fd, "verified-driver", "existing driver")
        except FileNotFoundError:
            final = -1
        if final >= 0:
            files: dict[str, tuple[int, os.stat_result, str]] = {}; directories = []
            try:
                files, directories = hold_tree(final, entries)
                revalidate_tree(files, directories)
            finally:
                close_tree(files, directories, final); os.close(final)
            state = "existing"
        else:
            staging_name = f".verified-driver.{secrets.token_hex(12)}"
            os.mkdir(staging_name, 0o700, dir_fd=incoming_fd)
            staging, staging_meta = open_child_directory(incoming_fd, staging_name, "driver staging")
            try:
                extract_archive(archive, archive_meta, staging, entries)
                files, directories = hold_tree(staging, entries)
                try:
                    revalidate_tree(files, directories)
                    rename_no_replace(incoming_fd, staging_name, incoming_fd, "verified-driver")
                    current = os.stat("verified-driver", dir_fd=incoming_fd, follow_symlinks=False)
                    if (current.st_dev, current.st_ino) != (staging_meta.st_dev, staging_meta.st_ino):
                        refuse("published driver name does not resolve to the held inode")
                    revalidate_tree(files, directories, root_rename=True)
                    os.fsync(incoming_fd); staging_name = ""
                finally:
                    close_tree(files, directories, staging)
            except OSError as error:
                if error.errno != errno.EEXIST:
                    raise
                existing, _ = open_child_directory(incoming_fd, "verified-driver", "raced driver")
                try:
                    raced_files, raced_dirs = hold_tree(existing, entries)
                    try: revalidate_tree(raced_files, raced_dirs)
                    finally: close_tree(raced_files, raced_dirs, existing)
                finally: os.close(existing)
                retire_named_tree(incoming_fd, staging_name, staging, staging_meta)
                staging_name = ""
            state = "published"
        for descriptor, before in held:
            if identity(os.fstat(descriptor)) != identity(before):
                refuse("candidate input changed through bootstrap extraction")
        print(json.dumps({"ok": True, "releaseId": arguments.release_id, "state": state},
                         sort_keys=True, separators=(",", ":")))
    finally:
        if staging >= 0:
            if staging_name:
                try:
                    retire_named_tree(incoming_fd, staging_name, staging,
                                      os.fstat(staging))
                except (OSError, SystemExit):
                    pass
            os.close(staging)
        for descriptor, _ in reversed(held):
            try: os.close(descriptor)
            except OSError: pass
        os.close(candidate); os.close(incoming_fd)


if __name__ == "__main__":
    main()
