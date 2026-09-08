"""Carrying out one device action on this computer, and saying only what was seen.

Cosmos can ask this installation to open something. Three rules shape every
line here:

* **Re-verify locally.** The command is checked against this installation's own
  copy of the owner's permission — the document Cosmos delivered
  (:mod:`cosmos_linux.policy`) — *and* its content digest is recomputed from the
  canonical tuple. A host, application or root that is not in that copy is
  refused whatever the runtime said, and an installation holding no copy at all
  carries nothing out. How this desktop opens a file is separate: the openers
  file decides *how*, never *whether*.
* **Never build a command from strings.** The argv comes from the owner's own
  opener template with exactly three validated substitutions; there is no
  shell, no interpolation and no model-supplied argument.
* **Acknowledging binds, reporting is what happened.** Acknowledging says the
  command is legal here and claims nothing. Only an observation may say
  ``completed``; a launch this computer could not observe is ``unknown``.

``action.run``, ``action.route`` and ``action.play`` are not on this platform's
manifest and are refused plainly.

The decisions are pure functions. The one impure part is
:class:`ProcessLauncher`, which spawns a detached process on a worker thread
and hands back what it observed.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import signal
import subprocess
import threading
from dataclasses import dataclass
from typing import Callable, Optional, Protocol
from urllib.parse import quote, urlsplit, urlunsplit

from . import policy as policy_module
from . import document as document_module
from .policy import NO_OPENERS, Openers, Policy, Resolved, resolve_under_root

log = logging.getLogger("cosmos.actions")

# The one action channel this platform declares. The rest are refused by name.
OPEN_CHANNEL = "action.open"
UNSUPPORTED_CHANNELS = {
    "action.run": "run",
    "action.route": "route",
    "action.play": "play",
}
# What a decline is called on the wire. These four are the only ones this
# platform can honestly send: it has no owner-authored command entries and no
# lock screen of its own.
NO_HANDLER = "no_handler"
NOT_PERMITTED = "not_permitted"
UNRESOLVABLE = "unresolvable"
VERSION_CHANGED = "version_changed"

COMPLETED = "completed"
REFUSED = "refused"
FAILED = "failed"
CANCELLED = "cancelled"
UNKNOWN = "unknown"

# How long this client waits for a launcher to say what it did before deciding
# it cannot say. `action.open` declares a ten-second report budget.
OBSERVE_SECONDS = 5.0
# How long a repeat of the same command re-sends the same report instead of
# opening anything a second time.
DEDUPE_SECONDS = 600.0
# The launcher of last resort, and the two tools the richer paths need.
XDG_OPEN = "xdg-open"
GIO = "gio"
MAX_DIGEST_BYTES = 64 * 1024 * 1024


def content_digest(operation: dict) -> Optional[str]:
    """The runtime's own binding, recomputed here. A single drift refuses the
    command rather than carrying out something the owner never approved. The
    vectors live in ``contracts/fixtures/ambiance-device-action-digests-v1.json``."""
    kind = operation.get("kind")
    if kind == "open":
        locator = operation.get("locator") or {}
        scheme = locator.get("scheme")
        value = {"https": locator.get("url"), "app": locator.get("id"),
                 "file": locator.get("relative")}.get(scheme)
        position = operation.get("position")
        canonical = [
            "cosmos.device-action.open", 1, scheme, value,
            locator.get("rootId") if scheme == "file" else None,
            operation.get("version"),
            position.get("kind") if position else None,
            _position_value(position) if position else None,
            operation.get("label"),
        ]
    elif kind == "route":
        canonical = ["cosmos.device-action.route", 1, operation.get("placeId"), operation.get("name"),
                     operation.get("address"), operation.get("lat"), operation.get("lng")]
    elif kind == "play":
        canonical = ["cosmos.device-action.play", 1, operation.get("title"), operation.get("query"),
                     operation.get("providers"), operation.get("itemDigest")]
    elif kind == "run":
        canonical = ["cosmos.device-action.run", 1, operation.get("entryId"), operation.get("label"),
                     operation.get("entryDigest"), operation.get("argvDigest"), operation.get("budgetMs"),
                     operation.get("mutates")]
    else:
        return None
    return _digest(canonical)


def confirmation_digest(description: dict) -> str:
    """The exact sentence the owner is answering, hashed the way Cosmos hashes it."""
    return _digest(["cosmos.confirmation", 1, description.get("verb"), description.get("subject"),
                    description.get("deviceKind"), description.get("effect"), description.get("class")])


def _digest(canonical: list) -> str:
    encoded = json.dumps(canonical, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _position_value(position: dict) -> Optional[str]:
    kind = position.get("kind")
    if kind == "line":
        return str(position.get("line"))
    if kind == "page":
        return str(position.get("page"))
    if kind == "fragment":
        return position.get("value")
    return None


def file_digest(path: str) -> Optional[str]:
    """The document's own bytes, hashed like against like. None when unreadable."""
    digest = hashlib.sha256()
    read = 0
    try:
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                read += len(chunk)
                if read > MAX_DIGEST_BYTES:
                    return None
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


