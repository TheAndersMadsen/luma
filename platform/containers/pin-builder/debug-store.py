#!/usr/bin/env python3
"""Nofollow, descriptor-anchored storage for non-installable Pin debug sets."""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import errno
import fcntl
import hashlib
import io
import json
import os
import re
import secrets
import signal
import stat
import struct
import subprocess
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


DEBUG_ROLES = ("installer", "bootstrap", "hook", "server", "hook-injector")
HOST_CACHE_LEAVES = (
    ("cargo-registry", "/cache-data/cargo-registry"),
    ("cargo-git", "/cache-data/cargo-git"),
    ("gradle-caches", "/cache-data/gradle-caches"),
    ("gradle-wrapper", "/cache-data/gradle-wrapper"),
    ("npm-cacache", "/cache-data/npm-cacache"),
)
ROLE_PACKAGES = {
    "installer": "com.penumbraos.systeminjector",
    "bootstrap": "com.penumbraos.systeminjector.exploit",
    "hook": "com.penumbraos.hook",
    "server": "com.penumbraos.server",
    "hook-injector": "com.penumbraos.hook.injector",
}
COMPATIBILITY_CERT_SHA256 = (
    "d8a64e1c3a1afdc340c4b86feaacb88e2d81d66972afbd58e743b7c5b8d1cbdb"
)
SOURCE_ROOT = Path(__file__).resolve().parents[3]
HEX_256 = re.compile(r"[0-9a-f]{64}\Z")
VERSION_NAME = re.compile(r"[A-Za-z0-9._-]{1,64}\Z")
SAFE_NAME = re.compile(r"[A-Za-z0-9._-]{1,128}\Z")
SAFE_PREFIX = re.compile(r"[A-Za-z0-9._-]{1,96}\Z")
SAFE_GIT_REF = re.compile(r"(?:refs/(?:heads|remotes)/)?[A-Za-z0-9][A-Za-z0-9._/-]{0,254}\Z")
HEX_GIT_OBJECT = re.compile(r"[0-9a-f]{40}\Z")
PROC_FD_PATH = re.compile(r"/proc/(?:self|[1-9][0-9]*)/fd/[0-9]+(?:/(.*))?\Z")
DIRECTORY_FLAGS = (
    os.O_RDONLY
    | os.O_DIRECTORY
    | os.O_NOFOLLOW
    | getattr(os, "O_CLOEXEC", 0)
)
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
EXPECTED_RECEIPT_KEYS = frozenset(
    {
        "schema",
        "version",
        "role",
        "package",
        "variant",
        "versionName",
        "versionCode",
        "minSdk",
        "targetSdk",
        "debuggable",
        "payloadComplete",
        "release",
        "installable",
        "signerSha256",
        "sha256",
        "size",
    }
)


class StoreError(RuntimeError):
    """A fail-closed debug-store policy violation."""


class ChildStatus(RuntimeError):
    def __init__(self, status: int):
        self.status = status


class ChildSignal(RuntimeError):
    def __init__(self, signum: int):
        self.signum = signum


def fail(message: str) -> "NoReturn":
    raise StoreError(message)


def mode_bits(metadata: os.stat_result) -> int:
    return stat.S_IMODE(metadata.st_mode)


def same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def safe_source_component(name: str) -> bool:
    try:
        encoded = name.encode("utf-8", "strict")
    except UnicodeError:
        return False
    return (
        name not in ("", ".", "..") and "/" not in name and "\0" not in name and
        0 < len(encoded) <= 255
    )


