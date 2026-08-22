#!/usr/bin/env python3
"""Descriptor-held inventory and recoverable logical retirement for retained state."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import re
import secrets
import stat
import struct


REMOTE_ROOT = "/home/anders/ai-pin-revival"
RELEASE_ID = re.compile(r"^[0-9a-f]{64}$")
BACKUP_ID = re.compile(r"^[A-Za-z0-9._-]{8,96}$")
KINDS = {"backup": "backups", "release": "releases",
         "candidate": "release-candidates", "incoming": "incoming"}


def refuse(message: str) -> "NoReturn":
    raise SystemExit(f"retention store refusal: {message}")


def identity(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_nlink, value.st_uid, value.st_gid,
            stat.S_IMODE(value.st_mode))


def inode(value: os.stat_result) -> tuple[int, int]:
    return value.st_dev, value.st_ino


def open_directory(path: str) -> int:
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        refuse("store path is not canonical and absolute")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.split("/")[1:]:
            if not component or component in (".", ".."):
                refuse("store path has an unsafe component")
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor); descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor); raise


def validate_store(path: str, kind: str) -> int:
    expected = f"{REMOTE_ROOT}/{KINDS[kind]}"
    if path != expected:
        refuse("requested store is outside the protected root")
    descriptor = open_directory(path)
    metadata = os.fstat(descriptor)
    if (not stat.S_ISDIR(metadata.st_mode) or
            (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) !=
            (os.getuid(), os.getgid(), 0o700)):
        os.close(descriptor); refuse("store root metadata is unsafe")
    return descriptor


def valid_name(kind: str, name: str) -> bool:
    return bool((BACKUP_ID if kind == "backup" else RELEASE_ID).fullmatch(name))


def hash_fd(descriptor: int, metadata: os.stat_result) -> str:
    digest = hashlib.sha256(); offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("retained file was truncated")
        digest.update(block); offset += len(block)
    if identity(os.fstat(descriptor)) != identity(metadata):
        refuse("retained file changed while hashing")
    return digest.hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def authority_token(value: dict) -> str:
    selected = {key: value[key] for key in
                ("dev", "ino", "mode", "uid", "gid", "nlink", "size",
                 "mtimeNs", "ctimeNs", "inventorySha256")}
    return hashlib.sha256(canonical(selected)).hexdigest()


def capture(directory: int, name: str, kind: str) -> dict:
    before = os.stat(name, dir_fd=directory, follow_symlinks=False)
    if (not stat.S_ISDIR(before.st_mode) or
            (before.st_uid, before.st_gid) != (os.getuid(), os.getgid()) or
            stat.S_IMODE(before.st_mode) not in (0o700, 0o755)):
        refuse("retained item root metadata is unsafe")
    root = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
    rows: list[dict] = []
    total = 0
    try:
        opened = os.fstat(root)
        if identity(opened) != identity(before):
            refuse("retained item moved before open")

        def walk(parent: int, relative: str) -> None:
            nonlocal total
            names = sorted(os.listdir(parent)); direct_directories = 0
            for child_name in names:
                if not child_name or child_name in (".", "..") or "/" in child_name:
                    refuse("retained item has an unsafe child name")
                child_relative = f"{relative}/{child_name}" if relative else child_name
                metadata = os.stat(child_name, dir_fd=parent, follow_symlinks=False)
                mode = stat.S_IMODE(metadata.st_mode)
                if stat.S_ISDIR(metadata.st_mode):
                    direct_directories += 1
                    if ((metadata.st_uid, metadata.st_gid) != (os.getuid(), os.getgid()) or
                            mode not in (0o700, 0o755)):
                        refuse("retained directory metadata is unsafe")
                    child = os.open(child_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                    dir_fd=parent)
                    try:
                        if identity(os.fstat(child)) != identity(metadata):
                            refuse("retained directory moved before traversal")
                        walk(child, child_relative)
                        if identity(os.fstat(child)) != identity(metadata):
                            refuse("retained directory changed during traversal")
                    finally:
                        os.close(child)
                    rows.append({"path": child_relative + "/", "kind": "directory",
                                 "identity": identity(metadata)})
                elif stat.S_ISREG(metadata.st_mode):
                    if (metadata.st_nlink != 1 or
                            (metadata.st_uid, metadata.st_gid) != (os.getuid(), os.getgid()) or
                            mode not in (0o400, 0o440, 0o600, 0o640, 0o644, 0o755)):
                        refuse("retained file metadata is unsafe")
                    child = os.open(child_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                    try:
                        if identity(os.fstat(child)) != identity(metadata):
                            refuse("retained file moved before open")
                        digest = hash_fd(child, metadata)
                    finally:
                        os.close(child)
                    total += metadata.st_size
                    rows.append({"path": child_relative, "kind": "file",
                                 "identity": identity(metadata), "sha256": digest})
                else:
                    refuse("retained item contains a link or special object")
            metadata = os.fstat(parent)
            if metadata.st_nlink != 2 + direct_directories:
                refuse("retained directory link count is unsafe")

        walk(root, "")
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if identity(current) != identity(opened) or identity(os.fstat(root)) != identity(opened):
            refuse("retained item name or root changed during inventory")
        inventory = hashlib.sha256(canonical(rows)).hexdigest()
        result = {"name": name, "bytes": total, "mtime": opened.st_mtime_ns // 1_000_000_000,
                  "path": f"{REMOTE_ROOT}/{KINDS[kind]}/{name}",
                  "dev": opened.st_dev, "ino": opened.st_ino,
                  "mode": stat.S_IMODE(opened.st_mode), "uid": opened.st_uid,
                  "gid": opened.st_gid, "nlink": opened.st_nlink,
                  "size": opened.st_size, "mtimeNs": opened.st_mtime_ns,
                  "ctimeNs": opened.st_ctime_ns, "inventorySha256": inventory}
        result["authorityToken"] = authority_token(result)
        return result
    finally:
        os.close(root)


def rename_no_replace(source_parent: int, source: str,
                      destination_parent: int, destination: str) -> None:
    function = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
    if function is None:
        refuse("renameat2 is unavailable")
    if function(source_parent, os.fsencode(source), destination_parent,
                os.fsencode(destination), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def renamed_identity(value: os.stat_result) -> tuple[int, ...]:
    # rename(2) changes ctime on Linux; every other authority field remains
    # independently checkable while retained bytes move into quarantine.
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
RETIREMENT_PREFIXES = (".prune-retired-", ".candidate-retired-",
                       ".release-retired-", ".bootstrap-retired-")


def retirement_checkpoint(_label: str, _parent: int, _root: int) -> None:
    """Deterministic race-injection seam; production deliberately does nothing."""


class RetirementAuthority:
    """Held inventory used to issue and independently reproduce a receipt.

    The mutable retirement pathname is never authority.  Success linearizes at
    the final complete watcher drain after every held object is revalidated.
    Later enumeration must reopen nofollow and reproduce the digest receipt.
    """

    def __init__(self, root: int):
        self.root = root; self.root_meta = os.fstat(root)
        if (not stat.S_ISDIR(self.root_meta.st_mode) or
                (self.root_meta.st_uid, self.root_meta.st_gid) !=
                (os.getuid(), os.getgid()) or
                stat.S_IMODE(self.root_meta.st_mode) not in (0o700, 0o755)):
            refuse("logical retirement root metadata is unsafe")
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
                refuse("logical retirement contains an unsafe name")
            child_relative = f"{relative}/{name}" if relative else name
            before = os.stat(name, dir_fd=directory, follow_symlinks=False)
            mode = stat.S_IMODE(before.st_mode)
            if stat.S_ISDIR(before.st_mode):
                direct_directories += 1
                if ((before.st_uid, before.st_gid) != (os.getuid(), os.getgid()) or
                        mode not in (0o700, 0o755)):
                    refuse("logical retirement contains an unsafe directory")
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=directory)
                if identity(os.fstat(child)) != identity(before):
                    os.close(child); refuse("logical retirement directory moved before hold")
                self.owned.append(child)
                self._walk(child, child_relative, before, False, directory, name)
            elif stat.S_ISREG(before.st_mode):
                if (before.st_nlink != 1 or
                        (before.st_uid, before.st_gid) != (os.getuid(), os.getgid()) or
                        mode not in (0o400, 0o440, 0o600, 0o640, 0o644, 0o755)):
                    refuse("logical retirement contains an unsafe file")
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                if identity(os.fstat(child)) != identity(before):
                    os.close(child); refuse("logical retirement file moved before hold")
                self.owned.append(child)
                self.files.append((child_relative, directory, child, name,
                                   before, hash_fd(child, before)))
            else:
                refuse("logical retirement contains a link or special object")
        if metadata.st_nlink != 2 + direct_directories:
            refuse("logical retirement directory link count is unsafe")

    def descriptors(self) -> list[int]:
        return [value[3] for value in self.directories] + [value[2] for value in self.files]

    def revalidate(self, parent: int, top_name: str, *, renamed_root: bool) -> None:
        top = os.stat(top_name, dir_fd=parent, follow_symlinks=False)
        expected = (renamed_identity(self.root_meta) if renamed_root
                    else identity(self.root_meta))
        if ((renamed_identity(top) if renamed_root else identity(top)) != expected or
                (renamed_identity(os.fstat(self.root)) if renamed_root
                 else identity(os.fstat(self.root))) != expected):
            refuse("logical retirement root name changed")
        for path, parent_fd, basename, descriptor, metadata, names, is_root in self.directories:
            current = os.fstat(descriptor)
            if ((is_root and renamed_root and
                 renamed_identity(current) != renamed_identity(metadata)) or
                    (not (is_root and renamed_root) and identity(current) != identity(metadata)) or
                    tuple(sorted(os.listdir(descriptor))) != names):
                refuse(f"logical retirement directory changed: {path or '.'}")
            if not is_root and identity(os.stat(str(basename), dir_fd=parent_fd,
                                                follow_symlinks=False)) != identity(metadata):
                refuse(f"logical retirement directory name changed: {path}")
        for path, parent_fd, descriptor, name, metadata, digest in self.files:
            if (identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) !=
                    identity(metadata) or identity(os.fstat(descriptor)) != identity(metadata) or
                    hash_fd(descriptor, metadata) != digest):
                refuse(f"logical retirement file changed: {path}")

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
                refuse("unexpected filesystem event during logical retirement")
        if not moved_from or moved_from != moved_to or root_move != 1:
            refuse("kernel did not attest the exact retirement rename")

    def assert_quiet(self) -> None:
        if self.events(): refuse("unexpected filesystem event after logical retirement")

    def close(self) -> None:
        if getattr(self, "fd", -1) >= 0:
            os.close(self.fd); self.fd = -1


def logical_retire(store: int, name: str, held: int,
                   expected: os.stat_result) -> str:
    authority: RetirementAuthority | None = None
    monitor: RetirementMonitor | None = None
    retired = ""
    try:
        authority = RetirementAuthority(held)
        if identity(os.fstat(held)) != identity(expected):
            refuse("retained item changed before retirement watches")
        retired = f".prune-retired-{authority.digest[:32]}"
        monitor = RetirementMonitor(store, authority)
        authority.revalidate(store, name, renamed_root=False); monitor.assert_quiet()
        retirement_checkpoint("before-quarantine", store, held)
        authority.revalidate(store, name, renamed_root=False); monitor.assert_quiet()
        rename_no_replace(store, name, store, retired)
        retirement_checkpoint("after-quarantine", store, held)
        monitor.expect_rename(name, retired)
        authority.revalidate(store, retired, renamed_root=True); os.fsync(store)
        retirement_checkpoint("before-final-proof", store, held)
        authority.revalidate(store, retired, renamed_root=True); monitor.assert_quiet()
        retirement_checkpoint("after-final-proof", store, held)
        authority.revalidate(store, retired, renamed_root=True); monitor.assert_quiet()
        retirement_checkpoint("before-return", store, held)
        authority.revalidate(store, retired, renamed_root=True); monitor.assert_quiet()
        retirement_checkpoint("transaction-close", store, held)
        authority.revalidate(store, retired, renamed_root=True); monitor.assert_quiet()
        # LINEARIZATION POINT: the final watcher drain above commits the receipt.
        # Same-UID changes after it are later mutations, detected by the next
        # nofollow receipt verification rather than retroactively changing this
        # successful transaction's immutable inventory fact.
        retirement_checkpoint("transaction-commit", store, held)
        retirement_checkpoint("post-commit", store, held)
        return retired
    finally:
        if monitor is not None: monitor.close()
        if authority is not None: authority.close()


def verify_retirement_receipt(store: int, receipt: str) -> str:
    """Reopen and reproduce a known retirement receipt before trusting it."""
    prefix = next((value for value in RETIREMENT_PREFIXES
                   if receipt.startswith(value)), None)
    if prefix is None:
        refuse("logical retirement name has no inventory receipt")
    suffix = receipt.removeprefix(prefix)
    if not re.fullmatch(r"[0-9a-f]{32}", suffix):
        refuse("logical retirement name has no inventory receipt")
    held = os.open(receipt, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                   dir_fd=store)
    authority: RetirementAuthority | None = None
    try:
        authority = RetirementAuthority(held)
        authority.revalidate(store, receipt, renamed_root=False)
        if authority.digest[:32] != suffix:
            refuse("logical retirement receipt differs from retained bytes")
        return authority.digest
    finally:
        if authority is not None: authority.close()
        os.close(held)


def remove(store: int, name: str, kind: str, expected: str) -> str:
    planned = capture(store, name, kind)
    if planned["authorityToken"] != expected:
        refuse("retained item differs from the reviewed plan")
    before = os.stat(name, dir_fd=store, follow_symlinks=False)
    held = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=store)
    try:
        if (identity(os.fstat(held)) != identity(before) or
                (before.st_dev, before.st_ino) != (planned["dev"], planned["ino"])):
            refuse("retained item moved after the reviewed plan")
        return logical_retire(store, name, held, before)
    finally:
        os.close(held)


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    facts = subparsers.add_parser("facts")
    facts.add_argument("--store", required=True); facts.add_argument("--kind", choices=KINDS, required=True)
    deletion = subparsers.add_parser("remove")
    deletion.add_argument("--store", required=True); deletion.add_argument("--kind", choices=KINDS, required=True)
    deletion.add_argument("--name", required=True); deletion.add_argument("--authority-token", required=True)
    arguments = parser.parse_args()
    store = validate_store(arguments.store, arguments.kind)
    try:
        if arguments.command == "facts":
            for name in sorted(os.listdir(store)):
                if name.startswith(".prune-quarantine-"):
                    refuse("a prior retention quarantine requires operator inspection")
                prefix = next((value for value in RETIREMENT_PREFIXES
                               if name.startswith(value)), None)
                if prefix is not None:
                    verify_retirement_receipt(store, name)
                    continue
                if not valid_name(arguments.kind, name):
                    refuse("store contains an unclassifiable entry")
                print(json.dumps(capture(store, name, arguments.kind), sort_keys=True,
                                 separators=(",", ":")))
        else:
            if not valid_name(arguments.kind, arguments.name) or not re.fullmatch(r"[0-9a-f]{64}", arguments.authority_token):
                refuse("deletion name or authority token is invalid")
            print(remove(store, arguments.name, arguments.kind,
                         arguments.authority_token))
    finally:
        os.close(store)


if __name__ == "__main__":
    main()