@dataclass(frozen=True)
class Launch:
    """Exactly what this computer will run, and what it may honestly say about it."""

    argv: tuple
    resolved_app: Optional[str] = None
    # What the owner reads while it happens: "Opening state.rs".
    label: str = ""


@dataclass(frozen=True)
class Plan:
    """The decision, before anything is launched. ``bound`` is what an
    acknowledgment means: this exact command is legal on this computer."""

    bound: bool
    launch: Optional[Launch] = None
    document: Optional[document_module.Document] = None
    refusal: Optional[str] = None
    # An operation this platform does not offer at all, named plainly.
    unsupported: Optional[str] = None


def plan(task, policy: Optional[Policy], openers: Openers = NO_OPENERS,
         which: Callable[[str], Optional[str]] = shutil.which,
         resolve: Callable[..., Resolved] = resolve_under_root) -> Plan:
    """What this computer will do with one command, decided entirely locally.

    ``policy`` is the owner's own permission as Cosmos delivered it, or None
    while this installation holds none — which allows nothing at all.
    """
    operation = task.operation
    if task.channel in UNSUPPORTED_CHANNELS:
        return Plan(bound=False, refusal=NOT_PERMITTED, unsupported=UNSUPPORTED_CHANNELS[task.channel])
    if task.channel != OPEN_CHANNEL or operation.get("kind") != "open":
        return Plan(bound=False, refusal=NOT_PERMITTED, unsupported=str(operation.get("kind") or "that"))
    if policy is None:
        # No permission is held here, so nothing is permitted here. That is an
        # ordinary state, and it is still a report rather than silence.
        return Plan(bound=False, refusal=NOT_PERMITTED)
    if content_digest(operation) != task.content_digest:
        # Either side drifting means this is not the command the runtime bound.
        return Plan(bound=False, refusal=NOT_PERMITTED)
    if not policy.allows_class(task.privacy):
        # The owner spent a ceiling when they gave this permission; a command
        # routed above it is not the permission that was given.
        return Plan(bound=False, refusal=NOT_PERMITTED)
    locator = operation.get("locator") or {}
    scheme = locator.get("scheme")
    position = operation.get("position")
    label = operation.get("label") or ""
    if scheme == "https":
        return _plan_https(locator.get("url") or "", operation.get("version"), position, label, policy, which)
    if scheme == "app":
        return _plan_app(locator.get("id") or "", operation.get("version"), position, label, policy, openers, which)
    if scheme == "file":
        return _plan_file(locator, operation.get("version"), position, label, policy, openers, which,
                          resolve)
    return Plan(bound=False, refusal=UNRESOLVABLE)


def _plan_https(url: str, version: Optional[str], position: Optional[dict], label: str, policy: Policy,
                which: Callable[[str], Optional[str]]) -> Plan:
    if not policy_module.valid_https(url):
        return Plan(bound=False, refusal=UNRESOLVABLE)
    if not policy.allows_host(url):
        # The owner did not write this host in this installation's own policy.
        return Plan(bound=False, refusal=NOT_PERMITTED)
    if version is not None:
        # An external browser gives this client no exact-content observation.
        return Plan(bound=False, refusal=VERSION_CHANGED)
    target = url
    if position is not None:
        if position.get("kind") != "fragment":
            # A line or a page means nothing in a browser; opening the page
            # anyway would be opening it at the wrong place.
            return Plan(bound=False, refusal=NO_HANDLER)
        fragment = position.get("value") or ""
        parts = urlsplit(url)
        target = urlunsplit(parts._replace(fragment=quote(fragment, safe="!$&'()*+,;=:@/?-._~")))
    if which(XDG_OPEN) is None:
        return Plan(bound=False, refusal=NO_HANDLER)
    return Plan(bound=True, launch=Launch(argv=(XDG_OPEN, target), label=label))


