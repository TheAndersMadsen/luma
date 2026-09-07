"""Screen context the owner attaches on purpose: the current text selection.

Everything here is bounded and optional. The capture shells out to ``wl-paste``
(primary selection first, then the clipboard) and names the app from the active
Hyprland window through ``hyprctl``; both are skipped when absent. Nothing is
read until the owner clicks "Use selection", and the host runs :func:`capture`
off the UI thread. The pure helpers are unit-tested without a desktop.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable, Optional

MAX_CONTEXT_BYTES = 8000  # COSMOS_SURFACE_MAX_CONTEXT_BYTES
MAX_APP_BYTES = 64  # COSMOS_SURFACE_MAX_CONTEXT_APP_BYTES
UNKNOWN_APP = "Unknown app"
PASTE_TIMEOUT = 2.0
WINDOW_TIMEOUT = 1.0
# Primary selection first (what is highlighted right now), then the clipboard.
PASTE_COMMANDS = (("wl-paste", "--primary", "--no-newline"), ("wl-paste", "--no-newline"))
WINDOW_COMMAND = ("hyprctl", "activewindow", "-j")
Runner = Callable[..., "subprocess.CompletedProcess[bytes]"]
Which = Callable[[str], Optional[str]]


@dataclass(frozen=True)
class ScreenContext:
    """What Cosmos is told: the app name and the selected text, both bounded."""

    app: str
    text: str
    truncated: bool = False
    source: str = "selection"


def bounded_text(value: str, maximum: int) -> tuple[str, bool]:
    """Cut on a character boundary so the UTF-8 encoding fits ``maximum`` bytes."""
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum:
        return value, False
    return encoded[:maximum].decode("utf-8", errors="ignore"), True


def bounded_context(app: str, text: str) -> Optional[ScreenContext]:
    """The bounded context, or None when there is no text worth attaching."""
    clean = text.replace("\0", "")
    if not clean.strip():
        return None
    body, truncated = bounded_text(clean, MAX_CONTEXT_BYTES)
    if not body.strip():
        return None
    name = " ".join(app.replace("\0", "").split())
    name = bounded_text(name or UNKNOWN_APP, MAX_APP_BYTES)[0].strip() or UNKNOWN_APP
    return ScreenContext(app=name, text=body, truncated=truncated)


def app_from_window(payload: str) -> str:
    """The app name from ``hyprctl activewindow -j``: the window class, else the title."""
    try:
        record = json.loads(payload)
    except ValueError:
        return ""
    if not isinstance(record, dict):
        return ""
    for key in ("class", "initialClass", "title", "initialTitle"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def available(which: Which = shutil.which) -> bool:
    """Whether this desktop can offer a selection at all (Wayland with wl-clipboard)."""
    return which(PASTE_COMMANDS[0][0]) is not None


def _run(runner: Runner, command: tuple, timeout: float) -> Optional[bytes]:
    try:
        result = runner(list(command), capture_output=True, timeout=timeout, check=False, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return bytes(result.stdout or b"")


def capture(runner: Runner = subprocess.run, which: Which = shutil.which) -> Optional[ScreenContext]:
    """Read the selection and the active app. Blocking and bounded; call it off the UI thread."""
    if not available(which):
        return None
    text = ""
    for command in PASTE_COMMANDS:
        output = _run(runner, command, PASTE_TIMEOUT)
        if output:
            # Only the bounded prefix is ever decoded; a huge selection costs nothing more.
            text = output[: MAX_CONTEXT_BYTES * 4].decode("utf-8", errors="replace")
            if text.strip():
                break
    if not text.strip():
        return None
    app = ""
    if which(WINDOW_COMMAND[0]) is not None:
        output = _run(runner, WINDOW_COMMAND, WINDOW_TIMEOUT)
        if output:
            app = app_from_window(output[:65536].decode("utf-8", errors="replace"))
    return bounded_context(app, text)
