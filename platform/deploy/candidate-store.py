#!/usr/bin/env python3
"""Nofollow, descriptor-relative candidate workspace/store transactions."""

from __future__ import annotations

import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import secrets
import stat
import struct
import sys


EXPECTED_FILES = sorted([
    "candidate.json", "compose-model.json", "image-receipt.json", "images.tar", "production-state.json",
    "release.json", "release.manifest.json", "release.tar.gz", "source-commit.txt",
    "source-receipt.json", "source-snapshot.tar", "toolchain-receipt.json",
    "verify-release.py",
])
REMOTE_INCOMING_ROOT = "/home/anders/ai-pin-revival/incoming"


def refuse(message: str) -> "NoReturn":
    raise SystemExit(f"candidate store refusal: {message}")


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode()


def identity(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_nlink, value.st_uid, value.st_gid,
            stat.S_IMODE(value.st_mode))


def inode(value: os.stat_result) -> tuple[int, int]:
    return value.st_dev, value.st_ino


def rename_no_replace(source_parent: int, source: str,
                      destination_parent: int, destination: str) -> None:
    function = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
    if function is None:
        refuse("renameat2 is unavailable")
    if function(source_parent, os.fsencode(source), destination_parent,
                os.fsencode(destination), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def validate_name(name: str, prefix: str | None = None) -> str:
    if not name or "/" in name or name in (".", "..") or (prefix and not name.startswith(prefix)):
        refuse("managed child name is unsafe")
    return name


def open_absolute(path: str, create: bool) -> int:
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        refuse("managed root path is not canonical and absolute")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.split("/")[1:]:
            validate_name(component)
            try:
                before = os.stat(component, dir_fd=descriptor,
                                 follow_symlinks=False)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(component, 0o700, dir_fd=descriptor)
                os.fsync(descriptor)
                before = os.stat(component, dir_fd=descriptor,
                                 follow_symlinks=False)
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            if identity(os.fstat(child)) != identity(before):
                os.close(child)
                refuse("managed path component moved before open")
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def require_private_directory(descriptor: int, label: str,
                              *, exact_links: bool = False) -> os.stat_result:
    value = os.fstat(descriptor)
    if (not stat.S_ISDIR(value.st_mode) or
            (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode)) !=
            (os.getuid(), os.getgid(), 0o700) or
            (exact_links and value.st_nlink != 2)):
        refuse(f"{label} must be owner-owned mode 0700 with safe link count")
    return value


def open_held_parent(number: int = 3) -> tuple[int, os.stat_result]:
    try:
        descriptor = os.dup(number)
    except OSError:
        refuse("held parent descriptor is unavailable")
    return descriptor, require_private_directory(descriptor, "held parent")


def create_child(parent: int, name: str, *, exclusive: bool) -> tuple[int, int]:
    validate_name(name)
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
        os.fsync(parent)
    except FileExistsError:
        if exclusive:
            raise
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         dir_fd=parent)
    try:
        opened = require_private_directory(descriptor, "managed child")
        if identity(opened) != identity(before):
            refuse("managed child moved before open")
        return inode(opened)
    finally:
        os.close(descriptor)


def hash_fd(descriptor: int, metadata: os.stat_result) -> str:
    digest = hashlib.sha256(); offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("managed file was truncated")
        digest.update(block); offset += len(block)
    if identity(os.fstat(descriptor)) != identity(metadata):
        refuse("managed file changed while hashing")
    return digest.hexdigest()


def open_regular(parent: int, name: str) -> tuple[int, os.stat_result, str]:
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
            (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) !=
            (os.getuid(), os.getgid(), 0o600)):
        refuse(f"candidate file metadata is unsafe: {name}")
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    opened = os.fstat(descriptor)
    if identity(opened) != identity(before):
        os.close(descriptor)
        refuse(f"candidate file moved before open: {name}")
    return descriptor, opened, hash_fd(descriptor, opened)