def stable_file_metadata(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def stable_directory_metadata(metadata: os.stat_result) -> tuple[int, ...]:
    """Identity plus security/history evidence for a held private directory."""

    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_nlink,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def stable_directory_security(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_gid,
    )


class MetadataWatcher:
    """Detect directory chmod/chown toggles even when visible metadata returns."""

    IN_MODIFY = 0x00000002
    IN_ATTRIB = 0x00000004
    IN_CLOSE_WRITE = 0x00000008
    IN_DELETE_SELF = 0x00000400
    IN_MOVE_SELF = 0x00000800
    IN_UNMOUNT = 0x00002000
    IN_Q_OVERFLOW = 0x00004000
    IN_IGNORED = 0x00008000
    # IN_MOVE_SELF is intentionally covered by the held directory's two
    # exact parent/name watchers during RENAME_NOREPLACE handoff; the inotify
    # watch remains attached to the inode. Actual watch loss is always fatal.
    FATAL_MASK = IN_DELETE_SELF | IN_UNMOUNT | IN_Q_OVERFLOW | IN_IGNORED
    CONTENT_MASK = IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE
    WATCH_MASK = CONTENT_MASK | FATAL_MASK

    def __init__(self, descriptor: int, label: str):
        if not sys.platform.startswith("linux"):
            fail(f"{label} requires Linux inotify metadata authority")
        libc = ctypes.CDLL(None, use_errno=True)
        initialize = getattr(libc, "inotify_init1", None)
        add_watch = getattr(libc, "inotify_add_watch", None)
        if initialize is None or add_watch is None:
            fail(f"{label} requires Linux inotify metadata authority")
        initialize.argtypes = [ctypes.c_int]
        initialize.restype = ctypes.c_int
        add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        add_watch.restype = ctypes.c_int
        watcher = initialize(os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
        if watcher < 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
        watched = add_watch(
            watcher,
            os.fsencode(f"/proc/self/fd/{descriptor}"),
            self.WATCH_MASK,
        )
        if watched < 0:
            error_number = ctypes.get_errno()
            os.close(watcher)
            raise OSError(error_number, os.strerror(error_number))
        self.descriptor = watcher
        self.label = label

    def consume_metadata_change(self) -> bool:
        changed = False
        while True:
            try:
                payload = os.read(self.descriptor, 64 * 1024)
            except BlockingIOError:
                return changed
            if not payload:
                return changed
            offset = 0
            while offset < len(payload):
                if len(payload) - offset < 16:
                    fail(f"{self.label} returned truncated metadata-watch evidence")
                watch, mask, _, name_size = struct.unpack_from("iIII", payload, offset)
                name_start = offset + 16
                name_end = name_start + name_size
                offset = name_end
                if offset > len(payload):
                    fail(f"{self.label} returned malformed metadata-watch evidence")
                if watch < 0 or mask & self.FATAL_MASK:
                    fail(f"{self.label} lost its metadata-watch authority")
                # A directory watch also receives named IN_ATTRIB events when
                # the helper chmods a child it has just created. Only an empty
                # event name describes metadata on the held directory itself.
                name = payload[name_start:name_end].rstrip(b"\0")
                if mask & self.CONTENT_MASK and not name:
                    changed = True

    def require_unnamed_link_commit(self) -> None:
        """Accept only the kernel's single O_TMPFILE 0->1 link transition.

        The process is non-dumpable before any temporary inode is allocated,
        so another same-UID process cannot reach the unnamed descriptor.  A
        destination parent/name watcher independently rejects every named
        IN_ATTRIB event after linkat.
        """

        events = 0
        while True:
            try:
                payload = os.read(self.descriptor, 64 * 1024)
            except BlockingIOError:
                break
            if not payload:
                break
            offset = 0
            while offset < len(payload):
                if len(payload) - offset < 16:
                    fail(f"{self.label} returned truncated metadata-watch evidence")
                watch, mask, _, name_size = struct.unpack_from("iIII", payload, offset)
                name_start = offset + 16
                offset = name_start + name_size
                if offset > len(payload):
                    fail(f"{self.label} returned malformed metadata-watch evidence")
                if watch < 0 or mask & self.FATAL_MASK:
                    fail(f"{self.label} lost its metadata-watch authority")
                name = payload[name_start:offset].rstrip(b"\0")
                if name or mask != self.IN_ATTRIB:
                    fail(f"{self.label} had unrelated metadata during O_TMPFILE commit")
                events += 1
        if events != 1:
            fail(f"{self.label} did not expose one exact O_TMPFILE link transition")

    def reject_metadata_change(self) -> None:
        if self.consume_metadata_change():
            fail(f"{self.label} metadata changed during an authorized entry mutation")

    def close(self) -> None:
        with contextlib.suppress(OSError):
            os.close(self.descriptor)


class DirectoryEventWatcher:
    """Continuous parent/name authority for host-root acquisition."""

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
    IN_IGNORED = 0x00008000
    IN_ISDIR = 0x40000000
    ACTION_MASK = (
        IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_MOVED_FROM | IN_MOVED_TO |
        IN_CREATE | IN_DELETE
    )
    FATAL_MASK = IN_DELETE_SELF | IN_MOVE_SELF | IN_UNMOUNT | IN_Q_OVERFLOW | IN_IGNORED
    WATCH_MASK = ACTION_MASK | FATAL_MASK

    def __init__(self, descriptor: int, label: str):
        if not sys.platform.startswith("linux"):
            fail(f"{label} requires Linux inotify path authority")
        libc = ctypes.CDLL(None, use_errno=True)
        initialize = getattr(libc, "inotify_init1", None)
        add_watch = getattr(libc, "inotify_add_watch", None)
        if initialize is None or add_watch is None:
            fail(f"{label} requires Linux inotify path authority")
        initialize.argtypes = [ctypes.c_int]
        initialize.restype = ctypes.c_int
        add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        add_watch.restype = ctypes.c_int
        watcher = initialize(os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
        if watcher < 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
        watched = add_watch(
            watcher,
            os.fsencode(f"/proc/self/fd/{descriptor}"),
            self.WATCH_MASK,
        )
        if watched < 0:
            error_number = ctypes.get_errno()
            os.close(watcher)
            raise OSError(error_number, os.strerror(error_number))
        self.descriptor = watcher
        self.label = label

    def consume(self) -> list[tuple[int, bytes]]:
        events: list[tuple[int, bytes]] = []
        while True:
            try:
                payload = os.read(self.descriptor, 64 * 1024)
            except BlockingIOError:
                return events
            if not payload:
                return events
            offset = 0
            while offset < len(payload):
                if len(payload) - offset < 16:
                    fail(f"{self.label} returned truncated path-watch evidence")
                watch, mask, _, name_size = struct.unpack_from("iIII", payload, offset)
                name_start = offset + 16
                name_end = name_start + name_size
                offset = name_end
                if offset > len(payload):
                    fail(f"{self.label} returned malformed path-watch evidence")
                if watch < 0 and not mask & self.IN_Q_OVERFLOW:
                    fail(f"{self.label} returned a corrupt path-watch identity")
                name = payload[name_start:name_end].rstrip(b"\0")
                events.append((mask, name))

    def require_target_unchanged(
        self,
        target: str,
        *,
        expected_action: int | None = None,
    ) -> None:
        encoded = os.fsencode(target)
        relevant: list[int] = []
        for mask, name in self.consume():
            if mask & self.FATAL_MASK:
                fail(f"{self.label} lost its path-watch authority")
            if not name:
                if mask & self.ACTION_MASK:
                    fail(f"{self.label} metadata changed during root acquisition")
                continue
            if name == encoded and mask & self.ACTION_MASK:
                relevant.append(mask)
        if expected_action is None:
            if relevant:
                fail(f"{self.label}/{target} changed during root acquisition")
            return
        if len(relevant) != 1:
            fail(f"{self.label}/{target} did not have one exact authorized entry mutation")
        action = relevant[0] & self.ACTION_MASK
        if action != expected_action or relevant[0] & self.IN_ATTRIB:
            fail(f"{self.label}/{target} had an unrelated entry or metadata mutation")

    def require_self_unchanged(self) -> None:
        for mask, name in self.consume():
            if mask & self.FATAL_MASK:
                fail(f"{self.label} lost its path-watch authority")
            if not name and mask & self.ACTION_MASK:
                fail(f"{self.label} metadata changed during root acquisition")

    def require_no_changes(self) -> None:
        for mask, _name in self.consume():
            if mask & self.FATAL_MASK:
                fail(f"{self.label} lost its path-watch authority")
            if mask & self.ACTION_MASK:
                fail(f"{self.label} had an unauthorized entry or metadata mutation")

    def close(self) -> None:
        with contextlib.suppress(OSError):
            os.close(self.descriptor)


class RecursiveMutationWatcher:
    """One fail-closed inotify instance covering an immutable directory tree."""

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
    IN_IGNORED = 0x00008000
    MUTATION_MASK = (
        IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_MOVED_FROM | IN_MOVED_TO |
        IN_CREATE | IN_DELETE | IN_DELETE_SELF | IN_MOVE_SELF
    )
    FATAL_MASK = IN_UNMOUNT | IN_Q_OVERFLOW | IN_IGNORED
    WATCH_MASK = MUTATION_MASK | FATAL_MASK

    def __init__(self, root_descriptor: int, label: str, *, exclude_git: bool = False):
        if not sys.platform.startswith("linux"):
            fail(f"{label} requires Linux recursive inotify authority")
        libc = ctypes.CDLL(None, use_errno=True)
        initialize = getattr(libc, "inotify_init1", None)
        add_watch = getattr(libc, "inotify_add_watch", None)
        if initialize is None or add_watch is None:
            fail(f"{label} requires Linux recursive inotify authority")
        initialize.argtypes = [ctypes.c_int]
        initialize.restype = ctypes.c_int
        add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        add_watch.restype = ctypes.c_int
        descriptor = initialize(os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
        if descriptor < 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
        self.descriptor = descriptor
        self.label = label
        self._libc = libc
        self._add_watch = add_watch
        self._armed = 0
        try:
            self._arm_directory(root_descriptor, "", exclude_git=exclude_git)
            self.assert_clean()
        except BaseException:
            self.close()
            raise

    def _watch(self, descriptor: int) -> None:
        watched = self._add_watch(
            self.descriptor,
            os.fsencode(f"/proc/self/fd/{descriptor}"),
            self.WATCH_MASK,
        )
        if watched < 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
        self._armed += 1

    def _arm_directory(self, descriptor: int, relative: str, *, exclude_git: bool) -> None:
        self._watch(descriptor)
        names = sorted(os.listdir(descriptor))
        for name in names:
            if relative == "" and exclude_git and name == ".git":
                metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if not stat.S_ISDIR(metadata.st_mode):
                    fail(f"{self.label} .git exclusion is not a directory")
                continue
            metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISDIR(metadata.st_mode):
                child = os.open(name, DIRECTORY_FLAGS, dir_fd=descriptor)
                try:
                    self._arm_directory(
                        child,
                        f"{relative}/{name}" if relative else name,
                        exclude_git=exclude_git,
                    )
                finally:
                    os.close(child)
            elif not stat.S_ISREG(metadata.st_mode):
                fail(f"{self.label} contains a symlink or special file: {relative}/{name}")

    def assert_clean(self) -> None:
        while True:
            try:
                payload = os.read(self.descriptor, 64 * 1024)
            except BlockingIOError:
                return
            if not payload:
                return
            offset = 0
            while offset < len(payload):
                if len(payload) - offset < 16:
                    fail(f"{self.label} returned a short recursive-watch event")
                watch, mask, _, name_size = struct.unpack_from("iIII", payload, offset)
                offset += 16 + name_size
                if offset > len(payload):
                    fail(f"{self.label} returned a corrupt recursive-watch event")
                if watch < 0 or mask & self.FATAL_MASK:
                    fail(f"{self.label} lost recursive-watch authority")
                if mask & self.MUTATION_MASK:
                    fail(f"{self.label} changed while its sealed generation was in use")

    def close(self) -> None:
        with contextlib.suppress(OSError):
            os.close(self.descriptor)


@dataclass(frozen=True)
class SourceFileRecord:
    path: str
    mode: int
    size: int
    sha256: str
    git_oid: str
    contents: bytes


class SealedSourceGeneration:
    """A deterministic immutable source tar and the manifest that binds it."""

    FORBIDDEN_DIRECTORIES = frozenset({
        ".ci", ".git", ".gradle", ".hg", ".idea", ".kotlin", ".svn",
        "build", "decompile-workspace", "node_modules", "release-assets", "secrets",
        "target", "__pycache__",
    })
    FORBIDDEN_FILES = frozenset({
        ".env", ".npmrc", "credentials", "credentials.toml", "id_ed25519", "id_rsa",
        "local.properties", "signing.env", "signing.properties",
    })
    FORBIDDEN_SUFFIXES = (
        ".cer", ".crt", ".der", ".jks", ".key", ".keystore", ".p12", ".pem", ".pfx", ".pyc",
    )
    REQUIRED_SEALS = (
        getattr(fcntl, "F_SEAL_SEAL", 0x0001) |
        getattr(fcntl, "F_SEAL_SHRINK", 0x0002) |
        getattr(fcntl, "F_SEAL_GROW", 0x0004) |
        getattr(fcntl, "F_SEAL_WRITE", 0x0008)
    )

    def __init__(
        self,
        tar_descriptor: int,
        manifest_descriptor: int,
        manifest: dict[str, object],
        directories: tuple[tuple[str, int], ...],
        files: tuple[SourceFileRecord, ...],
        *,
        omitted_root_agents: bool = False,
    ) -> None:
        self.tar_descriptor = tar_descriptor
        self.manifest_descriptor = manifest_descriptor
        self.manifest = manifest
        self.directories = directories
        self.files = files
        self.omitted_root_agents = omitted_root_agents

    @property
    def broker_tar_path(self) -> str:
        return f"/proc/{os.getpid()}/fd/{self.tar_descriptor}"

    @property
    def broker_manifest_path(self) -> str:
        return f"/proc/{os.getpid()}/fd/{self.manifest_descriptor}"

    @property
    def generation(self) -> str:
        value = self.manifest.get("generationSha256")
        assert isinstance(value, str)
        return value

    @staticmethod
    def _memfd(name: str) -> int:
        if not hasattr(os, "memfd_create"):
            fail("sealed source generation requires Linux memfd_create")
        return os.memfd_create(
            name,
            getattr(os, "MFD_CLOEXEC", 0x0001) | getattr(os, "MFD_ALLOW_SEALING", 0x0002),
        )

    @classmethod
    def _seal(cls, descriptor: int, label: str) -> None:
        os.fsync(descriptor)
        fcntl.fcntl(descriptor, getattr(fcntl, "F_ADD_SEALS", 1033), cls.REQUIRED_SEALS)
        observed = fcntl.fcntl(descriptor, getattr(fcntl, "F_GET_SEALS", 1034))
        if observed & cls.REQUIRED_SEALS != cls.REQUIRED_SEALS:
            fail(f"{label} did not retain every required memfd seal")

    @staticmethod
    def _git_blob(contents: bytes) -> str:
        header = f"blob {len(contents)}\0".encode("ascii")
        return hashlib.sha1(header + contents, usedforsecurity=False).hexdigest()

    @classmethod
    def capture(cls, source: "WatchedDirectory") -> tuple["SealedSourceGeneration", RecursiveMutationWatcher]:
        watcher = RecursiveMutationWatcher(
            source.descriptor,
            "Pin sealed source capture",
            exclude_git=True,
        )
        directories: list[tuple[str, int]] = []
        files: list[SourceFileRecord] = []
        omitted_root_agents = False

        def host_agents_exclusion_is_explicit() -> bool:
            """Recognize only the environment-managed ignore declaration.

            This is not sufficient on its own: the caller subsequently proves
            through an isolated held-index `ls-files` that the name is not a
            tracked/user source entry.
            """

            git_descriptor: int | None = None
            info_descriptor: int | None = None
            exclude_descriptor: int | None = None
            try:
                git_descriptor = os.open(".git", DIRECTORY_FLAGS, dir_fd=source.descriptor)
                info_descriptor = os.open("info", DIRECTORY_FLAGS, dir_fd=git_descriptor)
                exclude_descriptor = os.open("exclude", FILE_FLAGS, dir_fd=info_descriptor)
                before = os.fstat(exclude_descriptor)
                contents = bounded_descriptor_bytes(
                    exclude_descriptor, 1024 * 1024, "Git local exclude proof"
                )
                after = os.fstat(exclude_descriptor)
                if (
                    stable_file_metadata(before) != stable_file_metadata(after) or
                    before.st_nlink != 1
                ):
                    fail("Git local exclude proof changed while read")
                lines = contents.decode("utf-8", "strict").splitlines()
                return sum(line == "AGENTS.md" for line in lines) == 1
            except (FileNotFoundError, NotADirectoryError, UnicodeError):
                return False
            finally:
                for descriptor in (exclude_descriptor, info_descriptor, git_descriptor):
                    if descriptor is not None:
                        os.close(descriptor)

        explicit_agents_exclusion = host_agents_exclusion_is_explicit()

        def walk(descriptor: int, relative: str) -> None:
            nonlocal omitted_root_agents
            first = sorted(os.listdir(descriptor))
            for name in first:
                if relative == "" and name == ".git":
                    continue
                if not safe_source_component(name):
                    fail(f"Pin sealed source has an unsafe entry name: {relative}/{name}")
                path = f"{relative}/{name}" if relative else name
                before = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                mode = mode_bits(before)
                if mode & 0o7000:
                    fail(f"Pin sealed source contains privileged mode bits: {path}")
                if stat.S_ISDIR(before.st_mode):
                    if name in cls.FORBIDDEN_DIRECTORIES:
                        fail(f"Pin sealed source contains generated directory: {path}")
                    child = os.open(name, DIRECTORY_FLAGS, dir_fd=descriptor)
                    try:
                        opened = os.fstat(child)
                        if stable_directory_metadata(before) != stable_directory_metadata(opened):
                            fail(f"Pin sealed source directory changed while opened: {path}")
                        directories.append((path, mode & 0o777))
                        walk(child, path)
                        after = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                        if stable_directory_metadata(before) != stable_directory_metadata(after):
                            fail(f"Pin sealed source directory changed while captured: {path}")
                    finally:
                        os.close(child)
                elif stat.S_ISREG(before.st_mode):
                    if relative == "" and name == "AGENTS.md" and explicit_agents_exclusion:
                        child = os.open(name, FILE_FLAGS, dir_fd=descriptor)
                        try:
                            opened = os.fstat(child)
                            contents = bounded_descriptor_bytes(
                                child, 1024 * 1024, "host AGENTS.md proof"
                            )
                            after = os.fstat(child)
                            if (
                                stable_file_metadata(before) != stable_file_metadata(opened) or
                                stable_file_metadata(opened) != stable_file_metadata(after)
                            ):
                                fail("host AGENTS.md proof changed while read")
                        finally:
                            os.close(child)
                        if (
                            contents.startswith(b"# Ai-Pin-Revival ") and
                            b"working context\n" in contents[:128] and
                            b"<!-- Auto-generated from " in contents and
                            b"claude-mem observations. Durable knowledge distilled" in contents
                        ):
                            omitted_root_agents = True
                            continue
                    if (
                        name in cls.FORBIDDEN_FILES or
                        name.endswith(cls.FORBIDDEN_SUFFIXES) or
                        before.st_nlink != 1
                    ):
                        fail(f"Pin sealed source contains private, generated, or linked file: {path}")
                    child = os.open(name, FILE_FLAGS, dir_fd=descriptor)
                    try:
                        opened = os.fstat(child)
                        if stable_file_metadata(before) != stable_file_metadata(opened):
                            fail(f"Pin sealed source file changed while opened: {path}")
                        if opened.st_size < 0 or opened.st_size > 512 * 1024 * 1024:
                            fail(f"Pin sealed source file exceeds its bound: {path}")
                        contents = bounded_descriptor_bytes(child, 512 * 1024 * 1024, path)
                        after = os.fstat(child)
                        named = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                        if (
                            stable_file_metadata(opened) != stable_file_metadata(after) or
                            stable_file_metadata(after) != stable_file_metadata(named)
                        ):
                            fail(f"Pin sealed source file changed while captured: {path}")
                    finally:
                        os.close(child)
                    files.append(SourceFileRecord(
                        path,
                        mode & 0o777,
                        len(contents),
                        hashlib.sha256(contents).hexdigest(),
                        cls._git_blob(contents),
                        contents,
                    ))
                else:
                    fail(f"Pin sealed source contains a symlink or special file: {path}")
            if first != sorted(os.listdir(descriptor)):
                fail(f"Pin sealed source inventory changed while captured: {relative or '.'}")

        try:
            walk(source.descriptor, "")
            watcher.assert_clean()
            directories.sort(key=lambda item: item[0].encode("utf-8"))
            files.sort(key=lambda item: item.path.encode("utf-8"))
            core = {
                "directories": [
                    {"path": path, "mode": mode} for path, mode in directories
                ],
                "files": [
                    {
                        "path": item.path,
                        "mode": item.mode,
                        "size": item.size,
                        "sha256": item.sha256,
                        "gitOid": item.git_oid,
                    }
                    for item in files
                ],
            }
            generation = hashlib.sha256(
                json.dumps(core, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            tar_descriptor = cls._memfd("revival-pin-source-tar")
            try:
                with os.fdopen(os.dup(tar_descriptor), "wb", closefd=True) as stream:
                    with tarfile.open(fileobj=stream, mode="w", format=tarfile.PAX_FORMAT) as archive:
                        for path, mode in directories:
                            info = tarfile.TarInfo(path + "/")
                            info.type = tarfile.DIRTYPE
                            info.mode = mode
                            info.uid = info.gid = 0
                            info.uname = info.gname = ""
                            info.mtime = 0
                            archive.addfile(info)
                        for item in files:
                            info = tarfile.TarInfo(item.path)
                            info.mode = item.mode
                            info.uid = info.gid = 0
                            info.uname = info.gname = ""
                            info.mtime = 0
                            info.size = item.size
                            archive.addfile(info, io.BytesIO(item.contents))
                tar_size = os.fstat(tar_descriptor).st_size
                tar_digest = descriptor_digest(tar_descriptor)
                cls._seal(tar_descriptor, "Pin source tar")
                manifest = {
                    "schema": "revival.pin-sealed-source",
                    "version": 1,
                    "generationSha256": generation,
                    "tarSha256": tar_digest,
                    "tarSize": tar_size,
                    **core,
                }
                manifest_bytes = json.dumps(
                    manifest, sort_keys=True, separators=(",", ":")
                ).encode("utf-8") + b"\n"
                manifest_descriptor = cls._memfd("revival-pin-source-manifest")
                try:
                    os.write(manifest_descriptor, manifest_bytes)
                    cls._seal(manifest_descriptor, "Pin source manifest")
                except BaseException:
                    os.close(manifest_descriptor)
                    raise
            except BaseException:
                os.close(tar_descriptor)
                raise
            watcher.assert_clean()
            return cls(
                tar_descriptor,
                manifest_descriptor,
                manifest,
                tuple(directories),
                tuple(files),
                omitted_root_agents=omitted_root_agents,
            ), watcher
        except BaseException:
            watcher.close()
            raise

    @classmethod
    def from_descriptors(cls, tar_descriptor: int, manifest_descriptor: int) -> "SealedSourceGeneration":
        for descriptor, label in (
            (tar_descriptor, "mounted Pin source tar"),
            (manifest_descriptor, "mounted Pin source manifest"),
        ):
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                fail(f"{label} is not a regular sealed inode")
            seals = fcntl.fcntl(descriptor, getattr(fcntl, "F_GET_SEALS", 1034))
            if seals & cls.REQUIRED_SEALS != cls.REQUIRED_SEALS:
                fail(f"{label} is not immutable")
        manifest = strict_json_bytes(
            bounded_descriptor_bytes(manifest_descriptor, 16 * 1024 * 1024, "sealed source manifest"),
            "sealed source manifest",
        )
        if (
            manifest.get("schema") != "revival.pin-sealed-source" or
            manifest.get("version") != 1 or
            not isinstance(manifest.get("directories"), list) or
            not isinstance(manifest.get("files"), list) or
            not isinstance(manifest.get("tarSize"), int) or
            os.fstat(tar_descriptor).st_size != manifest.get("tarSize") or
            descriptor_digest(tar_descriptor) != manifest.get("tarSha256")
        ):
            fail("mounted Pin source manifest does not bind the sealed tar")
        directories: list[tuple[str, int]] = []
        files_meta: dict[str, dict[str, object]] = {}
        for item in manifest["directories"]:
            if not isinstance(item, dict) or set(item) != {"path", "mode"}:
                fail("sealed source directory manifest is malformed")
            path = item.get("path")
            mode = item.get("mode")
            if not isinstance(path, str) or not isinstance(mode, int):
                fail("sealed source directory manifest is malformed")
            directories.append((path, mode))
        for item in manifest["files"]:
            if not isinstance(item, dict) or set(item) != {"path", "mode", "size", "sha256", "gitOid"}:
                fail("sealed source file manifest is malformed")
            path = item.get("path")
            if not isinstance(path, str) or path in files_meta:
                fail("sealed source file manifest has a duplicate or malformed path")
            files_meta[path] = item
        records: list[SourceFileRecord] = []
        seen_dirs: list[tuple[str, int]] = []
        os.lseek(tar_descriptor, 0, os.SEEK_SET)
        with os.fdopen(os.dup(tar_descriptor), "rb", closefd=True) as stream:
            with tarfile.open(fileobj=stream, mode="r:") as archive:
                for member in archive:
                    path = member.name.rstrip("/")
                    if member.isdir():
                        seen_dirs.append((path, member.mode & 0o777))
                        continue
                    if not member.isreg() or path not in files_meta:
                        fail(f"sealed source tar contains an unexpected entry: {member.name}")
                    extracted = archive.extractfile(member)
                    if extracted is None:
                        fail(f"sealed source tar cannot read {path}")
                    contents = extracted.read(512 * 1024 * 1024 + 1)
                    item = files_meta.pop(path)
                    if (
                        len(contents) != item.get("size") or
                        hashlib.sha256(contents).hexdigest() != item.get("sha256") or
                        cls._git_blob(contents) != item.get("gitOid") or
                        member.mode & 0o777 != item.get("mode")
                    ):
                        fail(f"sealed source tar bytes differ from its manifest: {path}")
                    records.append(SourceFileRecord(
                        path,
                        member.mode & 0o777,
                        len(contents),
                        hashlib.sha256(contents).hexdigest(),
                        cls._git_blob(contents),
                        contents,
                    ))
        if files_meta or sorted(seen_dirs) != sorted(directories):
            fail("sealed source tar inventory differs from its manifest")
        core = {key: manifest[key] for key in ("directories", "files")}
        if hashlib.sha256(
            json.dumps(core, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest() != manifest.get("generationSha256"):
            fail("sealed source generation digest is invalid")
        return cls(
            os.dup(tar_descriptor),
            os.dup(manifest_descriptor),
            manifest,
            tuple(directories),
            tuple(sorted(records, key=lambda item: item.path)),
        )

    def extract_into(self, root: "WatchedDirectory") -> RecursiveMutationWatcher:
        descriptors: dict[str, int] = {"": os.dup(root.descriptor)}
        try:
            for path, _mode in self.directories:
                parent_path, name = os.path.split(path)
                if parent_path not in descriptors or not safe_source_component(name):
                    fail(f"sealed source directory order is unsafe: {path}")
                os.mkdir(name, 0o700, dir_fd=descriptors[parent_path])
                descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=descriptors[parent_path])
                metadata = os.fstat(descriptor)
                require_private_directory(metadata, f"sealed source extraction {path}")
                descriptors[path] = descriptor
            for item in self.files:
                parent_path, name = os.path.split(item.path)
                if parent_path not in descriptors or not safe_source_component(name):
                    fail(f"sealed source file path is unsafe: {item.path}")
                descriptor = os.open(
                    name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW |
                    getattr(os, "O_CLOEXEC", 0),
                    item.mode,
                    dir_fd=descriptors[parent_path],
                )
                try:
                    view = memoryview(item.contents)
                    while view:
                        written = os.write(descriptor, view)
                        view = view[written:]
                    os.fchmod(descriptor, item.mode)
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            watcher = RecursiveMutationWatcher(root.descriptor, "sealed source extraction")
            self.verify_extraction(root.descriptor)
            watcher.assert_clean()
            return watcher
        finally:
            for descriptor in reversed(tuple(descriptors.values())):
                with contextlib.suppress(OSError):
                    os.close(descriptor)

    def verify_extraction(self, root_descriptor: int) -> None:
        expected_dirs = dict(self.directories)
        expected_files = {item.path: item for item in self.files}
        seen_dirs: set[str] = set()
        seen_files: set[str] = set()

        def walk(descriptor: int, relative: str) -> None:
            for name in sorted(os.listdir(descriptor)):
                path = f"{relative}/{name}" if relative else name
                metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if stat.S_ISDIR(metadata.st_mode) and path in expected_dirs:
                    if mode_bits(metadata) != 0o700:
                        fail(f"sealed source extraction directory is not private: {path}")
                    child = os.open(name, DIRECTORY_FLAGS, dir_fd=descriptor)
                    try:
                        seen_dirs.add(path)
                        walk(child, path)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(metadata.st_mode) and path in expected_files:
                    item = expected_files[path]
                    child = os.open(name, FILE_FLAGS, dir_fd=descriptor)
                    try:
                        if (
                            metadata.st_nlink != 1 or
                            mode_bits(metadata) != item.mode or
                            metadata.st_size != item.size or
                            descriptor_digest(child) != item.sha256
                        ):
                            fail(f"sealed source extraction differs from the manifest: {path}")
                    finally:
                        os.close(child)
                    seen_files.add(path)
                else:
                    fail(f"sealed source extraction contains an unexpected entry: {path}")

        walk(root_descriptor, "")
        if seen_dirs != set(expected_dirs) or seen_files != set(expected_files):
            fail("sealed source extraction is incomplete")

    def close(self) -> None:
        with contextlib.suppress(OSError):
            os.close(self.tar_descriptor)
        with contextlib.suppress(OSError):
            os.close(self.manifest_descriptor)


@dataclass
class WatchedDirectory:
    """One directory whose parent/name and inode watches predate its use."""

    descriptor: int
    metadata: os.stat_result
    label: str
    parent: "WatchedDirectory | None"
    name: str | None
    parent_watcher: DirectoryEventWatcher | None
    metadata_watcher: MetadataWatcher
    contents_mutable: bool = False
    created_token: str | None = None

    @property
    def broker_path(self) -> str:
        return f"/proc/{os.getpid()}/fd/{self.descriptor}"

    @property
    def child_path(self) -> str:
        return f"/proc/self/fd/{self.descriptor}"

    def revalidate(self) -> None:
        self.metadata_watcher.reject_metadata_change()
        current = os.fstat(self.descriptor)
        if not stat.S_ISDIR(current.st_mode) or not same_identity(current, self.metadata):
            fail(f"{self.label} changed identity while held")
        if current.st_uid != self.metadata.st_uid or current.st_gid != self.metadata.st_gid:
            fail(f"{self.label} ownership changed while held")
        if mode_bits(current) != mode_bits(self.metadata):
            fail(f"{self.label} mode changed while held")
        if not self.contents_mutable and stable_directory_metadata(current) != stable_directory_metadata(
            self.metadata
        ):
            fail(f"{self.label} metadata changed while held")
        if self.parent is not None:
            assert self.name is not None and self.parent_watcher is not None
            self.parent_watcher.require_target_unchanged(self.name)
            try:
                named = os.stat(
                    self.name,
                    dir_fd=self.parent.descriptor,
                    follow_symlinks=False,
                )
            except (FileNotFoundError, NotADirectoryError):
                fail(f"{self.label} disappeared while held")
            if not stat.S_ISDIR(named.st_mode) or not same_identity(named, current):
                fail(f"{self.label} name no longer resolves to its held inode")

    def refresh_contents(self) -> None:
        """Refresh only legitimate directory-entry history, never security metadata."""

        self.metadata_watcher.reject_metadata_change()
        current = os.fstat(self.descriptor)
        if (
            not stat.S_ISDIR(current.st_mode)
            or not same_identity(current, self.metadata)
            or current.st_uid != self.metadata.st_uid
            or current.st_gid != self.metadata.st_gid
            or mode_bits(current) != mode_bits(self.metadata)
        ):
            fail(f"{self.label} security metadata changed during an authorized entry mutation")
        self.metadata = current

    def close(self) -> None:
        self.metadata_watcher.close()
        if self.parent_watcher is not None:
            self.parent_watcher.close()
        with contextlib.suppress(OSError):
            os.close(self.descriptor)


@dataclass
class WatchedFile:
    descriptor: int
    metadata: os.stat_result
    label: str
    parent: WatchedDirectory
    name: str
    parent_watcher: DirectoryEventWatcher
    metadata_watcher: MetadataWatcher
    digest: str | None = None

    @property
    def broker_path(self) -> str:
        return f"/proc/{os.getpid()}/fd/{self.descriptor}"

    @property
    def child_path(self) -> str:
        return f"/proc/self/fd/{self.descriptor}"

    def revalidate(self, *, expected_contents: bytes | None = None) -> None:
        self.metadata_watcher.reject_metadata_change()
        current = os.fstat(self.descriptor)
        self.parent_watcher.require_target_unchanged(self.name)
        try:
            named = os.stat(
                self.name,
                dir_fd=self.parent.descriptor,
                follow_symlinks=False,
            )
        except (FileNotFoundError, NotADirectoryError):
            fail(f"{self.label} disappeared while held")
        if (
            not stat.S_ISREG(current.st_mode)
            or stable_file_metadata(current) != stable_file_metadata(self.metadata)
            or stable_file_metadata(named) != stable_file_metadata(self.metadata)
            or current.st_uid != os.getuid()
            or mode_bits(current) != 0o600
            or current.st_nlink != 1
        ):
            fail(f"{self.label} changed, linked, or was substituted while held")
        if expected_contents is not None:
            os.lseek(self.descriptor, 0, os.SEEK_SET)
            observed = bytearray()
            while len(observed) <= len(expected_contents):
                block = os.read(self.descriptor, min(1024 * 1024, len(expected_contents) + 1 - len(observed)))
                if not block:
                    break
                observed.extend(block)
            if bytes(observed) != expected_contents:
                fail(f"{self.label} content changed while held")
        self.metadata_watcher.reject_metadata_change()
        self.parent_watcher.require_target_unchanged(self.name)

    def close(self) -> None:
        self.metadata_watcher.close()
        self.parent_watcher.close()
        with contextlib.suppress(OSError):
            os.close(self.descriptor)


@dataclass
class HeldFile:
    """A named regular file held from before its first metadata capture."""

    descriptor: int
    metadata: os.stat_result
    label: str
    parent: WatchedDirectory
    name: str
    parent_watcher: DirectoryEventWatcher
    metadata_watcher: MetadataWatcher
    root_owned: bool = False
    executable: bool = False
    sealed: bool = False

    @property
    def broker_path(self) -> str:
        return f"/proc/{os.getpid()}/fd/{self.descriptor}"

    @property
    def child_path(self) -> str:
        return f"/proc/self/fd/{self.descriptor}"

    def revalidate(self) -> None:
        self.metadata_watcher.reject_metadata_change()
        current = os.fstat(self.descriptor)
        self.parent_watcher.require_target_unchanged(self.name)
        try:
            named = os.stat(
                self.name,
                dir_fd=self.parent.descriptor,
                follow_symlinks=False,
            )
        except (FileNotFoundError, NotADirectoryError):
            fail(f"{self.label} disappeared while held")
        if (
            not stat.S_ISREG(current.st_mode)
            or stable_file_metadata(current) != stable_file_metadata(self.metadata)
            or stable_file_metadata(named) != stable_file_metadata(self.metadata)
            or (current.st_nlink not in (0, 1) if self.sealed else current.st_nlink != 1)
        ):
            fail(f"{self.label} changed, linked, or was substituted while held")
        if self.root_owned and (
            current.st_uid != 0 or mode_bits(current) & 0o022
        ):
            fail(f"{self.label} is not a root-owned non-writable executable")
        if self.executable and not mode_bits(current) & 0o111:
            fail(f"{self.label} is not executable")
        self.metadata_watcher.reject_metadata_change()
        self.parent_watcher.require_target_unchanged(self.name)

    def close(self) -> None:
        self.metadata_watcher.close()
        self.parent_watcher.close()
        with contextlib.suppress(OSError):
            os.close(self.descriptor)


@dataclass
class WatchedLink:
    parent: WatchedDirectory
    name: str
    target: str
    metadata: os.stat_result
    label: str
    parent_watcher: DirectoryEventWatcher

    def revalidate(self) -> None:
        self.parent_watcher.require_target_unchanged(self.name)
        try:
            current = os.stat(
                self.name,
                dir_fd=self.parent.descriptor,
                follow_symlinks=False,
            )
            target = os.readlink(self.name, dir_fd=self.parent.descriptor)
        except (FileNotFoundError, NotADirectoryError, OSError):
            fail(f"{self.label} disappeared while held")
        if (
            not stat.S_ISLNK(current.st_mode)
            or stable_file_metadata(current) != stable_file_metadata(self.metadata)
            or current.st_nlink != 1
            or target != self.target
        ):
            fail(f"{self.label} changed, linked, or was substituted while held")
        self.parent_watcher.require_target_unchanged(self.name)

    def close(self) -> None:
        self.parent_watcher.close()


class WatchedAuthorityTree:
    """Audited watch-before-target primitive for every mutable Pin namespace."""

    def __init__(self) -> None:
        descriptor = os.open(os.sep, DIRECTORY_FLAGS)
        metadata = os.fstat(descriptor)
        self.root = WatchedDirectory(
            descriptor,
            metadata,
            "filesystem root",
            None,
            None,
            None,
            MetadataWatcher(descriptor, "filesystem root"),
            contents_mutable=True,
        )
        self.directories: list[WatchedDirectory] = [self.root]
        self.files: list[HeldFile | WatchedFile] = []
        self.links: list[WatchedLink] = []

    @staticmethod
    def _safe_component(name: str, label: str) -> None:
        if not SAFE_NAME.fullmatch(name) or name in (".", ".."):
            fail(f"{label} has an unsafe path component")

    @staticmethod
    def _open_after_watch(
        parent: WatchedDirectory,
        name: str,
        label: str,
        edge: DirectoryEventWatcher,
        *,
        private: bool,
        contents_mutable: bool,
        created_token: str | None = None,
        expected_action: int | None = None,
    ) -> WatchedDirectory:
        descriptor: int | None = None
        metadata_watcher: MetadataWatcher | None = None
        try:
            before = os.stat(name, dir_fd=parent.descriptor, follow_symlinks=False)
            descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent.descriptor)
            metadata_watcher = MetadataWatcher(descriptor, label)
            opened = os.fstat(descriptor)
            after = os.stat(name, dir_fd=parent.descriptor, follow_symlinks=False)
            edge.require_target_unchanged(name, expected_action=expected_action)
            metadata_watcher.reject_metadata_change()
            if (
                not stat.S_ISDIR(before.st_mode)
                or not same_identity(before, opened)
                or stable_directory_metadata(opened) != stable_directory_metadata(after)
            ):
                fail(f"{label} changed while its watched descriptor was acquired")
            if private:
                require_private_directory(opened, label)
            return WatchedDirectory(
                descriptor,
                opened,
                label,
                parent,
                name,
                edge,
                metadata_watcher,
                contents_mutable=contents_mutable,
                created_token=created_token,
            )
        except BaseException:
            if metadata_watcher is not None:
                metadata_watcher.close()
            if descriptor is not None:
                os.close(descriptor)
            edge.close()
            raise

    def open_existing_child(
        self,
        parent: WatchedDirectory,
        name: str,
        label: str,
        *,
        private: bool = True,
        contents_mutable: bool = False,
    ) -> WatchedDirectory:
        self._safe_component(name, label)
        edge = DirectoryEventWatcher(parent.descriptor, f"{label} parent/name")
        edge.require_target_unchanged(name)
        try:
            result = self._open_after_watch(
                parent,
                name,
                label,
                edge,
                private=private,
                contents_mutable=contents_mutable,
            )
        except BaseException:
            # _open_after_watch owns the watcher after entry; a missing name
            # fails before it can acquire the descriptor, but still closes it.
            raise
        self.directories.append(result)
        return result

    def create_random_child(
        self,
        parent: WatchedDirectory,
        prefix: str,
        label: str,
        *,
        contents_mutable: bool = False,
    ) -> WatchedDirectory:
        if not SAFE_PREFIX.fullmatch(prefix):
            fail(f"{label} random prefix is unsafe")
        for _ in range(128):
            token = secrets.token_hex(16)
            name = f"{prefix}{token}"
            edge = DirectoryEventWatcher(parent.descriptor, f"{label} parent/name")
            edge.require_target_unchanged(name)
            try:
                os.mkdir(name, 0o700, dir_fd=parent.descriptor)
            except FileExistsError:
                edge.close()
                continue
            try:
                result = self._open_after_watch(
                    parent,
                    name,
                    label,
                    edge,
                    private=True,
                    contents_mutable=contents_mutable,
                    created_token=token,
                    expected_action=DirectoryEventWatcher.IN_CREATE,
                )
            except StoreError:
                # Never rmdir a name after a post-mkdir failure. A hostile
                # process may have substituted it; the unique token is simply
                # quarantined and a later session chooses a fresh token.
                raise
            self.directories.append(result)
            parent.refresh_contents()
            return result
        fail(f"could not allocate a unique watched directory for {label}")

    def create_fixed_child(
        self,
        parent: WatchedDirectory,
        name: str,
        label: str,
        *,
        contents_mutable: bool = False,
    ) -> WatchedDirectory:
        self._safe_component(name, label)
        final_edge = DirectoryEventWatcher(parent.descriptor, f"{label} final parent/name")
        final_edge.require_target_unchanged(name)
        try:
            os.stat(name, dir_fd=parent.descriptor, follow_symlinks=False)
        except FileNotFoundError:
            stage = self.create_random_child(
                parent,
                f".{name}.prepare.",
                f"{label} staged creation",
            )
            stage.revalidate()
            final_edge.require_target_unchanged(name)
            assert stage.name is not None and stage.parent_watcher is not None
            if not rename_noreplace(parent.descriptor, stage.name, parent.descriptor, name):
                final_edge.close()
                fail(f"{label} appeared during no-replace installation; staged token is quarantined")
            stage.parent_watcher.require_target_unchanged(
                stage.name,
                expected_action=DirectoryEventWatcher.IN_MOVED_FROM,
            )
            final_edge.require_target_unchanged(
                name,
                expected_action=DirectoryEventWatcher.IN_MOVED_TO,
            )
            stage.parent_watcher.close()
            stage.parent_watcher = final_edge
            stage.name = name
            stage.label = label
            stage.contents_mutable = contents_mutable
            stage.refresh_contents()
            stage.revalidate()
            parent.refresh_contents()
            return stage
        else:
            result = self._open_after_watch(
                parent,
                name,
                label,
                final_edge,
                private=True,
                contents_mutable=contents_mutable,
            )
            self.directories.append(result)
            return result

    def open_absolute(
        self,
        value: str,
        label: str,
        *,
        create: bool = False,
        private_final: bool = False,
        contents_mutable: bool = False,
    ) -> WatchedDirectory:
        candidate = require_canonical_absolute(value, label)
        current = self.root
        for index, component in enumerate(Path(candidate).parts[1:]):
            final = index == len(Path(candidate).parts[1:]) - 1
            component_label = label if final else f"{label} ancestor {component}"
            try:
                current = self.open_existing_child(
                    current,
                    component,
                    component_label,
                    private=private_final and final,
                    contents_mutable=contents_mutable if final else True,
                )
            except FileNotFoundError:
                if not create:
                    raise
                current = self.create_fixed_child(
                    current,
                    component,
                    component_label,
                    contents_mutable=contents_mutable if final else True,
                )
        return current

    def create_file(
        self,
        parent: WatchedDirectory,
        prefix: str,
        label: str,
        contents: bytes,
    ) -> WatchedFile:
        return self.create_committed_file(parent, prefix, label, contents)

    def create_committed_file(
        self,
        parent: WatchedDirectory,
        prefix: str,
        label: str,
        contents: bytes,
    ) -> WatchedFile:
        """Link one exact unnamed inode as the final append-only commit."""

        if not SAFE_PREFIX.fullmatch(prefix):
            fail(f"{label} file prefix is unsafe")
        temporary_flags = (
            os.O_RDWR | getattr(os, "O_TMPFILE", 0o20200000) |
            getattr(os, "O_CLOEXEC", 0)
        )
        for _ in range(128):
            name = f"{prefix}{secrets.token_hex(16)}"
            edge = DirectoryEventWatcher(parent.descriptor, f"{label} parent/name")
            edge.require_target_unchanged(name)
            descriptor: int | None = None
            precommit_watcher: MetadataWatcher | None = None
            try:
                descriptor = os.open(".", temporary_flags, 0o600, dir_fd=parent.descriptor)
                view = memoryview(contents)
                while view:
                    written = os.write(descriptor, view)
                    view = view[written:]
                os.fsync(descriptor)
                precommit_watcher = MetadataWatcher(descriptor, f"{label} unnamed inode")
                before = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(before.st_mode)
                    or before.st_uid != os.getuid()
                    or mode_bits(before) != 0o600
                    or before.st_nlink != 0
                    or before.st_size != len(contents)
                    or descriptor_digest(descriptor) != hashlib.sha256(contents).hexdigest()
                ):
                    fail(f"{label} unnamed inode failed its precommit contract")
                precommit_watcher.reject_metadata_change()
                edge.require_target_unchanged(name)
                parent.revalidate()
                if not linkat_empty(descriptor, parent.descriptor, name):
                    precommit_watcher.close()
                    precommit_watcher = None
                    edge.close()
                    os.close(descriptor)
                    descriptor = None
                    continue
                precommit_watcher.require_unnamed_link_commit()
                edge.require_target_unchanged(
                    name,
                    expected_action=DirectoryEventWatcher.IN_CREATE,
                )
                after = os.fstat(descriptor)
                named = os.stat(name, dir_fd=parent.descriptor, follow_symlinks=False)
                if (
                    not stat.S_ISREG(after.st_mode)
                    or stable_file_metadata(after) != stable_file_metadata(named)
                    or after.st_uid != os.getuid()
                    or mode_bits(after) != 0o600
                    or after.st_nlink != 1
                    or after.st_size != len(contents)
                ):
                    fail(f"{label} changed during its exact-inode commit")
                result = WatchedFile(
                    descriptor,
                    after,
                    label,
                    parent,
                    name,
                    edge,
                    precommit_watcher,
                    hashlib.sha256(contents).hexdigest(),
                )
                result.revalidate(expected_contents=contents)
                parent.refresh_contents()
                self.files.append(result)
                precommit_watcher = None
                return result
            except BaseException:
                if precommit_watcher is not None:
                    precommit_watcher.close()
                if descriptor is not None:
                    os.close(descriptor)
                edge.close()
                raise
        fail(f"could not allocate a unique committed file for {label}")

    def create_named_file(
        self,
        parent: WatchedDirectory,
        name: str,
        label: str,
        contents: bytes,
    ) -> WatchedFile:
        self._safe_component(name, label)
        edge = DirectoryEventWatcher(parent.descriptor, f"{label} parent/name")
        edge.require_target_unchanged(name)
        try:
            os.stat(name, dir_fd=parent.descriptor, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            edge.close()
            fail(f"{label} already exists; append-only publication never overwrites")
        descriptor: int | None = None
        watcher: MetadataWatcher | None = None
        try:
            descriptor = os.open(
                ".",
                os.O_RDWR | getattr(os, "O_TMPFILE", 0o20200000) |
                getattr(os, "O_CLOEXEC", 0),
                0o600,
                dir_fd=parent.descriptor,
            )
            view = memoryview(contents)
            while view:
                written = os.write(descriptor, view)
                view = view[written:]
            os.fsync(descriptor)
            watcher = MetadataWatcher(descriptor, f"{label} unnamed destination")
            before = os.fstat(descriptor)
            expected_digest = hashlib.sha256(contents).hexdigest()
            if (
                not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or
                mode_bits(before) != 0o600 or before.st_nlink != 0 or
                before.st_size != len(contents) or descriptor_digest(descriptor) != expected_digest
            ):
                fail(f"{label} unnamed destination failed its content contract")
            watcher.reject_metadata_change()
            edge.require_target_unchanged(name)
            parent.revalidate()
            if not linkat_empty(descriptor, parent.descriptor, name):
                fail(f"{label} appeared during exact-inode commit")
            watcher.require_unnamed_link_commit()
            edge.require_target_unchanged(name, expected_action=DirectoryEventWatcher.IN_CREATE)
            metadata = os.fstat(descriptor)
            named = os.stat(name, dir_fd=parent.descriptor, follow_symlinks=False)
            if (
                stable_file_metadata(metadata) != stable_file_metadata(named) or
                metadata.st_uid != os.getuid() or mode_bits(metadata) != 0o600 or
                metadata.st_nlink != 1 or metadata.st_size != len(contents) or
                descriptor_digest(descriptor) != expected_digest
            ):
                fail(f"{label} changed during exact-inode commit")
            result = WatchedFile(
                descriptor,
                metadata,
                label,
                parent,
                name,
                edge,
                watcher,
                expected_digest,
            )
            result.revalidate(expected_contents=contents)
            parent.refresh_contents()
            self.files.append(result)
            watcher = None
            descriptor = None
            return result
        except BaseException:
            if watcher is not None:
                watcher.close()
            if descriptor is not None:
                os.close(descriptor)
            edge.close()
            # The exact unique stage/record is quarantined on error. Never
            # unlink a name which may have been exchanged after the last check.
            raise

    def create_named_file_from_held(
        self,
        parent: WatchedDirectory,
        name: str,
        label: str,
        source: HeldFile,
        *,
        maximum_size: int = 512 * 1024 * 1024,
    ) -> tuple[WatchedFile, str, int]:
        self._safe_component(name, label)
        source.revalidate()
        if source.metadata.st_uid != os.getuid() or not 0 < source.metadata.st_size <= maximum_size:
            fail(f"{source.label} must be one bounded owner-owned regular file")
        edge = DirectoryEventWatcher(parent.descriptor, f"{label} parent/name")
        edge.require_target_unchanged(name)
        try:
            os.stat(name, dir_fd=parent.descriptor, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            edge.close()
            fail(f"{label} already exists; append-only publication never overwrites")
        source_digest = descriptor_digest(source.descriptor)
        source.revalidate()
        descriptor: int | None = None
        watcher: MetadataWatcher | None = None
        try:
            descriptor = os.open(
                ".",
                os.O_RDWR | getattr(os, "O_TMPFILE", 0o20200000) |
                getattr(os, "O_CLOEXEC", 0),
                0o600,
                dir_fd=parent.descriptor,
            )
            total = 0
            offset = 0
            while True:
                block = os.pread(source.descriptor, 1024 * 1024, offset)
                if not block:
                    break
                view = memoryview(block)
                while view:
                    written = os.write(descriptor, view)
                    view = view[written:]
                    total += written
                offset += len(block)
            os.fsync(descriptor)
            watcher = MetadataWatcher(descriptor, f"{label} unnamed destination")
            if total != source.metadata.st_size:
                fail(f"{source.label} changed size while copied")
            destination_digest = descriptor_digest(descriptor)
            before = os.fstat(descriptor)
            if (
                destination_digest != source_digest or before.st_size != source.metadata.st_size or
                not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or
                mode_bits(before) != 0o600 or before.st_nlink != 0
            ):
                fail(f"{label} destination bytes do not bind the held compiler artifact")
            source.revalidate()
            if descriptor_digest(source.descriptor) != source_digest:
                fail(f"{source.label} changed while copied")
            watcher.reject_metadata_change()
            edge.require_target_unchanged(name)
            parent.revalidate()
            if not linkat_empty(descriptor, parent.descriptor, name):
                fail(f"{label} appeared during exact-inode commit")
            watcher.require_unnamed_link_commit()
            edge.require_target_unchanged(name, expected_action=DirectoryEventWatcher.IN_CREATE)
            metadata = os.fstat(descriptor)
            named = os.stat(name, dir_fd=parent.descriptor, follow_symlinks=False)
            if (
                stable_file_metadata(metadata) != stable_file_metadata(named) or
                metadata.st_nlink != 1 or metadata.st_uid != os.getuid() or
                mode_bits(metadata) != 0o600 or metadata.st_size != total or
                descriptor_digest(descriptor) != source_digest
            ):
                fail(f"{label} destination changed during exact-inode commit")
            result = WatchedFile(
                descriptor,
                metadata,
                label,
                parent,
                name,
                edge,
                watcher,
                source_digest,
            )
            result.revalidate()
            source.revalidate()
            parent.refresh_contents()
            self.files.append(result)
            watcher = None
            descriptor = None
            return result, source_digest, total
        except BaseException:
            if watcher is not None:
                watcher.close()
            if descriptor is not None:
                os.close(descriptor)
            edge.close()
            raise

    def open_file(
        self,
        parent: WatchedDirectory,
        name: str,
        label: str,
        *,
        root_owned: bool = False,
        executable: bool = False,
        sealed: bool = False,
    ) -> HeldFile:
        self._safe_component(name, label)
        edge = DirectoryEventWatcher(parent.descriptor, f"{label} parent/name")
        edge.require_target_unchanged(name)
        descriptor: int | None = None
        watcher: MetadataWatcher | None = None
        try:
            before = os.stat(name, dir_fd=parent.descriptor, follow_symlinks=False)
            if (
                not stat.S_ISREG(before.st_mode) or
                (before.st_nlink not in (0, 1) if sealed else before.st_nlink != 1)
            ):
                fail(f"{label} is not one single-link regular file")
            descriptor = os.open(name, FILE_FLAGS, dir_fd=parent.descriptor)
            watcher = MetadataWatcher(descriptor, label)
            opened = os.fstat(descriptor)
            after = os.stat(name, dir_fd=parent.descriptor, follow_symlinks=False)
            edge.require_target_unchanged(name)
            watcher.reject_metadata_change()
            if (
                not stat.S_ISREG(before.st_mode)
                or stable_file_metadata(before) != stable_file_metadata(opened)
                or stable_file_metadata(opened) != stable_file_metadata(after)
                or (opened.st_nlink not in (0, 1) if sealed else opened.st_nlink != 1)
            ):
                fail(f"{label} changed, linked, or was substituted while opened")
            result = HeldFile(
                descriptor,
                opened,
                label,
                parent,
                name,
                edge,
                watcher,
                root_owned=root_owned,
                executable=executable,
                sealed=sealed,
            )
            result.revalidate()
            self.files.append(result)
            return result
        except BaseException:
            if watcher is not None:
                watcher.close()
            if descriptor is not None:
                os.close(descriptor)
            edge.close()
            raise

    def create_link(
        self,
        parent: WatchedDirectory,
        name: str,
        target: WatchedDirectory,
        label: str,
    ) -> WatchedLink:
        self._safe_component(name, label)
        edge = DirectoryEventWatcher(parent.descriptor, f"{label} parent/name")
        edge.require_target_unchanged(name)
        target_path = target.child_path
        try:
            os.symlink(target_path, name, dir_fd=parent.descriptor)
            current = os.stat(
                name,
                dir_fd=parent.descriptor,
                follow_symlinks=False,
            )
            edge.require_target_unchanged(
                name,
                expected_action=DirectoryEventWatcher.IN_CREATE,
            )
            if (
                not stat.S_ISLNK(current.st_mode)
                or current.st_uid != os.getuid()
                or current.st_nlink != 1
                or os.readlink(name, dir_fd=parent.descriptor) != target_path
            ):
                fail(f"{label} was not created as one exact held-cache link")
            result = WatchedLink(parent, name, target_path, current, label, edge)
            result.revalidate()
            self.links.append(result)
            parent.refresh_contents()
            return result
        except BaseException:
            edge.close()
            # The fresh random tool root is quarantined as a whole. Never
            # unlink a possibly substituted link name after a failure.
            raise

    def open_file_absolute(
        self,
        value: str,
        label: str,
        *,
        root_owned: bool = False,
        executable: bool = False,
        sealed: bool = False,
    ) -> HeldFile:
        candidate = require_canonical_absolute(value, label)
        parts = Path(candidate).parts[1:]
        if not parts:
            fail(f"{label} must name a regular file")
        current = self.root
        for component in parts[:-1]:
            current = self.open_existing_child(
                current,
                component,
                f"{label} ancestor {component}",
                private=False,
                contents_mutable=True,
            )
        return self.open_file(
            current,
            parts[-1],
            label,
            root_owned=root_owned,
            executable=executable,
            sealed=sealed,
        )

    def open_file_beneath(
        self,
        parent: WatchedDirectory,
        relative: str,
        label: str,
        *,
        executable: bool = False,
    ) -> HeldFile:
        if os.path.isabs(relative):
            fail(f"{label} must be relative to its held root")
        components = Path(relative).parts
        if not components or any(component in ("", ".", "..") for component in components):
            fail(f"{label} has unsafe relative ancestry")
        current = parent
        for component in components[:-1]:
            current = self.open_existing_child(
                current,
                component,
                f"{label} ancestor {component}",
                private=False,
                contents_mutable=True,
            )
        return self.open_file(current, components[-1], label, executable=executable)

    def revalidate_all(self) -> None:
        for link in self.links:
            link.revalidate()
        for held_file in self.files:
            held_file.revalidate()
        for directory in self.directories:
            directory.revalidate()

    def close(self) -> None:
        for link in reversed(self.links):
            link.close()
        self.links = []
        for held_file in reversed(self.files):
            held_file.close()
        self.files = []
        for directory in reversed(self.directories):
            directory.close()
        self.directories = []

    def __enter__(self) -> "WatchedAuthorityTree":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def require_canonical_absolute(path_value: str, label: str) -> str:
    candidate = os.path.abspath(path_value)
    if path_value != candidate or os.path.normpath(path_value) != path_value:
        fail(f"{label} must be a canonical absolute path: {path_value}")
    return candidate


def reject_source_path(candidate: str, label: str) -> None:
    source = os.path.realpath(SOURCE_ROOT)
    resolved = os.path.realpath(candidate)
    if resolved == source or resolved.startswith(source + os.sep):
        fail(f"{label} must be outside the read-only source tree: {candidate}")


def require_private_directory(metadata: os.stat_result, label: str) -> None:
    if not stat.S_ISDIR(metadata.st_mode):
        fail(f"{label} is not a directory")
    if metadata.st_uid != os.getuid() or mode_bits(metadata) != 0o700:
        fail(f"{label} must be owner-owned mode 0700")


def rename_noreplace(
    source_parent: int,
    source: str,
    destination_parent: int,
    destination: str,
) -> bool:
    libc = ctypes.CDLL(None, use_errno=True)
    operation = getattr(libc, "renameat2", None)
    if operation is None:
        fail("safe fixed-directory handoff requires Linux renameat2")
    operation.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    operation.restype = ctypes.c_int
    if operation(
        source_parent,
        os.fsencode(source),
        destination_parent,
        os.fsencode(destination),
        1,  # RENAME_NOREPLACE
    ) == 0:
        return True
    error_number = ctypes.get_errno()
    if error_number in (errno.EEXIST, errno.ENOTEMPTY):
        return False
    raise OSError(error_number, os.strerror(error_number))


def linkat_empty(source_descriptor: int, destination_parent: int, destination: str) -> bool:
    libc = ctypes.CDLL(None, use_errno=True)
    operation = getattr(libc, "linkat", None)
    if operation is None:
        fail("append-only publication requires Linux linkat(AT_EMPTY_PATH)")
    operation.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
    ]
    operation.restype = ctypes.c_int
    if operation(
        source_descriptor,
        b"",
        destination_parent,
        os.fsencode(destination),
        0x1000,  # AT_EMPTY_PATH
    ) == 0:
        return True
    error_number = ctypes.get_errno()
    if error_number == errno.EEXIST:
        return False
    raise OSError(error_number, os.strerror(error_number))


def open_authorized_directory_path(
    tree: WatchedAuthorityTree,
    value: str,
    label: str,
    *,
    private: bool,
    contents_mutable: bool,
) -> WatchedDirectory:
    candidate = require_canonical_absolute(value, label)
    matched = PROC_FD_PATH.fullmatch(candidate)
    if matched is None:
        return tree.open_absolute(
            candidate,
            label,
            private_final=private,
            contents_mutable=contents_mutable,
        )
    suffix = matched.group(1)
    base = candidate if suffix is None else candidate[: -(len(suffix) + 1)]
    before = os.stat(base, follow_symlinks=True)
    descriptor = os.open(
        base,
        os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0),
    )
    watcher: MetadataWatcher | None = None
    try:
        watcher = MetadataWatcher(descriptor, f"{label} inherited authority")
        opened = os.fstat(descriptor)
        after = os.stat(base, follow_symlinks=True)
        watcher.reject_metadata_change()
        if (
            not stat.S_ISDIR(opened.st_mode)
            or stable_directory_metadata(before) != stable_directory_metadata(opened)
            or stable_directory_metadata(opened) != stable_directory_metadata(after)
        ):
            fail(f"{label} inherited descriptor changed while duplicated")
        if private:
            require_private_directory(opened, label)
        current = WatchedDirectory(
            descriptor,
            opened,
            label if suffix is None else f"{label} held ancestor",
            None,
            None,
            None,
            watcher,
            contents_mutable=contents_mutable,
        )
        tree.directories.append(current)
        descriptor = -1
        watcher = None
    finally:
        if watcher is not None:
            watcher.close()
        if descriptor >= 0:
            os.close(descriptor)
    if suffix is None:
        return current
    components = Path(suffix).parts
    if not components or any(component in ("", ".", "..") for component in components):
        fail(f"{label} has unsafe descriptor-relative ancestry")
    for index, component in enumerate(components):
        current = tree.open_existing_child(
            current,
            component,
            label if index == len(components) - 1 else f"{label} ancestor {component}",
            private=private and index == len(components) - 1,
            contents_mutable=contents_mutable if index == len(components) - 1 else True,
        )
    return current


def validate_roles(values: Iterable[str]) -> tuple[str, ...]:
    roles = tuple(values)
    if not roles or len(set(roles)) != len(roles) or any(role not in DEBUG_ROLES for role in roles):
        fail("debug roles must be a nonempty unique subset of the fixed five-role inventory")
    if roles != tuple(role for role in DEBUG_ROLES if role in roles):
        fail("debug roles must use the fixed five-role order")
    return roles


def descriptor_digest(descriptor: int) -> str:
    digest = hashlib.sha256()
    offset = 0
    while True:
        block = os.pread(descriptor, 1024 * 1024, offset)
        if not block:
            return digest.hexdigest()
        digest.update(block)
        offset += len(block)


def bounded_descriptor_bytes(descriptor: int, maximum: int, label: str) -> bytes:
    metadata = os.fstat(descriptor)
    if metadata.st_size < 0 or metadata.st_size > maximum:
        fail(f"{label} exceeds its size bound")
    value = os.pread(descriptor, metadata.st_size + 1, 0)
    if len(value) != metadata.st_size:
        fail(f"{label} changed while read")
    return value


def strict_json_bytes(value: bytes, label: str) -> dict[str, object]:
    def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, child in pairs:
            if key in result:
                fail(f"{label} repeats JSON key {key}")
            result[key] = child
        return result

    try:
        parsed = json.loads(value.decode("utf-8", "strict"), object_pairs_hook=unique)
    except (UnicodeError, json.JSONDecodeError) as error:
        fail(f"{label} is malformed JSON: {error}")
    if not isinstance(parsed, dict):
        fail(f"{label} must be a JSON object")
    return parsed


def require_private_regular(held_file: HeldFile | WatchedFile, label: str) -> None:
    held_file.revalidate()
    metadata = os.fstat(held_file.descriptor)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or mode_bits(metadata) != 0o600
        or metadata.st_nlink != 1
    ):
        fail(f"{label} must be owner-owned mode 0600 and single-link")


APK_ANALYZER = "/opt/android-sdk/cmdline-tools/15859902/bin/apkanalyzer"
APK_SIGNER = "/opt/android-sdk/build-tools/35.0.0/apksigner"
ZIPALIGN = "/opt/android-sdk/build-tools/35.0.0/zipalign"


def apk_tool(
    apk: HeldFile,
    arguments: tuple[str, ...],
    label: str,
    *,
    capture: bool = False,
) -> str:
    apk.revalidate()
    completed = subprocess.run(
        [*arguments, apk.child_path],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        close_fds=True,
        pass_fds=(apk.descriptor,),
        timeout=300,
    )
    apk.revalidate()
    if completed.returncode < 0:
        raise ChildSignal(-completed.returncode)
    if completed.returncode != 0:
        detail = (completed.stderr or "").strip()[-1000:]
        fail(f"{label} failed against the held APK{': ' + detail if detail else ''}")
    output = completed.stdout if capture else ""
    if len(output) > 16 * 1024:
        fail(f"{label} returned oversized metadata")
    return output


def apk_metadata(apk: HeldFile, field: str) -> str:
    output = apk_tool(
        apk,
        (APK_ANALYZER, "manifest", field),
        f"apkanalyzer {field}",
        capture=True,
    )
    lines = output.splitlines()
    if len(lines) != 1 or not lines[0]:
        fail(f"held APK has ambiguous {field} metadata")
    return lines[0]


@dataclass
class VerifiedSet:
    directory: WatchedDirectory
    set_id: str
    roles: tuple[str, ...]
    files: dict[str, HeldFile | WatchedFile]
    expected_inventory: tuple[str, ...]
    inventory_watcher: DirectoryEventWatcher

    def revalidate(self) -> None:
        self.inventory_watcher.require_no_changes()
        self.directory.revalidate()
        for held in self.files.values():
            held.revalidate()
        if tuple(sorted(os.listdir(self.directory.descriptor))) != self.expected_inventory:
            fail("published debug set inventory changed while held")
        self.inventory_watcher.require_no_changes()

    def close(self) -> None:
        self.inventory_watcher.close()


@dataclass(frozen=True)
class JournalRecordSnapshot:
    contents: bytes
    digest: str
    segment_index: int


@dataclass
class ChainState:
    records: tuple[dict[str, object], ...]
    next_sequence: int
    predecessor: str
    retired: frozenset[str]
    retired_set_ids: frozenset[str]


CHAIN_ZERO = "0" * 64
CHAIN_SEGMENT_SIZE = 256


class AppendOnlyDebugStore:
    """Publication with no overwrite, rename-over-existing, unlink, or rmdir."""

    def __init__(self, root_value: str) -> None:
        self.root_value = require_canonical_absolute(root_value, "debug artifact root")
        reject_source_path(self.root_value, "debug artifact root")
        self.tree = WatchedAuthorityTree()
        self.root = open_authorized_directory_path(
            self.tree,
            self.root_value,
            "debug artifact root",
            private=True,
            contents_mutable=True,
        )
        self.sets = self.tree.create_fixed_child(
            self.root,
            "sets",
            "debug set namespace",
            contents_mutable=True,
        )
        self.selections = self.tree.create_fixed_child(
            self.root,
            "selections",
            "debug append-only journal namespace",
            contents_mutable=True,
        )
        self.journal_segments = self.tree.create_fixed_child(
            self.selections,
            "segments",
            "debug journal segments",
            contents_mutable=True,
        )
        self.journal_anchors = self.tree.create_fixed_child(
            self.selections,
            "anchors",
            "debug journal redundant anchors",
            contents_mutable=True,
        )
        self.journal_high_water = self.tree.create_fixed_child(
            self.selections,
            "high-water",
            "debug journal reconciliation high-water facts",
            contents_mutable=True,
        )
        self.retirement_facts = self.tree.create_fixed_child(
            self.selections,
            "retired-set-ids",
            "debug retirement permanence facts",
            contents_mutable=True,
        )
        try:
            self.chain_lock = self.tree.open_file(
                self.selections,
                ".chain-lock",
                "debug journal lock",
            )
            require_private_regular(self.chain_lock, "debug journal lock")
        except FileNotFoundError:
            self.chain_lock = self.tree.create_named_file(
                self.selections,
                ".chain-lock",
                "debug journal lock",
                b"",
            )
        fcntl.flock(self.chain_lock.descriptor, fcntl.LOCK_EX)
        self._verified_sets: list[VerifiedSet] = []

    def allocate_stage(self) -> WatchedDirectory:
        return self.tree.create_random_child(
            self.sets,
            ".set.",
            "debug set stage/final directory",
            contents_mutable=True,
        )

    def _open_output_directory(self, value: str, role: str) -> WatchedDirectory:
        candidate = require_canonical_absolute(value, f"{role} Gradle APK output")
        reject_source_path(candidate, f"{role} Gradle APK output")
        return open_authorized_directory_path(
            self.tree,
            candidate,
            f"{role} Gradle APK output",
            private=False,
            contents_mutable=True,
        )

    def _select_role_apk(self, role: str, output_value: str) -> HeldFile:
        output = self._open_output_directory(output_value, role)
        inventory_watcher = DirectoryEventWatcher(
            output.descriptor,
            f"{role} Gradle output inventory",
        )
        inventory_watcher.require_no_changes()
        names = sorted(name for name in os.listdir(output.child_path) if name.endswith(".apk"))
        if not names or len(names) > 32:
            fail(f"{role} Gradle output has no bounded APK inventory")
        selected: HeldFile | None = None
        for name in names:
            if not SAFE_NAME.fullmatch(name):
                fail(f"{role} Gradle output contains an unsafe APK name")
            candidate = self.tree.open_file(output, name, f"{role} Gradle APK candidate")
            if candidate.metadata.st_uid != os.getuid() or not 0 < candidate.metadata.st_size <= 512 * 1024 * 1024:
                fail(f"{role} Gradle APK candidate is not one bounded owner-owned file")
            if apk_metadata(candidate, "application-id") == ROLE_PACKAGES[role]:
                if selected is not None:
                    fail(f"{role} Gradle output contains multiple matching APKs")
                selected = candidate
        if selected is None:
            fail(f"{role} Gradle output has no APK for {ROLE_PACKAGES[role]}")
        if names != sorted(name for name in os.listdir(output.child_path) if name.endswith(".apk")):
            fail(f"{role} Gradle APK inventory changed while selected")
        inventory_watcher.require_no_changes()
        inventory_watcher.close()
        return selected

    def stage_role(self, stage: WatchedDirectory, role: str, output_value: str) -> dict[str, object]:
        apk = self._select_role_apk(role, output_value)
        version_name = apk_metadata(apk, "version-name")
        version_code_raw = apk_metadata(apk, "version-code")
        minimum_sdk = apk_metadata(apk, "min-sdk")
        target_sdk = apk_metadata(apk, "target-sdk")
        debuggable = apk_metadata(apk, "debuggable")
        if not VERSION_NAME.fullmatch(version_name):
            fail(f"{role} debug versionName is malformed")
        if not re.fullmatch(r"[1-9][0-9]{0,9}", version_code_raw):
            fail(f"{role} debug versionCode is malformed")
        if minimum_sdk != "31" or target_sdk != "32" or debuggable != "true":
            fail(f"{role} debug manifest contract changed")
        apk_tool(apk, (APK_SIGNER, "verify", "--Werr"), f"{role} APK signature verification")
        signer_output = apk_tool(
            apk,
            (APK_SIGNER, "verify", "--print-certs", "--Werr"),
            f"{role} APK signer inspection",
            capture=True,
        )
        signers = re.findall(
            r"^Signer #1 certificate SHA-256 digest: ([0-9A-Fa-f:]+)$",
            signer_output,
            flags=re.MULTILINE,
        )
        if len(signers) != 1:
            fail(f"{role} debug APK exposes an ambiguous signer identity")
        signer = signers[0].replace(":", "").lower()
        if not HEX_256.fullmatch(signer) or signer == COMPATIBILITY_CERT_SHA256:
            fail(f"{role} debug APK used an invalid or release signer")
        apk_tool(apk, (ZIPALIGN, "-c", "-P", "16", "4"), f"{role} APK alignment")
        staged, digest, size = self.tree.create_named_file_from_held(
            stage,
            f"{role}.apk",
            f"staged {role} debug APK",
            apk,
        )
        staged.revalidate()
        receipt: dict[str, object] = {
            "schema": "revival.pin-debug-artifact",
            "version": 2,
            "role": role,
            "package": ROLE_PACKAGES[role],
            "variant": "debug",
            "versionName": version_name,
            "versionCode": int(version_code_raw),
            "minSdk": 31,
            "targetSdk": 32,
            "debuggable": True,
            "payloadComplete": False,
            "release": False,
            "installable": False,
            "signerSha256": signer,
            "sha256": digest,
            "size": size,
        }
        receipt_bytes = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        if len(receipt_bytes) > 4096:
            fail(f"{role} debug receipt exceeds its bound")
        self.tree.create_named_file(
            stage,
            f"{role}.receipt.json",
            f"staged {role} debug receipt",
            receipt_bytes,
        )
        return receipt

    @staticmethod
    def _manifest_base(roles: tuple[str, ...], receipts: list[dict[str, object]]) -> dict[str, object]:
        return {
            "schema": "revival.pin-debug-set",
            "version": 2,
            "roles": list(roles),
            "payloadComplete": False,
            "release": False,
            "installable": False,
            "artifacts": receipts,
        }

    def finalize(self, stage: WatchedDirectory, roles: tuple[str, ...], receipts: list[dict[str, object]]) -> str:
        base = self._manifest_base(roles, receipts)
        canonical = json.dumps(base, sort_keys=True, separators=(",", ":")).encode()
        set_id = hashlib.sha256(canonical).hexdigest()
        manifest = {**base, "setId": set_id}
        manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        self.tree.create_named_file(stage, "manifest.json", "debug set manifest", manifest_bytes)
        checksum_lines: list[str] = []
        for name in sorted(
            [*(f"{role}.apk" for role in roles), *(f"{role}.receipt.json" for role in roles), "manifest.json"]
        ):
            held_file = next(
                child for child in self.tree.files
                if isinstance(child, WatchedFile) and child.parent is stage and child.name == name
            )
            checksum_lines.append(f"{descriptor_digest(held_file.descriptor)}  {name}\n")
        self.tree.create_named_file(
            stage,
            "SHA256SUMS",
            "debug set checksums",
            "".join(checksum_lines).encode("ascii"),
        )
        self.tree.revalidate_all()
        return set_id

    def _close_chain_watchers(self) -> None:
        for watcher in reversed(getattr(self, "_chain_watchers", [])):
            watcher.close()
        self._chain_watchers = []

    @staticmethod
    def _segment_name(index: int) -> str:
        if not isinstance(index, int) or index < 0:
            fail("debug journal segment index is invalid")
        return f"segment-{index}"

    def _journal_inventory(
        self,
        root: WatchedDirectory,
        label: str,
    ) -> tuple[dict[str, JournalRecordSnapshot], tuple[str, ...]]:
        root_watcher = DirectoryEventWatcher(root.descriptor, f"{label} segment inventory")
        root_watcher.require_no_changes()
        self._chain_watchers.append(root_watcher)
        raw_segment_names = os.listdir(root.descriptor)
        segment_indexes: list[tuple[int, str]] = []
        for segment_name in raw_segment_names:
            match = re.fullmatch(r"segment-(0|[1-9][0-9]*)", segment_name)
            if match is None:
                fail(f"{label} has a noncanonical or unknown segment")
            segment_indexes.append((int(match.group(1)), segment_name))
        segment_indexes.sort()
        segment_names = [name for _index, name in segment_indexes]
        records: dict[str, JournalRecordSnapshot] = {}
        for expected_index, segment_name in enumerate(segment_names):
            if segment_name != self._segment_name(expected_index):
                fail(f"{label} has a fork, gap, or unknown segment")
            segment = self.tree.open_existing_child(
                root,
                segment_name,
                f"{label} {segment_name}",
                private=True,
                contents_mutable=True,
            )
            inventory = DirectoryEventWatcher(
                segment.descriptor,
                f"{label} {segment_name} record inventory",
            )
            inventory.require_no_changes()
            self._chain_watchers.append(inventory)
            names = sorted(os.listdir(segment.descriptor))
            for name in names:
                if not re.fullmatch(r"record-(?:[1-9][0-9]*)-[0-9a-f]{64}\.json", name):
                    fail(f"{label} contains an unknown record name")
                if name in records:
                    fail(f"{label} duplicates a record name")
                before = os.stat(name, dir_fd=segment.descriptor, follow_symlinks=False)
                if (
                    not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or
                    mode_bits(before) != 0o600 or before.st_nlink != 1
                ):
                    fail(f"{label} record {name} is not one private regular file")
                descriptor = os.open(name, FILE_FLAGS, dir_fd=segment.descriptor)
                opened = os.fstat(descriptor)
                after = os.stat(name, dir_fd=segment.descriptor, follow_symlinks=False)
                if (
                    stable_file_metadata(before) != stable_file_metadata(opened) or
                    stable_file_metadata(opened) != stable_file_metadata(after)
                ):
                    os.close(descriptor)
                    fail(f"{label} record {name} changed while opened")
                try:
                    contents = bounded_descriptor_bytes(
                        descriptor, 32 * 1024, f"{label} record {name}"
                    )
                    current = os.fstat(descriptor)
                    named = os.stat(name, dir_fd=segment.descriptor, follow_symlinks=False)
                    digest = hashlib.sha256(contents).hexdigest()
                    if (
                        stable_file_metadata(current) != stable_file_metadata(opened) or
                        stable_file_metadata(named) != stable_file_metadata(opened) or
                        current.st_uid != os.getuid() or mode_bits(current) != 0o600 or
                        current.st_nlink != 1 or current.st_size != len(contents)
                    ):
                        fail(f"{label} record {name} changed while read")
                    records[name] = JournalRecordSnapshot(
                        contents,
                        digest,
                        expected_index,
                    )
                finally:
                    os.close(descriptor)
            if names != sorted(os.listdir(segment.descriptor)):
                fail(f"{label} record inventory changed while held")
            inventory.require_no_changes()
        current_segment_names = os.listdir(root.descriptor)
        if (
            len(current_segment_names) != len(segment_names) or
            set(current_segment_names) != set(segment_names)
        ):
            fail(f"{label} segment inventory changed while held")
        root_watcher.require_no_changes()
        return records, tuple(segment_names)

    def _read_chain(self, allowed_unrecorded_set: str | None = None) -> ChainState:
        self._close_chain_watchers()
        primary, primary_segments = self._journal_inventory(
            self.journal_segments, "debug journal"
        )
        anchors, anchor_segments = self._journal_inventory(
            self.journal_anchors, "debug journal anchors"
        )
        high_water, high_water_segments = self._journal_inventory(
            self.journal_high_water, "debug journal high-water facts"
        )
        if primary_segments != anchor_segments or primary_segments != high_water_segments:
            fail("debug journal segment mirrors expose an incomplete handoff")
        if set(primary) != set(anchors) or set(primary) != set(high_water):
            fail("debug journal reconciliation facts expose a rollback or incomplete append")
        ordered = sorted(primary, key=lambda name: int(name.split("-", 2)[1]))
        records: list[dict[str, object]] = []
        predecessor = CHAIN_ZERO
        retired: set[str] = set()
        retired_set_ids: set[str] = set()
        selected_sets: dict[str, tuple[str, tuple[str, ...]]] = {}
        expected_sequence = 1
        for name in ordered:
            primary_bytes = primary[name].contents
            anchor_bytes = anchors[name].contents
            high_water_bytes = high_water[name].contents
            if primary_bytes != anchor_bytes or primary_bytes != high_water_bytes:
                fail("debug journal record differs from its reconciliation facts")
            record = strict_json_bytes(primary_bytes, "debug journal record")
            expected_keys = {
                "schema", "version", "sequence", "predecessorSha256", "action",
                "directory", "setId", "roles", "recordSha256",
            }
            if set(record) != expected_keys or record.get("schema") != "revival.pin-debug-journal" or \
                record.get("version") != 2:
                fail("debug journal record has an unexpected schema")
            sequence = record.get("sequence")
            if sequence != expected_sequence:
                fail("debug journal has a sequence gap, fork, or rollback")
            if record.get("predecessorSha256") != predecessor:
                fail("debug journal predecessor hash chain is broken")
            directory = record.get("directory")
            set_id = record.get("setId")
            roles_value = record.get("roles")
            action = record.get("action")
            if (
                not isinstance(directory, str) or not SAFE_NAME.fullmatch(directory) or
                not directory.startswith(".set.") or not isinstance(set_id, str) or
                not HEX_256.fullmatch(set_id) or not isinstance(roles_value, list) or
                action not in ("select", "retire")
            ):
                fail("debug journal record payload is malformed")
            roles = validate_roles(roles_value)
            base = {key: value for key, value in record.items() if key != "recordSha256"}
            digest = hashlib.sha256(
                json.dumps(base, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            if record.get("recordSha256") != digest or name != \
                f"record-{sequence}-{digest}.json":
                fail("debug journal record digest or name is invalid")
            if (sequence - 1) // CHAIN_SEGMENT_SIZE != int(
                primary[name].segment_index
            ):
                fail("debug journal record is stored in the wrong segment")
            if action == "select":
                if directory in retired or set_id in retired_set_ids:
                    fail("debug journal selects a set identity after its retirement")
                prior = selected_sets.get(directory)
                if prior is not None and prior != (set_id, roles):
                    fail("debug journal equivocates about an existing set")
                selected_sets[directory] = (set_id, roles)
            else:
                if directory in retired or selected_sets.get(directory) != (set_id, roles):
                    fail("debug journal has an unmatched or repeated retirement")
                retired.add(directory)
                retired_set_ids.add(set_id)
            predecessor = digest
            expected_sequence += 1
            records.append(record)
        set_names = os.listdir(self.sets.descriptor)
        if any(not SAFE_NAME.fullmatch(name) or not name.startswith(".set.") for name in set_names):
            fail("debug set namespace contains an unknown history object")
        expected_sets = set(selected_sets)
        if allowed_unrecorded_set is not None:
            expected_sets.add(allowed_unrecorded_set)
        if set(set_names) != expected_sets:
            fail("debug set bytes and journal history expose a rollback or orphan")

        retirement_watcher = DirectoryEventWatcher(
            self.retirement_facts.descriptor, "debug retirement fact inventory"
        )
        self._chain_watchers.append(retirement_watcher)
        retirement_names = os.listdir(self.retirement_facts.descriptor)
        observed_retired: set[str] = set()
        for name in retirement_names:
            match = re.fullmatch(r"retired-([0-9a-f]{64})", name)
            if match is None:
                fail("debug retirement facts contain a noncanonical entry")
            fact = self.tree.open_file(self.retirement_facts, name, "debug retirement fact")
            require_private_regular(fact, "debug retirement fact")
            expected = (match.group(1) + "\n").encode()
            fact.revalidate()
            if bounded_descriptor_bytes(
                fact.descriptor, 128, "debug retirement fact"
            ) != expected:
                fail("debug retirement fact contents are invalid")
            observed_retired.add(match.group(1))
        if observed_retired != retired_set_ids:
            fail("debug retirement facts expose a rollback or incomplete retirement")
        if retirement_names != os.listdir(self.retirement_facts.descriptor):
            fail("debug retirement fact inventory changed while held")
        retirement_watcher.require_no_changes()
        for watcher in self._chain_watchers:
            watcher.require_no_changes()
        record_count = expected_sequence - 1
        minimum_count = 0 if record_count == 0 else (record_count - 1) // CHAIN_SEGMENT_SIZE + 1
        optional_count = record_count // CHAIN_SEGMENT_SIZE + 1
        minimum_segments = tuple(self._segment_name(index) for index in range(minimum_count))
        optional_segments = tuple(self._segment_name(index) for index in range(optional_count))
        if primary_segments not in (minimum_segments, optional_segments):
            fail("debug journal has an empty middle segment or segment rollback")
        return ChainState(
            tuple(records),
            expected_sequence,
            predecessor,
            frozenset(retired),
            frozenset(retired_set_ids),
        )

    def _segment_for_append(self, root: WatchedDirectory, index: int, label: str) -> WatchedDirectory:
        name = self._segment_name(index)
        try:
            return self.tree.open_existing_child(
                root,
                name,
                f"{label} {name}",
                private=True,
                contents_mutable=True,
            )
        except FileNotFoundError:
            return self.tree.create_fixed_child(
                root,
                name,
                f"{label} {name}",
                contents_mutable=True,
            )

    def _append_chain_record(
        self,
        action: str,
        directory: str,
        set_id: str,
        roles: tuple[str, ...],
    ) -> WatchedFile:
        state = self._read_chain(directory if action == "select" else None)
        if action == "select" and (
            directory in state.retired or set_id in state.retired_set_ids
        ):
            fail("a retired debug set identity cannot be selected again")
        if action == "retire" and (
            directory in state.retired or set_id in state.retired_set_ids
        ):
            fail("debug set is already retired")
        sequence = state.next_sequence
        base = {
            "schema": "revival.pin-debug-journal",
            "version": 2,
            "sequence": sequence,
            "predecessorSha256": state.predecessor,
            "action": action,
            "directory": directory,
            "setId": set_id,
            "roles": list(roles),
        }
        digest = hashlib.sha256(
            json.dumps(base, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        record = {**base, "recordSha256": digest}
        contents = json.dumps(record, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        name = f"record-{sequence}-{digest}.json"
        index = (sequence - 1) // CHAIN_SEGMENT_SIZE
        # No reader can observe an unverified partial append: the held flock is
        # acquired before either mirror is inventoried, and a crash between the
        # two immutable commits leaves a detectable primary/anchor mismatch.
        self._close_chain_watchers()
        segment = self._segment_for_append(self.journal_segments, index, "debug journal")
        anchor_segment = self._segment_for_append(
            self.journal_anchors, index, "debug journal anchors"
        )
        high_water_segment = self._segment_for_append(
            self.journal_high_water, index, "debug journal high-water facts"
        )
        primary = self.tree.create_named_file(
            segment,
            name,
            "append-only debug journal record",
            contents,
        )
        self.tree.create_named_file(
            anchor_segment,
            name,
            "append-only debug journal anchor",
            contents,
        )
        self.tree.create_named_file(
            high_water_segment,
            name,
            "append-only debug journal high-water fact",
            contents,
        )
        if action == "retire":
            self.tree.create_named_file(
                self.retirement_facts,
                f"retired-{set_id}",
                "debug retirement permanence fact",
                (set_id + "\n").encode(),
            )
        observed = self._read_chain()
        if observed.predecessor != digest or observed.next_sequence != sequence + 1:
            fail("debug journal append did not linearize as its exact held record")
        primary.revalidate(expected_contents=contents)
        return primary

    def append_selection(self, verified: VerifiedSet) -> WatchedFile:
        verified.revalidate()
        assert verified.directory.name is not None
        result = self._append_chain_record(
            "select",
            verified.directory.name,
            verified.set_id,
            verified.roles,
        )
        verified.revalidate()
        return result

    def append_retirement(self, directory: str) -> WatchedFile:
        verified = self.verify_set(directory)
        try:
            verified.revalidate()
            return self._append_chain_record(
                "retire", directory, verified.set_id, verified.roles
            )
        finally:
            verified.close()

    def verify_set(self, directory: str, expected_set_id: str | None = None) -> VerifiedSet:
        if not SAFE_NAME.fullmatch(directory) or not directory.startswith(".set."):
            fail("debug set directory token is malformed")
        stage = self.tree.open_existing_child(
            self.sets,
            directory,
            "published debug set",
            private=True,
            contents_mutable=True,
        )
        inventory_watcher = DirectoryEventWatcher(
            stage.descriptor,
            "published debug set inventory",
        )
        inventory_watcher.require_no_changes()
        inventory = sorted(os.listdir(stage.child_path))
        if "manifest.json" not in inventory or "SHA256SUMS" not in inventory:
            fail("published debug set is incomplete")
        files: dict[str, HeldFile] = {}
        manifest_file = self.tree.open_file(stage, "manifest.json", "published debug manifest")
        files["manifest.json"] = manifest_file
        require_private_regular(manifest_file, "published debug manifest")
        manifest = strict_json_bytes(
            bounded_descriptor_bytes(manifest_file.descriptor, 64 * 1024, "published debug manifest"),
            "published debug manifest",
        )
        if set(manifest) != {
            "schema", "version", "roles", "payloadComplete", "release", "installable", "artifacts", "setId"
        } or manifest.get("schema") != "revival.pin-debug-set" or manifest.get("version") != 2:
            fail("published debug manifest schema changed")
        if manifest.get("payloadComplete") is not False or manifest.get("release") is not False or \
            manifest.get("installable") is not False:
            fail("published debug set lost its nonrelease/noninstallable boundary")
        roles_value = manifest.get("roles")
        if not isinstance(roles_value, list):
            fail("published debug roles are malformed")
        roles = validate_roles(roles_value)
        artifacts = manifest.get("artifacts")
        if not isinstance(artifacts, list) or len(artifacts) != len(roles):
            fail("published debug artifact inventory is malformed")
        base = {key: value for key, value in manifest.items() if key != "setId"}
        set_id = hashlib.sha256(
            json.dumps(base, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        if manifest.get("setId") != set_id or (expected_set_id is not None and expected_set_id != set_id):
            fail("published debug setId does not match its manifest")
        expected_names = sorted(
            [*(f"{role}.apk" for role in roles), *(f"{role}.receipt.json" for role in roles),
             "manifest.json", "SHA256SUMS"]
        )
        if inventory != expected_names:
            fail("published debug set contains an unexpected file inventory")
        artifact_by_role: dict[str, dict[str, object]] = {}
        for artifact in artifacts:
            if not isinstance(artifact, dict) or set(artifact) != EXPECTED_RECEIPT_KEYS:
                fail("published debug receipt projection is malformed")
            role = artifact.get("role")
            if not isinstance(role, str) or role in artifact_by_role:
                fail("published debug receipt roles are malformed")
            artifact_by_role[role] = artifact
        checksums: list[str] = []
        for role in roles:
            apk = self.tree.open_file(stage, f"{role}.apk", f"published {role} APK")
            receipt_file = self.tree.open_file(
                stage,
                f"{role}.receipt.json",
                f"published {role} receipt",
            )
            require_private_regular(apk, f"published {role} APK")
            require_private_regular(receipt_file, f"published {role} receipt")
            files[f"{role}.apk"] = apk
            files[f"{role}.receipt.json"] = receipt_file
            receipt_bytes = bounded_descriptor_bytes(receipt_file.descriptor, 4096, f"published {role} receipt")
            receipt = strict_json_bytes(receipt_bytes, f"published {role} receipt")
            if receipt != artifact_by_role.get(role):
                fail(f"published {role} receipt differs from the manifest")
            digest = descriptor_digest(apk.descriptor)
            if (
                receipt.get("schema") != "revival.pin-debug-artifact"
                or receipt.get("version") != 2
                or receipt.get("package") != ROLE_PACKAGES[role]
                or receipt.get("sha256") != digest
                or receipt.get("size") != apk.metadata.st_size
                or receipt.get("debuggable") is not True
                or receipt.get("payloadComplete") is not False
                or receipt.get("release") is not False
                or receipt.get("installable") is not False
            ):
                fail(f"published {role} receipt contract changed")
            checksums.extend((
                f"{digest}  {role}.apk\n",
                f"{hashlib.sha256(receipt_bytes).hexdigest()}  {role}.receipt.json\n",
            ))
        checksums.append(f"{descriptor_digest(manifest_file.descriptor)}  manifest.json\n")
        checksum_file = self.tree.open_file(stage, "SHA256SUMS", "published debug checksums")
        files["SHA256SUMS"] = checksum_file
        require_private_regular(checksum_file, "published debug checksums")
        expected_checksum_bytes = "".join(sorted(checksums, key=lambda line: line.split("  ", 1)[1])).encode("ascii")
        if bounded_descriptor_bytes(checksum_file.descriptor, 64 * 1024, "published debug checksums") != expected_checksum_bytes:
            fail("published debug checksums do not match the held files")
        if inventory != sorted(os.listdir(stage.child_path)):
            fail("published debug set inventory changed while verified")
        inventory_watcher.require_no_changes()
        verified = VerifiedSet(
            stage,
            set_id,
            roles,
            files,
            tuple(expected_names),
            inventory_watcher,
        )
        verified.revalidate()
        self._verified_sets.append(verified)
        return verified

    def latest(self) -> VerifiedSet:
        state = self._read_chain()
        selected: dict[str, object] | None = None
        for record in reversed(state.records):
            directory = record["directory"]
            assert isinstance(directory, str)
            if (
                record["action"] == "select" and
                directory not in state.retired and
                record["setId"] not in state.retired_set_ids
            ):
                selected = record
                break
        if selected is None:
            fail("no active append-only debug selection exists")
        directory = selected["directory"]
        assert isinstance(directory, str)
        set_id = selected["setId"]
        assert isinstance(set_id, str)
        verified = self.verify_set(directory, set_id)
        if tuple(selected["roles"]) != verified.roles:
            fail("debug journal roles differ from the held verified set")
        verified.revalidate()
        for watcher in self._chain_watchers:
            watcher.require_no_changes()
        self.tree.revalidate_all()
        return verified

    def close(self) -> None:
        for verified in reversed(self._verified_sets):
            verified.close()
        self._verified_sets = []
        self._close_chain_watchers()
        with contextlib.suppress(OSError):
            fcntl.flock(self.chain_lock.descriptor, fcntl.LOCK_UN)
        self.tree.close()

    def __enter__(self) -> "AppendOnlyDebugStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def build_publish(root_value: str, role_outputs: list[list[str]]) -> None:
    if len(role_outputs) == 0 or any(len(item) != 2 for item in role_outputs):
        fail("build-publish role/output inventory is not exact")
    roles = validate_roles(item[0] for item in role_outputs)
    with AppendOnlyDebugStore(root_value) as store:
        stage = store.allocate_stage()
        receipts = [
            store.stage_role(stage, role, output)
            for role, output in role_outputs
        ]
        set_id = store.finalize(stage, roles, receipts)
        assert stage.name is not None
        verified = store.verify_set(stage.name, set_id)
        store.append_selection(verified)
        store.tree.revalidate_all()
        print(f"{root_value}/sets/{stage.name}")


def select_latest(root_value: str, *, json_output: bool = False) -> None:
    with AppendOnlyDebugStore(root_value) as store:
        verified = store.latest()
        assert verified.directory.name is not None
        if json_output:
            print(json.dumps({
                "schema": "revival.pin-debug-selected-set",
                "version": 1,
                "path": f"{root_value}/sets/{verified.directory.name}",
                "setId": verified.set_id,
                "roles": list(verified.roles),
            }, sort_keys=True, separators=(",", ":")))
        else:
            print(f"{root_value}/sets/{verified.directory.name}")


def publish_existing(root_value: str, stage_value: str, role_values: Iterable[str]) -> None:
    roles = validate_roles(role_values)
    root = require_canonical_absolute(root_value, "debug artifact root")
    stage = require_canonical_absolute(stage_value, "debug set stage")
    if os.path.dirname(stage) != os.path.join(root, "sets"):
        fail("publish accepts only a direct child of the append-only sets namespace")
    directory = os.path.basename(stage)
    with AppendOnlyDebugStore(root) as store:
        verified = store.verify_set(directory)
        if verified.roles != roles:
            fail("publish roles differ from the held debug manifest")
        # The chain reader runs before append and refuses this exact set token
        # if any verified retirement record already names it.
        store.append_selection(verified)
        print(stage)


def discard(root_value: str, stage_value: str) -> None:
    root = require_canonical_absolute(root_value, "debug artifact root")
    stage = require_canonical_absolute(stage_value, "debug set stage")
    if os.path.dirname(stage) != os.path.join(root, "sets"):
        fail("discard accepts only a direct child of the append-only sets namespace")
    with AppendOnlyDebugStore(root) as store:
        store.append_retirement(os.path.basename(stage))


def lock_process_descriptor_authority() -> None:
    """Hide held and unnamed descriptors from every unprivileged peer process."""

    if not sys.platform.startswith("linux"):
        fail("Pin descriptor authority requires Linux")
    libc = ctypes.CDLL(None, use_errno=True)
    operation = getattr(libc, "prctl", None)
    if operation is None:
        fail("Pin descriptor authority requires prctl")
    operation.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    operation.restype = ctypes.c_int
    if operation(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE = 4
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def _read_native_evidence(path: str, maximum: int = 1024 * 1024) -> str:
    try:
        with open(path, "rb", buffering=0) as stream:
            value = stream.read(maximum + 1)
    except (FileNotFoundError, PermissionError, OSError):
        return ""
    if len(value) > maximum:
        fail(f"native-host evidence exceeds its bound: {path}")
    return value.decode("utf-8", "replace")


def require_native_linux_amd64() -> None:
    if not sys.platform.startswith("linux") or os.uname().machine != "x86_64":
        fail(
            "credential-free Pin lanes require a native Linux x86_64 host; "
            "use the hosted native-x64 all-five lane"
        )
    cpu = _read_native_evidence("/proc/cpuinfo")
    status = _read_native_evidence("/proc/self/status")
    maps = _read_native_evidence("/proc/self/maps")
    product = "\n".join(
        _read_native_evidence(path, 64 * 1024)
        for path in (
            "/sys/class/dmi/id/product_name",
            "/sys/class/dmi/id/sys_vendor",
            "/sys/class/dmi/id/board_vendor",
        )
    )
    registrations: list[str] = []
    try:
        names = sorted(os.listdir("/proc/sys/fs/binfmt_misc"))
    except (FileNotFoundError, PermissionError, OSError):
        names = []
    for name in names:
        if name in ("register", "status"):
            continue
        registrations.append(name + "\n" + _read_native_evidence(
            f"/proc/sys/fs/binfmt_misc/{name}", 64 * 1024
        ))
    combined = "\n".join((cpu, status, maps, product, *registrations)).lower()
    emulation_tokens = ("qemu", "tcg", "rosetta", "emulat", "box64", "fex-emu")
    vendor_native = re.search(
        r"^vendor_id\s*:\s*(?:genuineintel|authenticamd)\s*$",
        cpu,
        flags=re.IGNORECASE | re.MULTILINE,
    ) is not None
    if (
        not cpu or not vendor_native or registrations or
        any(token in combined for token in emulation_tokens)
    ):
        fail(
            "credential-free Pin lanes require clean native Linux x86_64 CPU/kernel evidence; "
            "QEMU, binfmt, translation, and emulated hosts must use hosted native x64"
        )


def require_trusted_hosted_native_attestation(
    request: str,
    bundle: str,
    output: str,
) -> None:
    """Route the named release gate to the fixed image-baked verifier.

    CPU/DMI/CI strings never reach this authority path.  The Node verifier uses
    the image-baked policy, GitHub private Sigstore root, and checksum-pinned
    GitHub CLI to verify the provider-signed certificate before it writes the
    selected canonical result.  `execve` avoids a weaker Python interpretation
    of the same evidence and leaves no caller-selected verifier command.

    This proves GitHub-hosted trusted-workflow provenance on the policy's x64
    runner label.  GitHub's certificate does not prove bare metal or the absence
    of a hypervisor, so this function intentionally makes no such claim.
    """
    verifier = "/usr/local/libexec/ai-pin-hosted-attestation/hosted-attestation.mjs"
    node = "/usr/bin/node"
    for path, label in (
        (node, "fixed Node runtime"),
        (verifier, "image-baked hosted attestation verifier"),
    ):
        try:
            metadata = os.lstat(path)
        except OSError:
            fail(f"{label} is unavailable")
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            fail(f"{label} is not a regular file")
    arguments = (
        node,
        verifier,
        "verify-pre",
        "--request",
        request,
        "--bundle",
        bundle,
        "--output",
        output,
    )
    os.execve(node, arguments, {
        "HOME": "/tmp",
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    })


def describe_native_source_generation(source_root: str) -> None:
    """Emit only the immutable identities needed by the pre-sign request.

    This remains a candidate/native negative check.  Provider-signed hosted
    workflow evidence is what later upgrades the same captured identities into
    signing authority.
    """

    require_native_linux_amd64()
    generation = SealedSourceGeneration.capture(source_root)
    try:
        generation.revalidate()
        print(json.dumps({
            "schema": "revival.pin-source-generation-identity",
            "version": 1,
            "generationSha256": generation.generation_sha256,
            "tarSha256": generation.manifest.get("tarSha256"),
        }, sort_keys=True, separators=(",", ":")))
        generation.revalidate()
    finally:
        generation.close()


def strict_descendant_components(parent: str, child: str, label: str) -> tuple[str, ...]:
    parent_value = require_canonical_absolute(parent, f"{label} parent")
    child_value = require_canonical_absolute(child, label)
    try:
        common = os.path.commonpath((parent_value, child_value))
    except ValueError:
        fail(f"{label} must be beneath its parent")
    if common != parent_value or child_value == parent_value:
        fail(f"{label} must be a strict descendant of {parent_value}")
    relative = os.path.relpath(child_value, parent_value)
    components = Path(relative).parts
    if not components or any(component in ("", ".", "..") for component in components):
        fail(f"{label} has unsafe relative ancestry")
    return components


def held_descriptors(tree: WatchedAuthorityTree) -> tuple[int, ...]:
    values = [directory.descriptor for directory in tree.directories]
    values.extend(held_file.descriptor for held_file in tree.files)
    return tuple(sorted(set(values)))


def child_environment(
    home: WatchedDirectory,
    xdg: WatchedDirectory,
    npm_user: WatchedFile,
    npm_global: WatchedFile,
    extra: dict[str, str] | None = None,
) -> dict[str, str]:
    result = {
        "HOME": home.child_path,
        "XDG_CONFIG_HOME": xdg.child_path,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NPM_CONFIG_USERCONFIG": npm_user.child_path,
        "NPM_CONFIG_GLOBALCONFIG": npm_global.child_path,
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_ATTR_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PATH": "/usr/bin:/bin",
    }
    if extra:
        result.update(extra)
    return result


def run_held_child(
    executable: HeldFile,
    arguments: Iterable[str],
    *,
    tree: WatchedAuthorityTree,
    environment: dict[str, str],
    cwd: str | None = None,
    capture: bool = False,
    allow_failure: bool = False,
    stdin_descriptor: int | None = None,
    extra_descriptors: Iterable[int] = (),
) -> tuple[int, bytes, bytes]:
    executable.revalidate()
    tree.revalidate_all()
    argv = [executable.child_path, *arguments]
    if stdin_descriptor is not None:
        os.lseek(stdin_descriptor, 0, os.SEEK_SET)
    passed = tuple(sorted(set((*held_descriptors(tree), *extra_descriptors))))
    completed = subprocess.run(
        argv,
        executable=executable.child_path,
        cwd=cwd,
        env=environment,
        stdin=subprocess.DEVNULL if stdin_descriptor is None else stdin_descriptor,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=False,
        close_fds=True,
        pass_fds=passed,
    )
    executable.revalidate()
    tree.revalidate_all()
    if completed.returncode < 0:
        raise ChildSignal(-completed.returncode)
    if completed.returncode != 0 and not allow_failure:
        raise ChildStatus(completed.returncode)
    return completed.returncode, completed.stdout or b"", completed.stderr or b""


def read_held_file(held_file: HeldFile) -> bytes:
    held_file.revalidate()
    chunks: list[bytes] = []
    offset = 0
    while True:
        block = os.pread(held_file.descriptor, 1024 * 1024, offset)
        if not block:
            break
        chunks.append(block)
        offset += len(block)
    held_file.revalidate()
    return b"".join(chunks)


def debug_roles_for_paths(paths: Iterable[str]) -> tuple[str, ...]:
    selected: set[str] = set()
    exact = (
        ("pin/injector/installer/", ("installer",)),
        ("pin/injector/exploit/", ("bootstrap",)),
        ("pin/hook/payload/", ("hook",)),
        ("pin/runtime/", ("server",)),
        ("pin/hook/loader/", ("hook-injector",)),
    )
    for raw in paths:
        value = raw.replace("\\", "/")
        while value.startswith("./"):
            value = value[2:]
        roles: tuple[str, ...] = DEBUG_ROLES
        if value and not value.startswith("/") and ".." not in value.split("/"):
            for prefix, mapped in exact:
                if value.startswith(prefix):
                    roles = mapped
                    break
            else:
                if value.startswith("pin/contracts/"):
                    roles = ("hook", "server")
        selected.update(roles)
    return tuple(role for role in DEBUG_ROLES if role in selected)


class ContinuousLaneSession:
    """One host authority from root acquisition through the last Docker child."""

    def __init__(
        self,
        data_root: str,
        build_root: str,
        source_root: str,
        lane: str,
    ) -> None:
        if lane not in ("check", "debug"):
            fail("lane session must be check or debug")
        require_native_linux_amd64()
        self.lane = lane
        self.tree = WatchedAuthorityTree()
        self._closed = False
        data_value = require_canonical_absolute(data_root, "REVIVAL_DATA_DIR")
        build_value = require_canonical_absolute(build_root, "REVIVAL_BUILD_DIR")
        source_value = require_canonical_absolute(source_root, "Pin source root")
        build_components = strict_descendant_components(
            data_value,
            build_value,
            "REVIVAL_BUILD_DIR",
        )
        if os.path.commonpath((source_value, data_value)) in (source_value, data_value):
            fail("Pin DATA and source roots must not overlap")

        self.source_authority = self.tree.open_absolute(
            source_value,
            "Pin source root",
            private_final=False,
            contents_mutable=True,
        )
        self.source_generation, capture_watcher = SealedSourceGeneration.capture(
            self.source_authority
        )
        capture_watcher.assert_clean()
        capture_watcher.close()
        self.data = self.tree.open_absolute(
            data_value,
            "REVIVAL_DATA_DIR",
            create=True,
            private_final=True,
            contents_mutable=True,
        )
        current = self.data
        for index, component in enumerate(build_components):
            current = self.tree.create_fixed_child(
                current,
                component,
                "REVIVAL_BUILD_DIR" if index == len(build_components) - 1 else
                f"REVIVAL_BUILD_DIR ancestor {component}",
                contents_mutable=True,
            )
        self.build = current
        state_name = (
            "pin-contributor-builder-state" if lane == "check" else
            "pin-debug-builder-state"
        )
        self.state = self.tree.create_fixed_child(
            self.build,
            state_name,
            f"Pin {lane} state root",
            contents_mutable=True,
        )
        self.cache = self.tree.create_fixed_child(
            self.build,
            "pin-builder-cache-data",
            "Pin shared cache-data root",
            contents_mutable=True,
        )
        self.cache_leaves: list[WatchedDirectory] = []
        for name, _target in HOST_CACHE_LEAVES:
            self.cache_leaves.append(self.tree.create_fixed_child(
                self.cache,
                name,
                f"Pin {name} cache-data root",
                contents_mutable=True,
            ))
        config_parent = self.tree.create_fixed_child(
            self.build,
            "pin-builder-docker-config",
            "Pin Docker-config token root",
            contents_mutable=True,
        )
        self.docker_config = self.tree.create_random_child(
            config_parent,
            f".{lane}.",
            f"Pin {lane} anonymous Docker configuration",
            contents_mutable=False,
        )
        self.process = self.tree.create_random_child(
            self.state,
            ".host-process.",
            f"Pin {lane} host-process root",
            contents_mutable=True,
        )
        self.source = self.tree.create_random_child(
            self.process,
            ".sealed-source.",
            f"Pin {lane} sealed source extraction",
            contents_mutable=True,
        )
        self.source_watcher = self.source_generation.extract_into(self.source)
        self.home = self.tree.create_fixed_child(
            self.process,
            "home",
            f"Pin {lane} process HOME",
            contents_mutable=True,
        )
        self.xdg = self.tree.create_fixed_child(
            self.process,
            "xdg-config",
            f"Pin {lane} process XDG config",
            contents_mutable=True,
        )
        self.npm_user = self.tree.create_file(
            self.process,
            ".npm-user.",
            f"Pin {lane} empty npm user configuration",
            b"",
        )
        self.npm_global = self.tree.create_file(
            self.process,
            ".npm-global.",
            f"Pin {lane} empty npm global configuration",
            b"",
        )
        if os.listdir(self.docker_config.child_path):
            fail("anonymous Docker configuration was not empty at creation")

        self.shell = self.tree.open_file_absolute(
            "/usr/bin/dash",
            "trusted Pin shell",
            root_owned=True,
            executable=True,
        )
        self.node = self.tree.open_file_absolute(
            "/usr/bin/node",
            "trusted Pin Node",
            root_owned=True,
            executable=True,
        )
        self.git = self.tree.open_file_absolute(
            "/usr/bin/git",
            "trusted Pin Git",
            root_owned=True,
            executable=True,
        )
        self.docker = self.tree.open_file_absolute(
            "/usr/bin/docker",
            "trusted Pin Docker",
            root_owned=True,
            executable=True,
        )
        self.source_policy = self.tree.open_file_beneath(
            self.source,
            "platform/deploy/acceptance/source-policy.sh",
            "Pin source-policy program",
            executable=True,
        )
        self.dockerfile = self.tree.open_file_beneath(
            self.source,
            "platform/containers/pin-builder/Dockerfile",
            "Pin builder Dockerfile",
        )
        self.entrypoint = self.tree.open_file_beneath(
            self.source,
            "platform/containers/pin-builder/entrypoint.sh",
            "Pin builder entrypoint",
        )
        self.debug_store = self.tree.open_file_beneath(
            self.source,
            "platform/containers/pin-builder/debug-store.py",
            "Pin builder descriptor broker",
        )
        self.toolchain = self.tree.open_file_beneath(
            self.source,
            "platform/containers/pin-builder/toolchain.json",
            "Pin builder toolchain contract",
        )
        self.environment = child_environment(
            self.home,
            self.xdg,
            self.npm_user,
            self.npm_global,
        )
        if self.source_generation.omitted_root_agents:
            self._prepare_git_plumbing()
        self.revalidate()

    def revalidate(self) -> None:
        self.source_watcher.assert_clean()
        self.tree.revalidate_all()
        for watcher, name in getattr(self, "git_ref_edge_watchers", []):
            watcher.require_target_unchanged(name)
        if hasattr(self, "git_object_watcher"):
            self.git_object_watcher.assert_clean()
        if os.listdir(self.docker_config.child_path):
            fail("anonymous Docker configuration was modified during the lane session")
        self.source_generation.verify_extraction(self.source.descriptor)
        self.source_watcher.assert_clean()

    def run_source_policy(self) -> None:
        run_held_child(
            self.shell,
            (self.source_policy.child_path, self.source.child_path, self.node.child_path),
            tree=self.tree,
            environment=self.environment,
            cwd=self.source.child_path,
        )

    def _prepare_git_plumbing(self) -> None:
        if hasattr(self, "git_sandbox"):
            return
        try:
            self.git_directory = self.tree.open_existing_child(
                self.source_authority,
                ".git",
                "held Git object namespace",
                private=False,
                contents_mutable=True,
            )
        except (FileNotFoundError, NotADirectoryError):
            fail("pin build-debug --changed requires a directory-form Git object database")
        self.git_objects = self.tree.open_existing_child(
            self.git_directory,
            "objects",
            "held Git object database",
            private=False,
            contents_mutable=True,
        )
        try:
            info = self.tree.open_existing_child(
                self.git_objects,
                "info",
                "held Git object info namespace",
                private=False,
                contents_mutable=True,
            )
            try:
                os.stat("alternates", dir_fd=info.descriptor, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                fail("Git alternates are not allowed in the credential-free changed selector")
        except FileNotFoundError:
            pass
        self.git_object_watcher = RecursiveMutationWatcher(
            self.git_objects.descriptor,
            "Git base object database",
        )
        self.git_sandbox = self.tree.create_random_child(
            self.process,
            ".git-plumbing.",
            "empty broker-owned Git plumbing namespace",
            contents_mutable=True,
        )
        self.tree.create_named_file(
            self.git_sandbox,
            "HEAD",
            "inert Git plumbing HEAD",
            b"ref: refs/heads/revival-inert\n",
        )
        self.tree.create_fixed_child(
            self.git_sandbox,
            "objects",
            "empty Git plumbing object placeholder",
            contents_mutable=True,
        )
        refs = self.tree.create_fixed_child(
            self.git_sandbox,
            "refs",
            "empty Git plumbing refs",
            contents_mutable=True,
        )
        self.tree.create_fixed_child(
            refs,
            "heads",
            "empty Git plumbing heads",
            contents_mutable=True,
        )
        self.git_ref_files: list[HeldFile] = []
        self.git_ref_edge_watchers: list[tuple[DirectoryEventWatcher, str]] = []
        self._prove_omitted_agents_untracked()

    def _prove_omitted_agents_untracked(self) -> None:
        """Fail if an omitted environment context is actually index source."""

        if not self.source_generation.omitted_root_agents:
            return
        try:
            index = self.tree.open_file(
                self.git_directory,
                "index",
                "held Git index for host AGENTS proof",
            )
        except FileNotFoundError:
            fail("cannot prove omitted host AGENTS.md is untracked without a Git index")
        environment = {
            **self.environment,
            "GIT_INDEX_FILE": index.child_path,
            "GIT_OBJECT_DIRECTORY": self.git_objects.child_path,
            "GIT_ALTERNATE_OBJECT_DIRECTORIES": "",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_CONFIG_COUNT": "0",
            "GIT_PROTOCOL_FROM_USER": "0",
        }
        status, output, _error = run_held_child(
            self.git,
            (
                f"--git-dir={self.git_sandbox.child_path}",
                "--no-pager",
                "ls-files",
                "-z",
                "--stage",
                "--",
                "AGENTS.md",
            ),
            tree=self.tree,
            environment=environment,
            cwd=self.source.child_path,
            capture=True,
            allow_failure=True,
        )
        index.revalidate()
        if status != 0 or output:
            fail("root AGENTS.md is tracked/user source and cannot be omitted")

    def _git_object(self, arguments: Iterable[str], *, allow_failure: bool = False) -> tuple[int, bytes]:
        self._prepare_git_plumbing()
        self.git_object_watcher.assert_clean()
        environment = {
            **self.environment,
            "GIT_OBJECT_DIRECTORY": self.git_objects.child_path,
            "GIT_ALTERNATE_OBJECT_DIRECTORIES": "",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_CONFIG_COUNT": "0",
            "GIT_PROTOCOL_FROM_USER": "0",
        }
        status, output, _error = run_held_child(
            self.git,
            (f"--git-dir={self.git_sandbox.child_path}", "--no-pager", *arguments),
            tree=self.tree,
            environment=environment,
            cwd=self.source.child_path,
            capture=True,
            allow_failure=allow_failure,
        )
        self.git_object_watcher.assert_clean()
        return status, output

    @staticmethod
    def _validate_ref_name(value: str) -> None:
        if (
            not SAFE_GIT_REF.fullmatch(value) or value.startswith("-") or
            ".." in value or "//" in value or "@{" in value or
            value.endswith(("/", ".", ".lock"))
        ):
            fail(f"invalid Git base ref: {value or '<empty>'}")

    def _read_git_ref_file(self, relative: str) -> str | None:
        components = Path(relative).parts
        if not components or any(component in ("", ".", "..") for component in components):
            fail("Git ref path has unsafe ancestry")
        parent = self.git_directory
        for component in components[:-1]:
            ancestor_edge = DirectoryEventWatcher(
                parent.descriptor,
                f"Git ref {relative} ancestor {component} existence",
            )
            ancestor_edge.require_target_unchanged(component)
            try:
                os.stat(component, dir_fd=parent.descriptor, follow_symlinks=False)
            except FileNotFoundError:
                self.git_ref_edge_watchers.append((ancestor_edge, component))
                return None
            parent = self.tree.open_existing_child(
                parent,
                component,
                f"held Git ref ancestor {component}",
                private=False,
                contents_mutable=True,
            )
            ancestor_edge.require_target_unchanged(component)
            self.git_ref_edge_watchers.append((ancestor_edge, component))
        name = components[-1]
        edge = DirectoryEventWatcher(parent.descriptor, f"Git ref {relative} existence")
        edge.require_target_unchanged(name)
        try:
            os.stat(name, dir_fd=parent.descriptor, follow_symlinks=False)
        except FileNotFoundError:
            self.git_ref_edge_watchers.append((edge, name))
            return None
        held = self.tree.open_file(parent, name, f"held Git ref {relative}")
        edge.require_target_unchanged(name)
        self.git_ref_edge_watchers.append((edge, name))
        self.git_ref_files.append(held)
        value = bounded_descriptor_bytes(held.descriptor, 1024 * 1024, f"Git ref {relative}")
        try:
            text = value.decode("ascii", "strict").strip()
        except UnicodeError:
            fail(f"Git ref {relative} is not strict ASCII")
        return text

    def _packed_ref(self, full_name: str) -> str | None:
        value = self._read_git_ref_file("packed-refs")
        if value is None:
            return None
        result: str | None = None
        for line in value.splitlines():
            if not line or line.startswith(("#", "^")):
                continue
            parts = line.split(" ")
            if len(parts) != 2 or not HEX_GIT_OBJECT.fullmatch(parts[0]):
                fail("Git packed-refs is malformed")
            if parts[1] == full_name:
                if result is not None:
                    fail(f"Git packed-refs duplicates {full_name}")
                result = parts[0]
        return result

    def _resolve_full_ref(self, full_name: str, seen: set[str] | None = None) -> str | None:
        self._validate_ref_name(full_name)
        visited = set() if seen is None else seen
        if full_name in visited or len(visited) >= 8:
            fail("Git symbolic base ref has a cycle")
        visited.add(full_name)
        loose = self._read_git_ref_file(full_name)
        if loose is not None:
            if loose.startswith("ref: "):
                target = loose[5:]
                if not target.startswith("refs/"):
                    fail(f"Git symbolic ref {full_name} escapes refs")
                return self._resolve_full_ref(target, visited)
            if not HEX_GIT_OBJECT.fullmatch(loose):
                fail(f"Git ref {full_name} is not a direct commit object id")
            return loose
        return self._packed_ref(full_name)

    def _verified_ref(self, value: str) -> str | None:
        self._prepare_git_plumbing()
        self._validate_ref_name(value)
        candidates: tuple[str, ...]
        if value.startswith("refs/"):
            candidates = (value,)
        elif "/" in value:
            candidates = (f"refs/remotes/{value}", f"refs/heads/{value}")
        else:
            candidates = (f"refs/heads/{value}", f"refs/remotes/{value}")
        object_id: str | None = None
        for candidate in candidates:
            object_id = self._resolve_full_ref(candidate)
            if object_id is not None:
                break
        if object_id is None:
            return None
        status, output = self._git_object(("cat-file", "-t", object_id), allow_failure=True)
        if status != 0 or output != b"commit\n":
            fail(f"Git base ref does not name one commit: {value}")
        return object_id

    def changed_roles(self, requested_base: str | None) -> tuple[str, ...]:
        self._prepare_git_plumbing()
        base_commit: str | None = None
        if requested_base is not None:
            base_commit = self._verified_ref(requested_base)
            if base_commit is None:
                fail(f"git base ref does not resolve to a commit: {requested_base}")
        else:
            for candidate in ("origin/HEAD", "origin/main", "main", "origin/master", "master"):
                base_commit = self._verified_ref(candidate)
                if base_commit is not None:
                    break
        if base_commit is None:
            fail("no allowed Git base ref resolves; pass --base with a local branch or remote ref")
        status, output = self._git_object(
            ("ls-tree", "-r", "-z", "--full-tree", base_commit),
            allow_failure=True,
        )
        if status != 0:
            fail("Git base tree could not be enumerated from the isolated object database")
        base_files: dict[str, tuple[str, str]] = {}
        for raw in output.split(b"\0"):
            if not raw:
                continue
            try:
                header, path_raw = raw.split(b"\t", 1)
                mode_raw, kind, oid_raw = header.split(b" ", 2)
                path = path_raw.decode("utf-8", "strict")
                mode = mode_raw.decode("ascii", "strict")
                oid = oid_raw.decode("ascii", "strict")
            except (ValueError, UnicodeError):
                fail("Git base tree returned malformed plumbing output")
            if (
                kind != b"blob" or mode not in ("100644", "100755", "120000") or
                not HEX_GIT_OBJECT.fullmatch(oid) or path.startswith("/") or
                any(part in ("", ".", "..") for part in path.split("/")) or
                path in base_files
            ):
                fail(f"Git base tree contains an unsupported entry: {path}")
            base_files[path] = (mode, oid)
        sealed_files = {
            item.path: ("100755" if item.mode & 0o111 else "100644", item.git_oid)
            for item in self.source_generation.files
        }
        paths = {
            path for path in set(base_files) | set(sealed_files)
            if base_files.get(path) != sealed_files.get(path)
        }
        for held in self.git_ref_files:
            held.revalidate()
        for watcher, name in self.git_ref_edge_watchers:
            watcher.require_target_unchanged(name)
        self.git_object_watcher.assert_clean()
        roles = debug_roles_for_paths(sorted(paths))
        if not roles:
            fail("no changed paths selected a Pin debug role")
        return roles

    def run_node_policy_tests(self) -> None:
        test_files: list[HeldFile] = []
        for relative_directory in (
            "platform/containers/pin-builder",
            "platform/deploy/acceptance/pin",
        ):
            directory = self.source.child_path + "/" + relative_directory
            for name in sorted(os.listdir(directory)):
                if name.endswith(".test.mjs"):
                    test_files.append(self.tree.open_file_beneath(
                        self.source,
                        f"{relative_directory}/{name}",
                        f"Pin Node test {relative_directory}/{name}",
                    ))
        if not test_files:
            fail("Pin lane found no policy tests")
        concurrency = max(1, min(4, os.cpu_count() or 1))
        run_held_child(
            self.node,
            (
                "--test",
                f"--test-concurrency={concurrency}",
                *(test_file.child_path for test_file in test_files),
            ),
            tree=self.tree,
            environment=self.environment,
            cwd=self.source.child_path,
        )

    def image_name(self) -> str:
        return f"ai-pin-revival/pin-builder:session-{self.source_generation.generation[:20]}"

    def _docker_environment(self) -> dict[str, str]:
        return child_environment(
            self.home,
            self.xdg,
            self.npm_user,
            self.npm_global,
            {
                "DOCKER_CONFIG": self.docker_config.child_path,
                "DOCKER_HOST": "unix:///var/run/docker.sock",
            },
        )

    def docker_child(
        self,
        arguments: Iterable[str],
        *,
        stdin_descriptor: int | None = None,
        extra_descriptors: Iterable[int] = (),
        capture: bool = False,
    ) -> bytes:
        self.revalidate()
        _status, output, _error = run_held_child(
            self.docker,
            arguments,
            tree=self.tree,
            environment=self._docker_environment(),
            cwd=self.source.child_path,
            stdin_descriptor=stdin_descriptor,
            extra_descriptors=(
                self.source_generation.tar_descriptor,
                self.source_generation.manifest_descriptor,
                *extra_descriptors,
            ),
            capture=capture,
        )
        self.revalidate()
        return output

    @staticmethod
    def _image_id(value: bytes, label: str) -> str:
        try:
            text = value.decode("ascii", "strict").strip()
        except UnicodeError:
            fail(f"{label} is not strict ASCII")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", text):
            fail(f"{label} is not one immutable sha256 image ID")
        return text

    def inspect_image_id(self, reference: str) -> str:
        output = self.docker_child(
            ("image", "inspect", "--format={{.Id}}", reference),
            capture=True,
        )
        return self._image_id(output, "Docker image inspection")

    def build_image(self, image: str) -> str:
        empty_proxy = (
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
            "http_proxy", "https_proxy", "all_proxy", "no_proxy",
        )
        iid = SealedSourceGeneration._memfd("revival-pin-builder-iid")
        try:
            self.docker_child((
                "build",
                "--progress=plain",
                "--platform",
                "linux/amd64",
                *(token for name in empty_proxy for token in ("--build-arg", f"{name}=")),
                "--file",
                "platform/containers/pin-builder/Dockerfile",
                "--tag",
                image,
                "--iidfile",
                f"/proc/self/fd/{iid}",
                "-",
            ), stdin_descriptor=self.source_generation.tar_descriptor,
               extra_descriptors=(iid,))
            identifier = self._image_id(
                bounded_descriptor_bytes(iid, 256, "Docker iidfile"),
                "Docker iidfile",
            )
            SealedSourceGeneration._seal(iid, "Docker iidfile")
            if self.inspect_image_id(image) != identifier:
                fail("Docker tag does not resolve to the captured build image ID")
            if self.inspect_image_id(identifier) != identifier:
                fail("captured Docker image ID is not inspectable by immutable identity")
            return identifier
        finally:
            os.close(iid)

    def run_builder(self, image_id: str, diagnostic_tag: str, roles: tuple[str, ...]) -> None:
        uid = os.getuid()
        gid = os.getgid()
        mount = lambda authority, target, readonly=False: (
            f"type=bind,src={authority},dst={target}" +
            (",readonly" if readonly else "")
        )
        command: tuple[str, ...]
        if self.lane == "check":
            command = ("lane-session", "check-unit")
        else:
            command = (
                "lane-session",
                "build-debug-role",
                *(token for role in roles for token in ("--role", role)),
            )
        tool = "/tmp/revival-pin-credential-free"
        container_environment = (
            f"HOME={tool}/home",
            f"XDG_CONFIG_HOME={tool}/xdg-config",
            f"XDG_CACHE_HOME={tool}/xdg-cache",
            f"XDG_DATA_HOME={tool}/xdg-data",
            f"XDG_STATE_HOME={tool}/xdg-state",
            f"GRADLE_USER_HOME={tool}/gradle",
            f"CARGO_HOME={tool}/cargo",
            f"NPM_CONFIG_CACHE={tool}/npm-cache",
            f"NPM_CONFIG_USERCONFIG={tool}/npm-config/user.npmrc",
            f"NPM_CONFIG_GLOBALCONFIG={tool}/npm-config/global.npmrc",
            f"ANDROID_USER_HOME={tool}/android",
            "GIT_CONFIG_GLOBAL=/dev/null",
            "GIT_CONFIG_SYSTEM=/dev/null",
            "GIT_CONFIG_NOSYSTEM=1",
            "GIT_ATTR_NOSYSTEM=1",
            "GIT_TERMINAL_PROMPT=0",
        )
        # The tag is diagnostic only. A same-name replacement after this check
        # cannot redirect execution because `docker run` receives the captured
        # content ID and never the mutable tag.
        if self.inspect_image_id(diagnostic_tag) != image_id:
            fail("Docker builder tag changed before immutable-ID execution")
        self.docker_child((
            "run", "--rm", "--init", "--platform", "linux/amd64", "--read-only",
            "--network", "bridge", "--user", f"{uid}:{gid}",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--pids-limit", "512", "--memory", "6g",
            "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=2147483648",
            "--mount", mount(self.source_generation.broker_tar_path, "/run/revival-source.tar", True),
            "--mount", mount(self.source_generation.broker_manifest_path, "/run/revival-source-manifest.json", True),
            "--mount", mount(self.state.broker_path, "/state"),
            *(token for directory, (_name, target) in zip(self.cache_leaves, HOST_CACHE_LEAVES)
              for token in ("--mount", mount(directory.broker_path, target))),
            *(token for value in container_environment for token in ("--env", value)),
            image_id,
            *command,
        ))
        if self.inspect_image_id(image_id) != image_id:
            fail("Docker builder image identity changed after execution")

    def execute(self, *, roles: tuple[str, ...], changed: bool, base: str | None) -> tuple[str, ...]:
        self.run_source_policy()
        selected = self.changed_roles(base) if changed else roles
        if self.lane == "debug":
            if not selected or tuple(role for role in DEBUG_ROLES if role in selected) != selected:
                fail("debug roles must be unique and use the fixed global order")
        elif selected:
            fail("the check lane does not accept debug roles")
        if self.lane == "check":
            self.run_node_policy_tests()
        image = self.image_name()
        image_id = self.build_image(image)
        self.run_builder(image_id, image, selected)
        self.revalidate()
        return selected

    def close(self) -> None:
        if not self._closed:
            if hasattr(self, "git_object_watcher"):
                self.git_object_watcher.close()
            for watcher, _name in reversed(getattr(self, "git_ref_edge_watchers", [])):
                watcher.close()
            self.source_watcher.close()
            self.source_generation.close()
            self.tree.close()
            self._closed = True

    def __enter__(self) -> "ContinuousLaneSession":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class ContainerLaneSession:
    """Retain mounted and fresh tool authority while the compiler child runs."""

    FIXED_PATH = (
        "/opt/java/openjdk/bin:"
        "/opt/android-sdk/cmdline-tools/15859902/bin:"
        "/opt/android-sdk/build-tools/35.0.0:"
        "/usr/local/cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    )

    def __init__(self, lane: str) -> None:
        if lane not in ("check", "debug"):
            fail("container lane must be check or debug")
        self.lane = lane
        self.tree = WatchedAuthorityTree()
        self.source_tar = self.tree.open_file_absolute(
            "/run/revival-source.tar",
            "mounted sealed Pin source tar",
            sealed=True,
        )
        self.source_manifest = self.tree.open_file_absolute(
            "/run/revival-source-manifest.json",
            "mounted sealed Pin source manifest",
            sealed=True,
        )
        self.source_generation = SealedSourceGeneration.from_descriptors(
            self.source_tar.descriptor,
            self.source_manifest.descriptor,
        )
        self.state_mount = self.tree.open_absolute(
            "/state",
            "container lane state mount",
            private_final=True,
            contents_mutable=True,
        )
        self.cache_leaves = [
            self.tree.open_absolute(
                target,
                f"container {name} cache-data mount",
                private_final=True,
                contents_mutable=True,
            )
            for name, target in HOST_CACHE_LEAVES
        ]
        self.device_build = self.tree.create_fixed_child(
            self.state_mount,
            "device-build",
            "container device-build state",
            contents_mutable=True,
        )
        self.cargo_runtime_target = self._state_directory(
            "cargo-runtime-target",
            "container runtime/core Cargo target",
        )
        self.cargo_bridge_target = self._state_directory(
            "cargo-bridge-target",
            "container bridge Cargo target",
        )
        self.cargo_debug_target = self._state_directory(
            "cargo-debug-runtime-core",
            "container debug runtime/core Cargo target",
        )
        self.gradle_contracts = self._state_directory(
            "gradle-contracts-project",
            "container contracts Gradle project cache",
        )
        self.gradle_injector = self._state_directory(
            "gradle-injector-project",
            "container injector Gradle project cache",
        )
        self.gradle_debug_root = self._state_directory(
            "gradle-debug-root-project",
            "container debug root Gradle project cache",
        )
        self.gradle_debug_injector = self._state_directory(
            "gradle-debug-injector-project",
            "container debug injector Gradle project cache",
        )
        artifacts = self.tree.create_fixed_child(
            self.state_mount,
            "artifacts",
            "container artifact parent",
            contents_mutable=True,
        )
        self.debug_artifacts = self.tree.create_fixed_child(
            artifacts,
            "device-debug",
            "container debug artifact root",
            contents_mutable=True,
        )

        temporary = self.tree.open_absolute(
            "/tmp",
            "container private tmpfs",
            private_final=False,
            contents_mutable=True,
        )
        self.tool = self.tree.create_random_child(
            temporary,
            ".revival-pin-tool.",
            "fresh credential-free tool root",
            contents_mutable=True,
        )
        self.workspace = self._directory("source", "verified sealed source authority")
        self.source_watcher = self.source_generation.extract_into(self.workspace)
        self.compiler_workspace = self._directory(
            "compiler-source",
            "container-private ephemeral compiler workspace",
        )
        compiler_capture = self.source_generation.extract_into(self.compiler_workspace)
        self.source_generation.verify_extraction(self.compiler_workspace.descriptor)
        compiler_capture.assert_clean()
        compiler_capture.close()
        self.pin_source = self.tree.open_existing_child(
            self.compiler_workspace,
            "pin",
            "container-private ephemeral Pin compiler root",
            private=False,
            contents_mutable=True,
        )
        platform_root = self.tree.open_existing_child(
            self.workspace,
            "platform",
            "container platform source root",
            private=False,
            contents_mutable=True,
        )
        containers = self.tree.open_existing_child(
            platform_root,
            "containers",
            "container tool ancestor",
            private=False,
            contents_mutable=True,
        )
        self.tool_source = self.tree.open_existing_child(
            containers,
            "pin-builder",
            "container Pin builder tool root",
            private=False,
            contents_mutable=True,
        )
        self.home = self._directory("home", "fresh HOME")
        self.xdg_config = self._directory("xdg-config", "fresh XDG config")
        self.xdg_cache = self._directory("xdg-cache", "fresh XDG cache")
        self.xdg_data = self._directory("xdg-data", "fresh XDG data")
        self.xdg_state = self._directory("xdg-state", "fresh XDG state")
        self.android = self._directory("android", "fresh Android user home")
        self.cargo = self._directory("cargo", "fresh Cargo home")
        self.gradle = self._directory("gradle", "fresh Gradle home")
        self.npm_cache = self._directory("npm-cache", "fresh npm cache root")
        self.npm_config = self._directory("npm-config", "fresh npm configuration")
        self.tree.create_link(
            self.cargo,
            "registry",
            self.cache_leaves[0],
            "Cargo registry cache link",
        )
        self.tree.create_link(
            self.cargo,
            "git",
            self.cache_leaves[1],
            "Cargo Git cache link",
        )
        self.tree.create_link(
            self.gradle,
            "caches",
            self.cache_leaves[2],
            "Gradle caches link",
        )
        self.tree.create_link(
            self.gradle,
            "wrapper",
            self.cache_leaves[3],
            "Gradle wrapper link",
        )
        self.tree.create_link(
            self.npm_cache,
            "_cacache",
            self.cache_leaves[4],
            "npm content cache link",
        )
        self.npm_user = self.tree.create_file(
            self.npm_config,
            ".user.",
            "empty npm user configuration",
            b"",
        )
        self.npm_global = self.tree.create_file(
            self.npm_config,
            ".global.",
            "empty npm global configuration",
            b"",
        )
        self.bash = self.tree.open_file_absolute(
            "/usr/bin/bash",
            "trusted container Bash",
            root_owned=True,
            executable=True,
        )
        self.entrypoint = self.tree.open_file_absolute(
            "/usr/local/bin/ai-pin-device-builder",
            "installed container entrypoint",
            root_owned=True,
            executable=True,
        )
        self.debug_store = self.tree.open_file_absolute(
            "/usr/local/libexec/ai-pin-debug-store",
            "installed container descriptor broker",
            root_owned=True,
            executable=True,
        )
        self.bootstrap_aliuhook = self.tree.open_file_beneath(
            self.tool_source,
            "bootstrap-aliuhook.sh",
            "sealed Aliuhook bootstrap helper",
            executable=True,
        )
        self.revalidate()

    def _directory(self, name: str, label: str) -> WatchedDirectory:
        return self.tree.create_fixed_child(
            self.tool,
            name,
            label,
            contents_mutable=True,
        )

    def _state_directory(self, name: str, label: str) -> WatchedDirectory:
        return self.tree.create_fixed_child(
            self.device_build,
            name,
            label,
            contents_mutable=True,
        )

    def revalidate(self) -> None:
        self.source_watcher.assert_clean()
        self.source_generation.verify_extraction(self.workspace.descriptor)
        self.tree.revalidate_all()
        self.source_watcher.assert_clean()

    def environment(self) -> dict[str, str]:
        return {
            "HOME": self.home.child_path,
            "XDG_CONFIG_HOME": self.xdg_config.child_path,
            "XDG_CACHE_HOME": self.xdg_cache.child_path,
            "XDG_DATA_HOME": self.xdg_data.child_path,
            "XDG_STATE_HOME": self.xdg_state.child_path,
            "GRADLE_USER_HOME": self.gradle.child_path,
            "CARGO_HOME": self.cargo.child_path,
            "NPM_CONFIG_CACHE": self.npm_cache.child_path,
            "NPM_CONFIG_USERCONFIG": self.npm_user.child_path,
            "NPM_CONFIG_GLOBALCONFIG": self.npm_global.child_path,
            "ANDROID_USER_HOME": self.android.child_path,
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_SYSTEM": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_ATTR_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": self.FIXED_PATH,
            "JAVA_HOME": "/opt/java/openjdk",
            "ANDROID_HOME": "/opt/android-sdk",
            "ANDROID_SDK_ROOT": "/opt/android-sdk",
            "ANDROID_NDK_HOME": "/opt/android-sdk/ndk/28.2.13676358",
            "ANDROID_NDK_ROOT": "/opt/android-sdk/ndk/28.2.13676358",
            "AI_PIN_ANDROID_PLATFORM_VERSION": "34",
            "AI_PIN_ANDROID_BUILD_TOOLS_VERSION": "35.0.0",
            "AI_PIN_ANDROID_NDK_VERSION": "28.2.13676358",
            "RUSTUP_HOME": "/usr/local/rustup",
            "PYTHONDONTWRITEBYTECODE": "1",
            "REVIVAL_PIN_LANE_INNER": "1",
            "REVIVAL_PIN_EPHEMERAL_COMPILER_SOURCE": "1",
            "REVIVAL_HELD_PIN_SOURCE_ROOT": self.pin_source.child_path,
            "REVIVAL_HELD_TOOL_ROOT": self.tool_source.child_path,
            "REVIVAL_HELD_DEBUG_STORE_TOOL": self.debug_store.child_path,
            "REVIVAL_HELD_BOOTSTRAP_ALIUHOOK": self.bootstrap_aliuhook.child_path,
            "REVIVAL_HELD_STATE_ROOT": self.device_build.child_path,
            "REVIVAL_HELD_WORK_ROOT": self.pin_source.child_path,
            "REVIVAL_HELD_DEBUG_ARTIFACT_ROOT": self.debug_artifacts.child_path,
            "REVIVAL_HELD_CARGO_RUNTIME_TARGET": self.cargo_runtime_target.child_path,
            "REVIVAL_HELD_CARGO_BRIDGE_TARGET": self.cargo_bridge_target.child_path,
            "REVIVAL_HELD_CARGO_DEBUG_TARGET": self.cargo_debug_target.child_path,
            "REVIVAL_HELD_GRADLE_CONTRACTS": self.gradle_contracts.child_path,
            "REVIVAL_HELD_GRADLE_INJECTOR": self.gradle_injector.child_path,
            "REVIVAL_HELD_GRADLE_DEBUG_ROOT": self.gradle_debug_root.child_path,
            "REVIVAL_HELD_GRADLE_DEBUG_INJECTOR": self.gradle_debug_injector.child_path,
        }

    def execute(self, command: str, arguments: tuple[str, ...]) -> None:
        if self.lane == "check":
            if command != "check-unit" or arguments:
                fail("check container session accepts only check-unit")
        elif command != "build-debug-role":
            fail("debug container session accepts only build-debug-role")
        self.revalidate()
        run_held_child(
            self.bash,
            (self.entrypoint.child_path, command, *arguments),
            tree=self.tree,
            environment=self.environment(),
            cwd=self.compiler_workspace.child_path,
        )
        self.revalidate()

    def close(self) -> None:
        self.source_watcher.close()
        self.source_generation.close()
        self.tree.close()

    def __enter__(self) -> "ContainerLaneSession":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def container_lane_session(lane: str, command: str, arguments: tuple[str, ...]) -> None:
    with ContainerLaneSession(lane) as session:
        session.execute(command, arguments)


def lane_session(
    data_root: str,
    build_root: str,
    source_root: str,
    lane: str,
    roles: Iterable[str],
    *,
    changed: bool,
    base: str | None,
) -> None:
    requested = tuple(roles)
    if len(set(requested)) != len(requested):
        fail("debug roles must not repeat")
    with ContinuousLaneSession(data_root, build_root, source_root, lane) as session:
        selected = session.execute(roles=requested, changed=changed, base=base)
        if lane == "debug":
            print(f"lane-session: selected debug roles: {', '.join(selected)}")
        else:
            print("lane-session: canonical Pin contributor checks passed")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    lane = commands.add_parser("lane-session")
    lane.add_argument("data_root")
    lane.add_argument("build_root")
    lane.add_argument("source_root")
    lane.add_argument("lane", choices=("check", "debug"))
    lane.add_argument("--role", action="append", default=[], choices=DEBUG_ROLES)
    lane.add_argument("--changed", action="store_true")
    lane.add_argument("--base")
    container_lane = commands.add_parser("container-session")
    container_lane.add_argument("lane", choices=("check", "debug"))
    container_lane.add_argument("inner_command", choices=("check-unit", "build-debug-role"))
    container_lane.add_argument("inner_arguments", nargs=argparse.REMAINDER)
    build_publish_command = commands.add_parser("build-publish")
    build_publish_command.add_argument("root")
    build_publish_command.add_argument(
        "--role-output",
        action="append",
        nargs=2,
        required=True,
        metavar=("ROLE", "OUTPUT"),
    )
    publish_command = commands.add_parser("publish")
    publish_command.add_argument("root")
    publish_command.add_argument("stage")
    publish_command.add_argument("roles", nargs="+")
    discard_command = commands.add_parser("discard")
    discard_command.add_argument("root")
    discard_command.add_argument("stage")
    select_command = commands.add_parser("select-latest")
    select_command.add_argument("root")
    select_command.add_argument("--json", action="store_true", dest="json_output")
    hosted_command = commands.add_parser("require-hosted-native-attestation")
    hosted_command.add_argument("--request", required=True)
    hosted_command.add_argument("--bundle", required=True)
    hosted_command.add_argument("--output", required=True)
    describe_command = commands.add_parser("describe-native-source")
    describe_command.add_argument("source_root")
    return result


def main() -> int:
    arguments = parser().parse_args()
    lock_process_descriptor_authority()
    if arguments.command == "container-session":
        container_lane_session(
            arguments.lane,
            arguments.inner_command,
            tuple(arguments.inner_arguments),
        )
    elif arguments.command == "lane-session":
        if arguments.base is not None and not arguments.changed:
            fail("--base requires --changed")
        if arguments.changed and arguments.role:
            fail("--changed cannot be combined with --role")
        if arguments.lane == "check" and (arguments.role or arguments.changed):
            fail("the check lane accepts no debug selection")
        if arguments.lane == "debug" and not arguments.changed and not arguments.role:
            fail("the debug lane requires --role or --changed")
        lane_session(
            arguments.data_root,
            arguments.build_root,
            arguments.source_root,
            arguments.lane,
            arguments.role,
            changed=arguments.changed,
            base=arguments.base,
        )
    elif arguments.command == "build-publish":
        build_publish(arguments.root, arguments.role_output)
    elif arguments.command == "publish":
        publish_existing(arguments.root, arguments.stage, arguments.roles)
    elif arguments.command == "discard":
        discard(arguments.root, arguments.stage)
    elif arguments.command == "select-latest":
        select_latest(arguments.root, json_output=arguments.json_output)
    elif arguments.command == "require-hosted-native-attestation":
        require_trusted_hosted_native_attestation(
            arguments.request,
            arguments.bundle,
            arguments.output,
        )
    elif arguments.command == "describe-native-source":
        describe_native_source_generation(arguments.source_root)
    else:  # pragma: no cover - argparse owns this branch.
        fail("unknown debug-store command")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ChildSignal as error:
        signal.signal(error.signum, signal.SIG_DFL)
        os.kill(os.getpid(), error.signum)
        raise SystemExit(128 + error.signum)
    except ChildStatus as error:
        raise SystemExit(error.status)
    except StoreError as error:
        print(f"debug-store: {error}", file=sys.stderr)
        raise SystemExit(1)