def _plan_app(identifier: str, version: Optional[str], position: Optional[dict], label: str, policy: Policy, openers: Openers,
              which: Callable[[str], Optional[str]]) -> Plan:
    entry = policy.app(identifier)
    if entry is None:
        # Only an application the delivered policy names is ever started.
        return Plan(bound=False, refusal=NOT_PERMITTED)
    if position is not None or version is not None:
        # Starting an application puts nothing at a place.
        return Plan(bound=False, refusal=NO_HANDLER)
    desktop = openers.desktop_for(identifier)
    if desktop is None or which(GIO) is None:
        # The owner allowed it; this machine does not know which entry starts
        # it. That is a local gap, not a permission.
        return Plan(bound=False, refusal=NO_HANDLER)
    return Plan(bound=True, launch=Launch(argv=(GIO, "launch", desktop),
                                          resolved_app=identifier, label=label or entry.label))


def _plan_file(locator: dict, version: Optional[str], position: Optional[dict], label: str, policy: Policy,
               openers: Openers, which: Callable[[str], Optional[str]], resolve: Callable[..., Resolved]) -> Plan:
    resolved = resolve(policy, locator.get("rootId") or "", locator.get("relative") or "")
    if resolved.path is None:
        return Plan(bound=False, refusal=resolved.reason or UNRESOLVABLE)
    if version is not None:
        try:
            return Plan(bound=True, document=document_module.read(resolved.path, version, position))
        except document_module.Unavailable as error:
            return Plan(bound=False, refusal=error.reason)
    relative = locator.get("relative") or ""
    # How this desktop opens that suffix is its own business, never Cosmos's.
    opener = openers.opener_for(relative)
    if position is not None:
        kind = position.get("kind")
        if opener is None:
            return Plan(bound=False, refusal=NO_HANDLER)
        if kind == "line" and not opener.honours_line:
            return Plan(bound=False, refusal=NO_HANDLER)
        if kind == "page" and not opener.honours_page:
            return Plan(bound=False, refusal=NO_HANDLER)
        if kind == "fragment":
            return Plan(bound=False, refusal=NO_HANDLER)
        if which(opener.program) is None:
            return Plan(bound=False, refusal=NO_HANDLER)
        argv = opener.command(resolved.path, line=position.get("line"), page=position.get("page"))
        return Plan(bound=True, launch=Launch(argv=argv, resolved_app=_app_name(opener.program),
                                              label=label))
    if opener is not None and which(opener.program) is not None:
        argv = opener.command(resolved.path)
        return Plan(bound=True, launch=Launch(argv=argv, resolved_app=_app_name(opener.program),
                                              label=label))
    if which(XDG_OPEN) is None:
        return Plan(bound=False, refusal=NO_HANDLER)
    return Plan(bound=True, launch=Launch(argv=(XDG_OPEN, resolved.path), label=label))


def _app_name(program: str) -> Optional[str]:
    """The evidence field names the handler this computer actually ran."""
    name = program.rsplit("/", 1)[-1]
    return name if policy_module.valid_app_id(name) else None


@dataclass(frozen=True)
class Observation:
    """What the launcher was seen to do. ``exit_code`` is None when this
    computer never saw it finish."""

    kind: str  # started | exited | unobserved | stopped | not_started
    exit_code: Optional[int] = None


EXITED = "exited"
UNOBSERVED = "unobserved"
STOPPED = "stopped"
NOT_STARTED = "not_started"


def refusal_report(reason: str) -> dict:
    """A refusal is a declined report, never silence."""
    return {"outcome": REFUSED, "evidence": {"kind": "declined", "reason": reason}}


def report_for(launch: Launch, observation: Observation) -> dict:
    """What this computer says happened, and nothing more than it saw.

    A launcher exiting zero is not an observation of the destination. Without
    a renderer/application bridge it cannot establish what opened there.
    """
    evidence = {"kind": "open", "opened": False, **_app(launch)}
    if observation.kind == NOT_STARTED:
        return refusal_report(NO_HANDLER)
    if observation.kind == STOPPED:
        return {"outcome": CANCELLED, "evidence": evidence}
    if observation.kind == EXITED and observation.exit_code == 0:
        return {"outcome": UNKNOWN, "evidence": evidence}
    if observation.kind == EXITED:
        return {"outcome": FAILED, "evidence": evidence}
    return {"outcome": UNKNOWN, "evidence": evidence}