def renamed_identity(value: os.stat_result) -> tuple[int, ...]:
    """Identity fields which rename(2) is not permitted to change.

    Linux updates ctime when an inode is renamed, so ctime is deliberately not
    in this tuple.  Size, mtime, link count, ownership, and mode remain bound.
    """
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_nlink, value.st_uid, value.st_gid,
            stat.S_IMODE(value.st_mode))


IN_ATTRIB = 0x00000004
IN_MODIFY = 0x00000002
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
WATCH_MASK = (IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_MOVED_FROM | IN_MOVED_TO |
              IN_CREATE | IN_DELETE | IN_DELETE_SELF | IN_MOVE_SELF |
              IN_UNMOUNT | IN_Q_OVERFLOW)


def retirement_checkpoint(_label: str, _parent: int, _root: int) -> None:
    """Deterministic race-injection seam; production deliberately does nothing."""


class RetirementAuthority:
    """Held byte-exact authority used to issue and later verify a receipt.

    A successful retirement is linearizable, not an ownership boundary against
    the same UID.  Its transaction-commit point is the final complete inotify
    drain after this authority has revalidated every held descriptor, name,
    metadata field, and digest.  The returned content-addressed name is the
    immutable fact.  A later consumer must reopen that name without following
    links and reproduce the receipt; the pathname itself is never authority.
    """

    def __init__(self, root: int, *, expected_mode: int = 0o700):
        root_meta = os.fstat(root)
        if (not stat.S_ISDIR(root_meta.st_mode) or
                (root_meta.st_uid, root_meta.st_gid,
                 stat.S_IMODE(root_meta.st_mode)) !=
                (os.getuid(), os.getgid(), expected_mode)):
            refuse("cleanup root metadata is unsafe")
        self.root = root
        self.root_meta = root_meta
        self.directories: list[tuple[str, int | None, str | None, int,
                                     os.stat_result, tuple[str, ...], bool]] = []
        self.files: list[tuple[str, int, int, str, os.stat_result, str]] = []
        self.owned: list[int] = []
        try:
            self._walk(root, "", root_meta, True, None, None)
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
        names = tuple(sorted(os.listdir(directory)))
        direct_directories = 0
        self.directories.append((relative, parent, basename, directory,
                                 metadata, names, borrowed))
        for name in names:
            validate_name(name)
            child_relative = f"{relative}/{name}" if relative else name
            before = os.stat(name, dir_fd=directory, follow_symlinks=False)
            mode = stat.S_IMODE(before.st_mode)
            if stat.S_ISDIR(before.st_mode):
                direct_directories += 1
                if ((before.st_uid, before.st_gid) != (os.getuid(), os.getgid()) or
                        mode not in (0o700, 0o755)):
                    refuse("cleanup encountered a foreign or writable directory")
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=directory)
                if identity(os.fstat(child)) != identity(before):
                    os.close(child); refuse("cleanup directory moved before hold")
                self.owned.append(child)
                self._walk(child, child_relative, before, False, directory, name)
            elif stat.S_ISREG(before.st_mode):
                if ((before.st_uid, before.st_gid, before.st_nlink) !=
                        (os.getuid(), os.getgid(), 1) or mode & 0o022):
                    refuse("cleanup encountered a foreign, writable, or hardlinked file")
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                if identity(os.fstat(child)) != identity(before):
                    os.close(child); refuse("cleanup file moved before hold")
                self.owned.append(child)
                self.files.append((child_relative, directory, child, name,
                                   before, hash_fd(child, before)))
            else:
                refuse("cleanup encountered a link or special object")
        if metadata.st_nlink != 2 + direct_directories:
            refuse("cleanup directory link count is unsafe")

    def descriptors(self) -> list[int]:
        return [value[3] for value in self.directories] + [value[2] for value in self.files]

    def revalidate(self, parent: int, top_name: str, *, renamed_root: bool) -> None:
        top = os.stat(top_name, dir_fd=parent, follow_symlinks=False)
        expected_top = renamed_identity(self.root_meta) if renamed_root else identity(self.root_meta)
        actual_top = renamed_identity(top) if renamed_root else identity(top)
        actual_root = (renamed_identity(os.fstat(self.root)) if renamed_root
                       else identity(os.fstat(self.root)))
        if actual_top != expected_top or actual_root != expected_top:
            refuse("logical retirement root no longer resolves to held authority")
        for path, parent_fd, basename, descriptor, metadata, names, is_root in self.directories:
            current = os.fstat(descriptor)
            if ((is_root and renamed_root and
                 renamed_identity(current) != renamed_identity(metadata)) or
                    (not (is_root and renamed_root) and identity(current) != identity(metadata)) or
                    tuple(sorted(os.listdir(descriptor))) != names):
                refuse(f"logical retirement directory changed: {path or '.'}")
            if not is_root:
                rebound = os.stat(str(basename), dir_fd=parent_fd,
                                  follow_symlinks=False)
                if identity(rebound) != identity(metadata):
                    refuse(f"logical retirement directory name changed: {path}")
        for path, parent_fd, descriptor, name, metadata, digest in self.files:
            current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if (identity(current) != identity(metadata) or
                    identity(os.fstat(descriptor)) != identity(metadata) or
                    hash_fd(descriptor, metadata) != digest):
                refuse(f"logical retirement file changed: {path}")

    def close(self) -> None:
        for descriptor in reversed(self.owned):
            try: os.close(descriptor)
            except OSError: pass


