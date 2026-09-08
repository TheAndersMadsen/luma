"""An immutable, bounded text document for the native destination viewer.

The bytes are read once and verified before they become UI state. Rendering
never reopens the path, executes markup, follows links or reads neighbouring
files. This is destination handling; it grants no source or transfer permission.
"""
from __future__ import annotations

import hashlib
import os
import stat
from dataclasses import dataclass, field
from typing import Optional

MAX_BYTES = 256 * 1024


@dataclass(frozen=True)
class Document:
    text: str = field(repr=False)
    digest: str
    line: int
    # Qt cursor positions count UTF-16 code units, not Python code points.
    cursor: int


class Unavailable(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def from_bytes(data: bytes, version: str, position: Optional[dict]) -> Document:
    if len(data) > MAX_BYTES:
        raise Unavailable("no_handler")
    digest = hashlib.sha256(data).hexdigest()
    if digest != version:
        raise Unavailable("version_changed")
    try:
        text = data.decode("utf-8").replace("\r\n", "\n")
    except UnicodeDecodeError:
        raise Unavailable("no_handler") from None
    # Only plain text whose line positions the viewer can preserve. In
    # particular, an HTML document is displayed as text, never interpreted.
    if any((ord(char) < 32 and char not in "\t\n") or char in "\x7f\u2028\u2029"
           for char in text):
        raise Unavailable("no_handler")
    if position is not None and position.get("kind") != "line":
        raise Unavailable("no_handler")
    line = position.get("line") if position is not None else 1
    if type(line) is not int or not 1 <= line <= text.count("\n") + 1:
        raise Unavailable("unresolvable")
    prefix = "\n".join(text.split("\n")[:line - 1]) + ("\n" if line > 1 else "")
    return Document(text, digest, line, len(prefix.encode("utf-16-le")) // 2)


def read(path: str, version: str, position: Optional[dict]) -> Document:
    """Read a previously policy-resolved regular file, with a hard byte bound.

    A changed file cannot replace the bound version, even between planning and
    painting: the viewer holds the verified bytes instead of their pathname.
    """
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
                raise Unavailable("no_handler")
            data = handle.read(MAX_BYTES + 1)
    except OSError:
        raise Unavailable("unresolvable") from None
    return from_bytes(data, version, position)
