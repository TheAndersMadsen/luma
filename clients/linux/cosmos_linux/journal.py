"""The protected client journal and the single-instance lease.

The journal holds session secrets and possibly pending user text. It is a
0600 file replaced atomically (temporary sibling, fsync, rename) so a crash
leaves the previous bytes intact. Zero length never means delete.
"""
from __future__ import annotations

import fcntl
import os
import threading
from pathlib import Path
from typing import Optional

from .identity import ensure_private_dir, write_private_file
from .native import MAX_JOURNAL_BYTES

JOURNAL_FILE = "journal.bin"
LOCK_FILE = "cosmos.lock"


class JournalStore:
    def __init__(self, directory: Path) -> None:
        self.directory = ensure_private_dir(directory)
        self.path = self.directory / JOURNAL_FILE
        self._lock = threading.Lock()

    def read(self) -> Optional[bytes]:
        with self._lock:
            if not self.path.exists():
                return None
            if self.path.is_symlink() or not self.path.is_file():
                raise OSError(f"{self.path} is not a regular file")
            data = self.path.read_bytes()
            if not data or len(data) > MAX_JOURNAL_BYTES:
                raise ValueError("journal file is empty or oversized")
            return data

    def write_atomically(self, journal: bytes) -> None:
        if not journal or len(journal) > MAX_JOURNAL_BYTES:
            raise ValueError("journal is never empty or oversized")
        with self._lock:
            write_private_file(self.path, bytes(journal))


class AlreadyRunning(Exception):
    """Another Cosmos process holds the installation lease."""


class InstallationLease:
    """Exclusive ownership of the journal for the process lifetime (flock)."""

    def __init__(self, directory: Path) -> None:
        ensure_private_dir(directory)
        path = directory / LOCK_FILE
        self._descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self._descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            os.close(self._descriptor)
            self._descriptor = -1
            raise AlreadyRunning(str(path)) from error

    def release(self) -> None:
        if self._descriptor >= 0:
            try:
                fcntl.flock(self._descriptor, fcntl.LOCK_UN)
            finally:
                os.close(self._descriptor)
                self._descriptor = -1