class RetirementMonitor:
    """Inotify journal for parent/name and every held tree inode."""

    def __init__(self, parent: int, authority: RetirementAuthority):
        library = ctypes.CDLL(None, use_errno=True)
        initializer = getattr(library, "inotify_init1", None)
        add_watch = getattr(library, "inotify_add_watch", None)
        if initializer is None or add_watch is None:
            refuse("kernel retirement watches are unavailable")
        self.fd = initializer(os.O_CLOEXEC | os.O_NONBLOCK)
        if self.fd < 0:
            error = ctypes.get_errno(); raise OSError(error, os.strerror(error))
        self.roles: dict[int, set[str]] = {}
        self.parent_watch = self._add(add_watch, parent, "parent")
        self.root_watch = -1
        for descriptor in authority.descriptors():
            role = "root" if descriptor == authority.root else "tree"
            watch = self._add(add_watch, descriptor, role)
            if role == "root": self.root_watch = watch

    def _add(self, function: object, descriptor: int, role: str) -> int:
        watch = function(self.fd, os.fsencode(f"/proc/self/fd/{descriptor}"), WATCH_MASK)
        if watch < 0:
            error = ctypes.get_errno(); self.close(); raise OSError(error, os.strerror(error))
        self.roles.setdefault(watch, set()).add(role)
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
                name = os.fsdecode(raw.split(b"\0", 1)[0])
                result.append((watch, mask & ~IN_ISDIR, cookie, name))
                offset += 16 + length
        return result

    def expect_rename(self, source: str, destination: str) -> None:
        events = self.events(); moved_from = moved_to = None; root_move = 0
        for watch, mask, cookie, name in events:
            if watch == self.parent_watch and mask == IN_MOVED_FROM and name == source:
                moved_from = cookie
            elif watch == self.parent_watch and mask == IN_MOVED_TO and name == destination:
                moved_to = cookie
            elif watch == self.root_watch and mask == IN_MOVE_SELF and not name:
                root_move += 1
            else:
                refuse("unexpected filesystem event during logical retirement")
        if not moved_from or moved_from != moved_to or root_move != 1:
            refuse("kernel did not attest the exact quarantine rename")

    def assert_quiet(self) -> None:
        if self.events():
            refuse("unexpected filesystem event after logical retirement")

    def close(self) -> None:
        descriptor = getattr(self, "fd", -1)
        if descriptor >= 0:
            os.close(descriptor); self.fd = -1