def _app(launch: Optional[Launch]) -> dict:
    if launch is None or launch.resolved_app is None:
        return {}
    return {"resolvedApp": launch.resolved_app}


def report_bytes(report: dict) -> bytes:
    return json.dumps(report, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class Ledger:
    """Deduplication by idempotency key. A repeat of the same command re-sends
    the report it already produced; it never opens anything a second time."""

    def __init__(self, retention: float = DEDUPE_SECONDS) -> None:
        self._retention = retention
        self._entries: dict = {}

    def remember(self, key: str, report: dict, now: float) -> None:
        self._prune(now)
        if key:
            self._entries[key] = (dict(report), now)

    def recall(self, key: str, now: float) -> Optional[dict]:
        self._prune(now)
        entry = self._entries.get(key)
        return dict(entry[0]) if entry is not None else None

    def _prune(self, now: float) -> None:
        self._entries = {key: value for key, value in self._entries.items()
                         if now - value[1] < self._retention}

    def __len__(self) -> int:
        return len(self._entries)


class Launcher(Protocol):
    """Starts one launch and reports what it observed. Never blocks the UI."""

    def start(self, launch: Launch) -> None: ...

    def poll(self) -> Optional[Observation]: ...

    def stop(self) -> None: ...

    @property
    def busy(self) -> bool: ...


class ProcessLauncher:
    """Spawns the launch in its own session so a revoke can stop the whole group,
    with a scrubbed environment and no shell anywhere."""

    def __init__(self, observe_seconds: float = OBSERVE_SECONDS,
                 popen: Callable[..., subprocess.Popen] = subprocess.Popen) -> None:
        self._observe = observe_seconds
        self._popen = popen
        self._lock = threading.Lock()
        self._process: Optional[subprocess.Popen] = None
        self._result: Optional[Observation] = None
        self._running = False
        self._stopping = False

    @property
    def busy(self) -> bool:
        with self._lock:
            return self._running

    def start(self, launch: Launch) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
            self._stopping = False
            self._result = None
        thread = threading.Thread(target=self._work, args=(launch,), name="cosmos-open", daemon=True)
        thread.start()

    def environment(self) -> dict:
        """Only what a desktop launcher needs, so nothing of this session leaks."""
        keep = ("PATH", "HOME", "LANG", "LC_ALL", "USER", "DISPLAY", "WAYLAND_DISPLAY",
                "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS",
                "XAUTHORITY", "HYPRLAND_INSTANCE_SIGNATURE")
        return {name: os.environ[name] for name in keep if name in os.environ}

    def _work(self, launch: Launch) -> None:
        observation = Observation(NOT_STARTED)
        process = None
        try:
            process = self._popen(
                list(launch.argv), start_new_session=True, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=self.environment(),
                close_fds=True,
            )
        except (OSError, ValueError):
            log.warning("the opener could not be started")
        else:
            with self._lock:
                self._process = process
                stopping = self._stopping
            if stopping:
                # A revoke arrived while this was being spawned.
                self._terminate(process)
            try:
                observation = Observation(EXITED, process.wait(timeout=self._observe))
            except subprocess.TimeoutExpired:
                # It is still running. This computer did not see it open anything.
                observation = Observation(UNOBSERVED)
            except OSError:
                observation = Observation(UNOBSERVED)
        with self._lock:
            if self._result is None:
                self._result = observation
            if process is None or observation.kind == EXITED:
                self._process = None
            self._running = False

    def poll(self) -> Optional[Observation]:
        with self._lock:
            result, self._result = self._result, None
            return result

    def stop(self) -> None:
        """Stop the launch if this computer can still reach it, so ``cancelled``
        is a promise it can keep. It does not un-open an application that already
        finished starting; that case is reported as it was observed."""
        with self._lock:
            self._stopping = True
            process = self._process
            if self._running:
                self._result = Observation(STOPPED)
        if process is None:
            return
        self._terminate(process)
        with self._lock:
            if self._process is process:
                self._process = None

    @staticmethod
    def _terminate(process: subprocess.Popen) -> None:
        """The whole process group, politely and then not."""
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except (OSError, ProcessLookupError):
            return
        try:
            process.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
            try:
                process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                log.warning("a launched process did not stop")
