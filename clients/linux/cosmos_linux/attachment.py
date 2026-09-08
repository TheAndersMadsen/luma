"""Read one explicitly chosen saved text file under the delivered owner policy.

Nothing is uploaded here. The retained bytes and their version travel together
only when the owner sends the request, through the existing document call.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
from typing import Optional

from .context import MAX_CONTEXT_BYTES, ScreenContext
from .document import Unavailable, from_bytes
from .policy import Policy, valid_relative, _plain, InvalidPolicy, MAX_LABEL_BYTES


class AttachmentError(ValueError):
    """A content-free explanation suitable for the attachment control."""


def read_file(path: str, policy: Optional[Policy]) -> ScreenContext:
    if policy is None or not policy.roots:
        raise AttachmentError("Allow a document folder for this computer in Center first.")
    candidate = os.path.realpath(path)
    matches = []
    for root in policy.roots:
        base = os.path.realpath(root.path)
        prefix = base.rstrip("/") + "/"
        if candidate.startswith(prefix) and valid_relative(candidate[len(prefix):]):
            matches.append((base, root.id, candidate[len(prefix):]))
    if not matches:
        raise AttachmentError("Choose a file inside a folder allowed for this computer in Center.")
    base, root_id, relative = max(matches, key=lambda value: len(value[0]))
    # Walk the resolved root too, so replacement symlinks in any directory
    # component are refused between locating the file and reading it.
    descriptor = None
    try:
        flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
        descriptor = os.open("/", flags | os.O_DIRECTORY)
        parts = [part for part in base.split("/") if part] + relative.split("/")
        for index, part in enumerate(parts):
            child = os.open(part, flags | (os.O_DIRECTORY if index < len(parts) - 1 else 0), dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise AttachmentError("Choose a regular saved text file.")
        if before.st_size > MAX_CONTEXT_BYTES:
            raise AttachmentError("This attachment supports complete text files up to 8,000 bytes.")
        raw = b""
        while len(raw) <= MAX_CONTEXT_BYTES:
            chunk = os.read(descriptor, MAX_CONTEXT_BYTES + 1 - len(raw))
            if not chunk:
                break
            raw += chunk
        after = os.fstat(descriptor)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise AttachmentError("The file changed while it was read. Attach it again.")
    except OSError:
        raise AttachmentError("The selected file could not be read. Check its access and attach it again.") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if len(raw) > MAX_CONTEXT_BYTES:
        raise AttachmentError("This attachment supports complete text files up to 8,000 bytes.")
    version = hashlib.sha256(raw).hexdigest()
    try:
        from_bytes(raw, version, None)
        text = raw.decode("utf-8")  # Retain CRLF and whitespace for the exact digest.
        label = _plain(os.path.basename(candidate), MAX_LABEL_BYTES)
    except (Unavailable, UnicodeDecodeError, InvalidPolicy):
        raise AttachmentError("Choose a UTF-8 text file with a short filename and no control characters.") from None
    if not text.strip():
        raise AttachmentError("The selected file holds no text.")
    # The document channel has its own JSON budget. Reject a file that cannot
    # fit even without an explanation; never silently truncate its bytes.
    snapshot = {"text": text, "explanation": "", "version": version,
                "taskId": "0" * 36, "revision": 9007199254740991}
    if len(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode()) > 8160:
        raise AttachmentError("This file is too large for a complete document transfer.")
    document = {"app": "Text file", "locator": {"scheme": "file", "rootId": root_id, "relative": relative},
                "version": version, "label": label}
    return ScreenContext(app="Text file", text=text, source="file", label=label,
                         document=json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode())