def quarantine_exact(parent: int, name: str,
                     expected_inode: tuple[int, int]) -> str:
    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if inode(current) != expected_inode:
        refuse("managed child was replaced before quarantine")
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         dir_fd=parent)
    authority: RetirementAuthority | None = None
    monitor: RetirementMonitor | None = None
    quarantine = ""
    try:
        authority = RetirementAuthority(descriptor)
        if identity(os.fstat(descriptor)) != identity(current):
            refuse("managed child moved before retirement watches")
        quarantine = f".candidate-retired-{authority.digest[:32]}"
        monitor = RetirementMonitor(parent, authority)
        authority.revalidate(parent, name, renamed_root=False)
        monitor.assert_quiet()
        retirement_checkpoint("before-quarantine", parent, descriptor)
        authority.revalidate(parent, name, renamed_root=False)
        monitor.assert_quiet()
        rename_no_replace(parent, name, parent, quarantine)
        retirement_checkpoint("after-quarantine", parent, descriptor)
        monitor.expect_rename(name, quarantine)
        authority.revalidate(parent, quarantine, renamed_root=True)
        os.fsync(parent)
        retirement_checkpoint("before-final-proof", parent, descriptor)
        authority.revalidate(parent, quarantine, renamed_root=True)
        monitor.assert_quiet()
        retirement_checkpoint("after-final-proof", parent, descriptor)
        authority.revalidate(parent, quarantine, renamed_root=True)
        monitor.assert_quiet()
        retirement_checkpoint("before-return", parent, descriptor)
        authority.revalidate(parent, quarantine, renamed_root=True)
        monitor.assert_quiet()
        retirement_checkpoint("transaction-close", parent, descriptor)
        authority.revalidate(parent, quarantine, renamed_root=True)
        monitor.assert_quiet()
        # LINEARIZATION POINT: the complete drain above commits an immutable
        # inventory receipt.  A same-UID mutation after this point is a new
        # external transaction.  It cannot invalidate the historical receipt,
        # and it must be rejected when a consumer reopens the mutable name.
        retirement_checkpoint("transaction-commit", parent, descriptor)
        retirement_checkpoint("post-commit", parent, descriptor)
        return quarantine
    finally:
        if monitor is not None: monitor.close()
        if authority is not None: authority.close()
        os.close(descriptor)


def verify_retirement_receipt(parent: int, receipt: str) -> str:
    """Reopen and reproduce one candidate retirement receipt before use."""
    prefix = ".candidate-retired-"
    if (not receipt.startswith(prefix) or len(receipt) != len(prefix) + 32 or
            any(value not in "0123456789abcdef" for value in receipt[len(prefix):])):
        refuse("logical retirement receipt name is invalid")
    descriptor = os.open(receipt, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         dir_fd=parent)
    authority: RetirementAuthority | None = None
    try:
        authority = RetirementAuthority(descriptor)
        authority.revalidate(parent, receipt, renamed_root=False)
        if authority.digest[:32] != receipt[len(prefix):]:
            refuse("logical retirement receipt differs from current bytes")
        return authority.digest
    finally:
        if authority is not None: authority.close()
        os.close(descriptor)


def cleanup(parent: int, name: str, expected_inode: tuple[int, int]) -> str:
    """Logically retire the exact tree without deleting or truncating bytes."""
    return quarantine_exact(parent, name, expected_inode)


def hold_candidate(parent: int, name: str, candidate_id: str) -> tuple[int, os.stat_result, dict[str, tuple[int, os.stat_result, str]]]:
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    stage = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=parent)
    stage_meta = require_private_directory(stage, "candidate staging", exact_links=True)
    if identity(stage_meta) != identity(before) or sorted(os.listdir(stage)) != EXPECTED_FILES:
        os.close(stage)
        refuse("candidate staging identity or inventory is unsafe")
    held: dict[str, tuple[int, os.stat_result, str]] = {}
    try:
        for filename in EXPECTED_FILES:
            held[filename] = open_regular(stage, filename)
        descriptor_fd, descriptor_meta, _ = held["candidate.json"]
        descriptor_bytes = os.pread(descriptor_fd, descriptor_meta.st_size, 0)
        try:
            document = json.loads(descriptor_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError):
            refuse("candidate descriptor is invalid JSON")
        body = document.get("body") if isinstance(document, dict) else None
        if (descriptor_bytes != canonical(document) + b"\n" or
                document.get("candidateId") != candidate_id or
                not isinstance(body, dict) or
                hashlib.sha256(canonical(body)).hexdigest() != candidate_id):
            refuse("candidate descriptor does not reproduce the publication ID")
        return stage, stage_meta, held
    except BaseException:
        for descriptor, _, _ in reversed(list(held.values())):
            os.close(descriptor)
        os.close(stage)
        raise


