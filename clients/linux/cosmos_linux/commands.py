"""Supervise one fixed owner-authored task without blocking the Qt thread.

The process has the user's ordinary filesystem access; this is not a sandbox.
Only its own process group can be supervised. Output stays bounded in memory,
is never executed, and reaches Cosmos as an observation, not a new instruction.
"""
from __future__ import annotations

import os
import json
import re
import selectors
import signal
import subprocess
import threading
import time
import unicodedata
from typing import Optional

from .policy import CommandEntry

MAX_OUTPUT = 6144
MAX_COUNT = 16 * 1024 * 1024
PATH = "/usr/local/bin:/usr/bin:/bin"


def environment() -> dict:
    return {"PATH": PATH, "HOME": os.path.expanduser("~"), "LANG": os.environ.get("LANG", "C.UTF-8"),
            "TERM": "dumb", "NO_COLOR": "1"}


def executable(entry: CommandEntry) -> Optional[str]:
    """Absolute executable, or a regular executable inside the approved cwd.

    Like macOS, relative program names resolve inside cwd, never through PATH.
    """
    if not os.path.isdir(entry.cwd):
        return None
    cwd = os.path.realpath(entry.cwd)
    program = entry.argv[0]
    resolved = os.path.realpath(program if program.startswith("/") else os.path.join(cwd, program))
    if not program.startswith("/") and not resolved.startswith(cwd.rstrip("/") + "/"):
        return None
    return resolved if os.path.isfile(resolved) and os.access(resolved, os.X_OK) else None


class Output:
    """Keep both ends and count all bytes without retaining unbounded output."""

    def __init__(self) -> None:
        self.data = b""
        self.total = 0
        self.dropped = False

    def append(self, chunk: bytes) -> None:
        self.total += len(chunk)
        self.data += chunk
        if len(self.data) > 2 * MAX_OUTPUT:
            self.data = self.data[:MAX_OUTPUT] + self.data[-MAX_OUTPUT:]
            self.dropped = True

    def text(self) -> tuple[str, bool]:
        value = self.data.decode("utf-8", errors="replace")
        # Remove terminal escape strings as data; never interpret them in a UI.
        value = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b.", "", value)
        value = "".join(c for c in value if c in "\n\t" or unicodedata.category(c) not in ("Cc", "Cf"))
        raw = value.encode("utf-8")
        truncated = self.dropped or len(raw) > MAX_OUTPUT or self.total > MAX_COUNT
        limit = MAX_OUTPUT
        while truncated or len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > 8192:
            truncated = True
            marker = "\n[…]\n"
            side = (limit - len(marker.encode("utf-8"))) // 2
            head = min(side, (len(raw) + 1) // 2)
            tail = min(side, len(raw) - head)
            value = raw[:head].decode("utf-8", errors="ignore") + marker + raw[len(raw) - tail:].decode("utf-8", errors="ignore")
            # Leave room for the report and signed room frame even when every
            # output byte needs JSON escaping. Never send an oversized result.
            if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) <= 8192:
                break
            limit = limit * 3 // 4
        return value, truncated


def declined(reason: str) -> dict:
    return {"outcome": "refused", "evidence": {"kind": "declined", "reason": reason}}


class CommandRunner:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._busy = False
        self._result: Optional[dict] = None

    @property
    def busy(self) -> bool:
        with self._lock:
            return self._busy

    def start(self, entry: CommandEntry) -> bool:
        with self._lock:
            if self._busy:
                return False
            self._busy = True
            self._result = None
            self._stop.clear()
        # Normal application shutdown requests stop and lets this bounded
        # supervisor finish; a daemon thread could exit before killing a child.
        threading.Thread(target=self._work, args=(entry,), name="cosmos-task", daemon=False).start()
        return True

    def stop(self) -> None:
        # The worker performs the bounded termination. The UI never waits for it.
        self._stop.set()

    def poll(self) -> Optional[dict]:
        with self._lock:
            result, self._result = self._result, None
            return result

    def _work(self, entry: CommandEntry) -> None:
        try:
            result = self._run(entry)
        except (OSError, ValueError):
            result = {"outcome": "unknown", "evidence": {"kind": "command", "entryId": entry.id,
                       "durationMs": 0, "outputBytes": 0, "truncated": True}}
        with self._lock:
            self._result = result
            self._busy = False

    def _run(self, entry: CommandEntry) -> dict:
        if entry.mutates:
            return declined("no_attestation")
        program = executable(entry)
        if program is None:
            return declined("no_handler")
        if self._stop.is_set():
            return declined("not_permitted")
        started = time.monotonic()
        try:
            process = subprocess.Popen([program, *entry.argv[1:]], cwd=entry.cwd, env=environment(),
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       start_new_session=True, close_fds=True)
        except (OSError, ValueError):
            return declined("no_handler")
        capture = Output()
        stopping = None
        stopped = False
        observed = True
        try:
            with selectors.DefaultSelector() as reader:
                os.set_blocking(process.stdout.fileno(), False)
                reader.register(process.stdout, selectors.EVENT_READ)
                while True:
                    now = time.monotonic()
                    status = process.poll()
                    if (self._stop.is_set() or now - started >= entry.budget_ms / 1000) and stopping is None:
                        stopping = now
                        stopped = True
                        self._signal(process, signal.SIGTERM)
                    if stopping is not None and now - stopping >= 0.5:
                        # Signal the original group even when its leader exited.
                        self._signal(process, signal.SIGKILL)
                    if stopping is not None and now - stopping >= 1.5:
                        observed = status is not None and not reader.get_map()
                        break
                    for key, _ in reader.select(0.025):
                        chunk = os.read(key.fd, 16 * 1024)
                        if chunk:
                            capture.append(chunk)
                        else:
                            reader.unregister(key.fileobj)
                    if status is not None and not reader.get_map():
                        # Retire the group before reusing this executor; a daemon
                        # that escaped the group is outside its stated isolation.
                        self._signal(process, signal.SIGKILL)
                        break
        except (OSError, ValueError):
            observed = False
            self._signal(process, signal.SIGKILL)
        finally:
            process.stdout.close()
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                observed = False
                self._signal(process, signal.SIGKILL)
        output, truncated = capture.text()
        code = process.returncode
        outcome = "unknown" if not observed or code is None else "cancelled" if stopped else "completed" if code >= 0 else "failed"
        evidence = {"kind": "command", "entryId": entry.id, "durationMs": min(900_000, int((time.monotonic() - started) * 1000)),
                    "outputBytes": min(capture.total, MAX_COUNT), "truncated": truncated or not observed}
        if code is not None and code >= 0:
            evidence["exitCode"] = code
        return {"outcome": outcome, "evidence": evidence, **({"output": output} if output else {})}

    @staticmethod
    def _signal(process: subprocess.Popen, value: signal.Signals) -> None:
        try:
            os.killpg(process.pid, value)
        except ProcessLookupError:
            pass