def require_candidate_unchanged(stage: int, stage_meta: os.stat_result,
                                held: dict[str, tuple[int, os.stat_result, str]],
                                *, renamed: bool) -> None:
    after_root = os.fstat(stage)
    if ((inode(after_root), after_root.st_uid, after_root.st_gid,
         stat.S_IMODE(after_root.st_mode), after_root.st_nlink) !=
            (inode(stage_meta), stage_meta.st_uid, stage_meta.st_gid, 0o700, 2)):
        refuse("candidate root authority changed during publication")
    if not renamed and identity(after_root) != identity(stage_meta):
        refuse("candidate root changed before publication")
    if sorted(os.listdir(stage)) != EXPECTED_FILES:
        refuse("candidate inventory changed during publication")
    for filename, (descriptor, metadata, digest) in held.items():
        current = os.stat(filename, dir_fd=stage, follow_symlinks=False)
        if (identity(current) != identity(metadata) or
                identity(os.fstat(descriptor)) != identity(metadata) or
                hash_fd(descriptor, metadata) != digest):
            refuse(f"candidate file changed during publication: {filename}")


def publish(source_parent: int, stage_name: str, candidate_id: str,
            expected_inode: tuple[int, int],
            destination_parent: int | None = None) -> str:
    destination_parent = source_parent if destination_parent is None else destination_parent
    # Directory-file locks are the protocol shared with retention.  Use a stable
    # inode order so two publishers cannot deadlock while moving between stores.
    locks = {inode(os.fstat(source_parent)): source_parent,
             inode(os.fstat(destination_parent)): destination_parent}
    for _, descriptor in sorted(locks.items()):
        fcntl.flock(descriptor, fcntl.LOCK_EX)
    stage, stage_meta, held = hold_candidate(source_parent, stage_name, candidate_id)
    if inode(stage_meta) != expected_inode:
        for descriptor, _, _ in held.values():
            os.close(descriptor)
        os.close(stage)
        refuse("candidate staging inode differs from the creator's held inode")
    descriptors: list[int] = [stage, *(value[0] for value in held.values())]
    moved = False
    try:
        try:
            destination_meta = os.stat(candidate_id, dir_fd=destination_parent,
                                       follow_symlinks=False)
        except FileNotFoundError:
            destination_meta = None
        if destination_meta is not None:
            destination, _, destination_held = hold_candidate(destination_parent,
                                                               candidate_id,
                                                               candidate_id)
            descriptors.extend([destination, *(value[0] for value in destination_held.values())])
            try:
                for filename in EXPECTED_FILES:
                    if held[filename][2] != destination_held[filename][2] or held[filename][1].st_size != destination_held[filename][1].st_size:
                        refuse("retained candidate conflicts with incoming candidate")
                require_candidate_unchanged(stage, stage_meta, held, renamed=False)
            finally:
                # These are also in descriptors; remove them before closing here.
                for descriptor in [destination, *(value[0] for value in destination_held.values())]:
                    descriptors.remove(descriptor)
                    os.close(descriptor)
            cleanup(source_parent, stage_name, inode(stage_meta))
            return "existing"
        try:
            rename_no_replace(source_parent, stage_name, destination_parent, candidate_id)
            moved = True
            published = os.stat(candidate_id, dir_fd=destination_parent, follow_symlinks=False)
            if inode(published) != inode(stage_meta):
                refuse("published candidate name differs from held staging identity")
            require_candidate_unchanged(stage, stage_meta, held, renamed=True)
            os.fsync(source_parent)
            if destination_parent != source_parent:
                os.fsync(destination_parent)
        except BaseException:
            if moved:
                try:
                    current = os.stat(candidate_id, dir_fd=destination_parent,
                                      follow_symlinks=False)
                    if inode(current) == inode(stage_meta):
                        cleanup(destination_parent, candidate_id, inode(stage_meta))
                    else:
                        foreign = f".candidate-foreign-{os.getpid()}-{secrets.token_hex(12)}"
                        rename_no_replace(destination_parent, candidate_id,
                                          destination_parent, foreign)
                        os.fsync(destination_parent)
                except BaseException:
                    pass
            raise
        return "published"
    finally:
        for descriptor in reversed(descriptors):
            try: os.close(descriptor)
            except OSError: pass


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    ensure = subparsers.add_parser("ensure-root")
    ensure.add_argument("--path", required=True)
    child = subparsers.add_parser("create-child")
    child.add_argument("--name", required=True)
    child.add_argument("--exclusive", action="store_true")
    cleanup_parser = subparsers.add_parser("cleanup")
    cleanup_parser.add_argument("--name", required=True)
    cleanup_parser.add_argument("--dev", required=True, type=int)
    cleanup_parser.add_argument("--ino", required=True, type=int)
    retire_path = subparsers.add_parser("retire-path")
    retire_path.add_argument("--parent", required=True)
    retire_path.add_argument("--name", required=True)
    verify_receipt = subparsers.add_parser("verify-receipt")
    verify_receipt.add_argument("--parent", required=True)
    verify_receipt.add_argument("--receipt", required=True)
    publish_parser = subparsers.add_parser("publish")
    publish_parser.add_argument("--stage", required=True)
    publish_parser.add_argument("--candidate-id", required=True)
    publish_parser.add_argument("--dev", required=True, type=int)
    publish_parser.add_argument("--ino", required=True, type=int)
    transfer_parser = subparsers.add_parser("publish-transfer")
    transfer_parser.add_argument("--stage", required=True)
    transfer_parser.add_argument("--candidate-id", required=True)
    transfer_parser.add_argument("--dev", required=True, type=int)
    transfer_parser.add_argument("--ino", required=True, type=int)
    arguments = parser.parse_args()
    if arguments.command == "ensure-root":
        descriptor = open_absolute(arguments.path, True)
        try:
            metadata = require_private_directory(descriptor, "managed data root")
            print(f"{metadata.st_dev}:{metadata.st_ino}")
        finally: os.close(descriptor)
        return
    if arguments.command in ("retire-path", "verify-receipt"):
        if arguments.parent != REMOTE_INCOMING_ROOT:
            refuse("retirement receipt parent is outside the protected incoming store")
        parent = open_absolute(arguments.parent, False)
        try:
            require_private_directory(parent, "retirement receipt parent")
            if arguments.command == "verify-receipt":
                print(verify_retirement_receipt(parent, arguments.receipt))
            else:
                name = validate_name(arguments.name)
                if (len(name) != 64 or
                        any(value not in "0123456789abcdef" for value in name)):
                    refuse("incoming retirement name is not a release ID")
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                print(quarantine_exact(parent, name, inode(current)))
        finally:
            os.close(parent)
        return
    parent, _ = open_held_parent()
    try:
        if arguments.command == "create-child":
            dev, ino = create_child(parent, arguments.name,
                                    exclusive=arguments.exclusive)
            print(f"{dev}:{ino}")
        elif arguments.command == "cleanup":
            print(cleanup(parent, validate_name(arguments.name),
                          (arguments.dev, arguments.ino)))
        else:
            if len(arguments.candidate_id) != 64 or any(character not in "0123456789abcdef" for character in arguments.candidate_id):
                refuse("candidate ID is invalid")
            stage_prefix = ".candidate-staging-" if arguments.command == "publish" else None
            stage = validate_name(arguments.stage, stage_prefix)
            if arguments.command == "publish-transfer":
                destination, _ = open_held_parent(4)
                try:
                    print(publish(parent, stage, arguments.candidate_id,
                                  (arguments.dev, arguments.ino), destination))
                finally:
                    os.close(destination)
            else:
                print(publish(parent, stage, arguments.candidate_id,
                              (arguments.dev, arguments.ino)))
    finally:
        os.close(parent)


if __name__ == "__main__":
    main()
