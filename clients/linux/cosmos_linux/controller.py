"""The client state machine, mirroring the macOS ClientModel and the Android
SurfaceController.

Everything runs on the application thread. Commands are enqueued on the
native handle and settle only when the poll loop folds the snapshot the
worker emits for them; nothing here ever waits for a command inside that
loop. Playback and card acknowledgments are deferred commands that run once
the current one has settled.
"""
from __future__ import annotations

import json
import logging
from collections import deque
from dataclasses import dataclass, replace
from enum import Enum
from typing import Callable, Deque, Optional, Protocol

from .endpoint import (
    DEFAULT_SERVER_ORIGIN, InvalidServer, canonical_origin, fingerprint, fingerprint_of_encoded,
    valid_text,
)
from .events import (
    PLATFORM, Admission, Descriptor, DisplayCard, InvalidEvent, Invitation, NativeEvent, SpeechReply, decode,
)
from .native import INVALID_ARGUMENT, OK, QUEUE_FULL, NativeError, PlatformBindings, Surface

RECONNECT_DELAYS = (1.5, 3.0, 6.0, 12.0, 30.0)
COMMAND_DEADLINE = 90.0
PREPARE_DEADLINE = 30.0
CREATE_RETRY_DELAY = 0.3
CREATE_RETRY_LIMIT = 30
POLL_BUDGET = 16
INITIAL_MESSAGE = "Prepare this computer, then approve its public descriptor in Center."
CONNECTED_MESSAGE = ("Cosmos confirmed the connection. Cards and spoken replies may arrive here "
                     "while this window is visible.")
log = logging.getLogger("cosmos")


class Phase(str, Enum):
    DISCONNECTED = "disconnected"
    PREPARING = "preparing"
    PREPARED = "prepared"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    DISCONNECTING = "disconnecting"
    BLOCKED = "blocked"


class Failure(str, Enum):
    """Fixed user-facing messages; raw transport or storage errors are never shown."""

    INVALID_SERVER = "Enter an HTTPS server address with no path, credentials, or query."
    INVALID_TEXT = "Enter public text of at most 4,000 UTF-8 bytes."
    INVALID_RESPONSE = "Cosmos returned a response this client could not verify."
    IDENTITY_UNAVAILABLE = ("The installation identity could not be opened. Check the keyring or the key "
                            "file in the Cosmos data directory, or reset the installation to enroll again.")
    STORAGE_UNAVAILABLE = "Protected storage is unavailable. Check the Cosmos data directory and try again."
    STORAGE_BLOCKED = "A protected journal update failed. Retry the pending request before connecting or sending."
    APPROVAL_REQUIRED = "Approve this installation in Center before connecting."
    CONNECTION_UNAVAILABLE = "The Cosmos connection could not be confirmed."
    UNCERTAIN_REQUEST = "The request outcome is unknown. Retry the exact pending request before sending another."
    BUSY = "Wait for the current operation to finish."

    @property
    def message(self) -> str:
        return self.value


BLOCKING_FAILURES = frozenset({
    Failure.IDENTITY_UNAVAILABLE, Failure.INVALID_RESPONSE, Failure.STORAGE_BLOCKED, Failure.STORAGE_UNAVAILABLE,
})
_FAILURES = {
    "pending_operation": Failure.UNCERTAIN_REQUEST, "uncertain": Failure.UNCERTAIN_REQUEST,
    "persistence": Failure.STORAGE_BLOCKED,
    "signing": Failure.IDENTITY_UNAVAILABLE, "invalid_signature": Failure.IDENTITY_UNAVAILABLE,
    "invalid_config": Failure.INVALID_SERVER, "invalid_input": Failure.INVALID_TEXT,
    "invalid_response": Failure.INVALID_RESPONSE, "invalid_journal": Failure.INVALID_RESPONSE,
    "panic": Failure.INVALID_RESPONSE,
    "denied": Failure.APPROVAL_REQUIRED, "busy": Failure.BUSY,
}
for _code in ("no_pending_operation", "disconnected", "expired", "stale", "unavailable", "no_admission",
              "no_display", "no_speech"):
    _FAILURES[_code] = Failure.CONNECTION_UNAVAILABLE


def failure_for(error: Optional[str]) -> Optional[Failure]:
    if error is None:
        return None
    return _FAILURES.get(error, Failure.INVALID_RESPONSE)


@dataclass(frozen=True)
class State:
    """Everything the UI may show. Credentials and journal bytes never enter it."""

    phase: Phase = Phase.DISCONNECTED
    server_origin: str = DEFAULT_SERVER_ORIGIN
    descriptor: Optional[Descriptor] = None
    has_pending: bool = False
    pending_open: bool = False
    needs_reconnect: bool = False
    can_retry: bool = False
    has_unknown_outcome: bool = False
    admission: Optional[Admission] = None
    visible: bool = False
    display: Optional[DisplayCard] = None
    speech: Optional[SpeechReply] = None
    speaking: bool = False
    invitation: Optional[Invitation] = None
    failure: Optional[Failure] = None
    message: str = INITIAL_MESSAGE
    busy: bool = False
    disconnecting: bool = False
    wants_connection: bool = False
    reconnect_armed: bool = False
    session_seen: bool = False

    @property
    def can_prepare(self) -> bool:
        return (not self.busy and not self.has_pending
                and self.phase in (Phase.DISCONNECTED, Phase.PREPARED, Phase.BLOCKED))

    @property
    def can_connect(self) -> bool:
        return (not self.busy and not self.disconnecting and self.descriptor is not None
                and self.failure != Failure.STORAGE_BLOCKED
                and self.phase in (Phase.PREPARED, Phase.DISCONNECTED)
                and (self.needs_reconnect or self.pending_open or not self.has_pending))

    @property
    def can_send(self) -> bool:
        return (not self.busy and not self.has_pending and not self.pending_open
                and self.phase == Phase.CONNECTED)

    @property
    def can_cancel(self) -> bool:
        return self.can_send and self.admission is not None

    @property
    def can_disconnect(self) -> bool:
        return not self.disconnecting and (
            self.phase in (Phase.CONNECTING, Phase.CONNECTED, Phase.BLOCKED) or self.has_pending)

    @property
    def can_retry_pending(self) -> bool:
        return not self.busy and self.can_retry

    @property
    def can_edit_server(self) -> bool:
        return self.can_prepare

    @property
    def status_text(self) -> str:
        if self.disconnecting:
            return "Disconnecting…"
        if self.has_pending:
            return Failure.UNCERTAIN_REQUEST.message
        if self.phase == Phase.DISCONNECTED:
            return "Disconnected"
        if self.phase == Phase.PREPARING:
            return "Opening installation identity…"
        if self.phase == Phase.PREPARED:
            if self.wants_connection and self.failure == Failure.APPROVAL_REQUIRED:
                return "Waiting for approval in Center · retrying automatically"
            if self.wants_connection and self.reconnect_armed:
                return "Reconnecting…"
            return "Installation prepared. Center approval is required."
        if self.phase == Phase.CONNECTING:
            return "Connecting to Cosmos…"
        if self.phase == Phase.CONNECTED:
            if self.speaking:
                return "Connected · speaking"
            return "Connected · visible shared display" if self.visible else "Connected for public text"
        if self.phase == Phase.DISCONNECTING:
            return "Disconnecting…"
        return "Connection stopped. Resolve the reported error before continuing."


class Scheduler(Protocol):
    def call_later(self, delay: float, callback: Callable[[], None]) -> object: ...

    def cancel(self, handle: object) -> None: ...

    def monotonic(self) -> float: ...


class SpeechPlayer(Protocol):
    """Plays one reply's exact bytes; reports completion only when playback reached the end."""

    def play(self, reply: SpeechReply, audio: bytes, on_finished: Callable[[bool], None]) -> bool: ...

    def stop(self) -> None: ...


class IdentityLike(Protocol):
    enrollment_id: object

    def public_key_sec1(self) -> bytes: ...

    def sign_sha256(self, message: bytes) -> bytes: ...


class JournalLike(Protocol):
    def read(self) -> Optional[bytes]: ...

    def write_atomically(self, journal: bytes) -> None: ...


class PlatformAdapter:
    """The platform bindings the worker thread calls: key and journal, nothing else."""

    def __init__(self, identity: IdentityLike, journal: JournalLike) -> None:
        self._identity = identity
        self._journal = journal

    def public_key_sec1(self) -> bytes:
        return self._identity.public_key_sec1()

    def sign_sha256(self, message: bytes) -> bytes:
        return self._identity.sign_sha256(message)

    def read_journal(self) -> Optional[bytes]:
        return self._journal.read()

    def write_journal_atomically(self, journal: bytes) -> None:
        self._journal.write_atomically(journal)


@dataclass
class _Deferred:
    name: str
    invoke: Callable[[], int]
    on_settled: Optional[Callable[[NativeEvent, bool], None]]
    guard: Optional[Callable[[], bool]]


class Controller:
    def __init__(self, *, surface_factory: Callable[[bytes, PlatformBindings], Surface], identity: IdentityLike,
                 journal: JournalLike, scheduler: Scheduler, player: SpeechPlayer, boot_epoch: str,
                 server_origin: Optional[str] = None,
                 persist_server: Optional[Callable[[str], None]] = None,
                 reconnect_delays: tuple = RECONNECT_DELAYS) -> None:
        self._factory = surface_factory
        self._identity = identity
        self._platform = PlatformAdapter(identity, journal)
        self._scheduler = scheduler
        self._player = player
        self._boot_epoch = boot_epoch
        self._persist_server = persist_server
        self._delays = tuple(reconnect_delays)
        self._listeners: list[Callable[[State], None]] = []
        self._state = State(server_origin=server_origin or DEFAULT_SERVER_ORIGIN)
        self._surface: Optional[Surface] = None
        self._expected: Optional[str] = None
        self._deadline = 0.0
        self._on_settled: Optional[Callable[[NativeEvent, bool], None]] = None
        self._deferred: Deque[_Deferred] = deque()
        self._wanted_visible = False
        self._wants_connection = False
        self._reconnect_attempt = 0
        self._reconnect_handle: Optional[object] = None
        self._create_handle: Optional[object] = None
        self._create_attempts = 0
        self._acknowledged: Optional[str] = None
        self._playing: Optional[str] = None
        self._played: Optional[str] = None
        self.on_sent: Optional[Callable[[bool], None]] = None

    # -- observation --------------------------------------------------------

    @property
    def state(self) -> State:
        return self._state

    def subscribe(self, listener: Callable[[State], None]) -> None:
        self._listeners.append(listener)

    def _update(self, **changes) -> None:
        previous = self._state
        self._state = replace(previous, **changes)
        if self._state != previous:
            for listener in list(self._listeners):
                listener(self._state)

    @property
    def has_surface(self) -> bool:
        return self._surface is not None

    # -- lifecycle -----------------------------------------------------------

    def prepare(self, server_text: str) -> bool:
        if not self._state.can_prepare:
            return False
        try:
            origin = canonical_origin(server_text)
        except InvalidServer:
            self._update(failure=Failure.INVALID_SERVER, message=Failure.INVALID_SERVER.message)
            return False
        self._cancel_reconnect()
        self._wants_connection = False
        self._reconnect_attempt = 0
        self._stop_playback()
        self._deferred.clear()
        self._destroy_surface()
        self._acknowledged = None
        self._played = None
        self._update(
            phase=Phase.PREPARING, server_origin=origin, descriptor=None, has_pending=False,
            pending_open=False, needs_reconnect=False, can_retry=False, has_unknown_outcome=False,
            admission=None, visible=False, display=None, speech=None, speaking=False, failure=None,
            message="Opening installation identity…", busy=True, disconnecting=False,
            wants_connection=False, reconnect_armed=False, session_seen=False,
        )
        self._create_attempts = 0
        self._try_create()
        return True

    def _config(self) -> bytes:
        return json.dumps({
            "version": 1, "serverOrigin": self._state.server_origin,
            "enrollmentId": str(self._identity.enrollment_id), "platform": PLATFORM,
            "bootEpoch": self._boot_epoch,
        }, separators=(",", ":")).encode("utf-8")

    def _try_create(self) -> None:
        self._create_handle = None
        try:
            surface = self._factory(self._config(), self._platform)
        except NativeError as error:
            # The native slot is released shortly after destroy; retry that window.
            if error.code == QUEUE_FULL and self._create_attempts < CREATE_RETRY_LIMIT:
                self._create_attempts += 1
                self._create_handle = self._scheduler.call_later(CREATE_RETRY_DELAY, self._try_create)
                return
            failure = {QUEUE_FULL: Failure.BUSY, INVALID_ARGUMENT: Failure.INVALID_SERVER}.get(
                error.code, Failure.CONNECTION_UNAVAILABLE)
            self._update(phase=Phase.DISCONNECTED, busy=False, failure=failure, message=failure.message)
            return
        except Exception:
            log.exception("native create failed")
            self._update(phase=Phase.BLOCKED, busy=False, failure=Failure.CONNECTION_UNAVAILABLE,
                         message=Failure.CONNECTION_UNAVAILABLE.message)
            return
        self._surface = surface
        self._await("prepare", PREPARE_DEADLINE, self._prepare_settled)

    def _prepare_settled(self, event: NativeEvent, ok: bool) -> None:
        if not ok:
            return
        if self._persist_server is not None:
            try:
                self._persist_server(self._state.server_origin)
            except Exception:
                log.exception("server origin was not persisted")
        if self._wanted_visible:
            self._defer("set_visible", lambda: self._surface.set_visible(True), replace_same=True)

    def connect(self) -> bool:
        if not self._state.can_connect or self._surface is None:
            return False
        self._wants_connection = True
        self._reconnect_attempt = 0
        self._cancel_reconnect()
        self._update(phase=Phase.CONNECTING, failure=None, message="Connecting to Cosmos…",
                     wants_connection=True)
        return self._command("connect", self._surface.connect, self._connect_settled)

    def _connect_settled(self, event: NativeEvent, ok: bool) -> None:
        if ok and self._state.phase == Phase.CONNECTED:
            self._reconnect_attempt = 0
            self._update(session_seen=True)
            # Visibility lives on the connection: re-report the retained foreground state.
            if self._wanted_visible and not self._state.visible and self._surface is not None:
                self._defer("set_visible", lambda: self._surface.set_visible(True), replace_same=True)

    def send(self, text: str) -> bool:
        if not self._state.can_send or self._surface is None:
            return False
        if not valid_text(text):
            self._update(failure=Failure.INVALID_TEXT, message=Failure.INVALID_TEXT.message)
            return False
        return self._command("send_text", lambda: self._surface.send_text(text), self._send_settled)

    def _send_settled(self, event: NativeEvent, ok: bool) -> None:
        if self.on_sent is not None:
            self.on_sent(ok and event.admission is not None)

    def cancel(self) -> bool:
        if not self._state.can_cancel or self._surface is None:
            return False
        return self._command("cancel", self._surface.cancel)

    def retry_pending(self) -> bool:
        if not self._state.can_retry_pending or self._surface is None:
            return False
        return self._command("retry_pending", self._surface.retry_pending)

    def disconnect(self) -> bool:
        if not self._state.can_disconnect or self._surface is None:
            return False
        self._wants_connection = False
        self._cancel_reconnect()
        self._update(disconnecting=True, phase=Phase.DISCONNECTING, failure=None,
                     message="Disconnecting the native session…", wants_connection=False)
        if self._expected is not None:
            # A running command settles first; the explicit disconnect follows it.
            self._deferred.appendleft(_Deferred("disconnect", self._surface.disconnect,
                                                self._disconnect_settled, None))
            return True
        return self._command("disconnect", self._surface.disconnect, self._disconnect_settled)

    def _disconnect_settled(self, event: NativeEvent, ok: bool) -> None:
        phase = self._state.phase if self._state.phase != Phase.DISCONNECTING else (
            Phase.PREPARED if self._state.descriptor else Phase.DISCONNECTED)
        message = self._state.message
        if ok and self._state.failure is None:
            message = ("Session disconnected. Owner approval remains in Center."
                       if not self._state.has_pending else Failure.UNCERTAIN_REQUEST.message)
        self._update(disconnecting=False, phase=phase, message=message)

    def set_visible(self, visible: bool) -> None:
        """The window's own foreground report: availability only, never occupancy or identity."""
        if self._wanted_visible == visible:
            return
        self._wanted_visible = visible
        if self._surface is None or self._state.descriptor is None:
            return
        self._defer("set_visible", lambda: self._surface.set_visible(visible), replace_same=True)

    def display_committed(self, action_id: str) -> None:
        """Call only after the complete card, credits included, is on screen."""
        card = self._state.display
        if card is None or card.action_id != action_id or self._acknowledged == action_id or self._surface is None:
            return
        self._acknowledged = action_id
        self._defer("acknowledge", self._surface.acknowledge,
                    guard=lambda: self._current_display(action_id) and self._state.phase == Phase.CONNECTED)

    def _current_display(self, action_id: str) -> bool:
        return self._state.display is not None and self._state.display.action_id == action_id

    def shutdown(self) -> None:
        self._cancel_reconnect()
        if self._create_handle is not None:
            self._scheduler.cancel(self._create_handle)
            self._create_handle = None
        self._wants_connection = False
        self._stop_playback()
        self._deferred.clear()
        self._expected = None
        self._on_settled = None
        self._destroy_surface()
        self._update(phase=Phase.DISCONNECTED, busy=False, disconnecting=False, wants_connection=False,
                     reconnect_armed=False, visible=False, display=None, speech=None, speaking=False)

    def _destroy_surface(self) -> None:
        surface, self._surface = self._surface, None
        if surface is not None:
            # Blocks until every key and journal callback has finished (bounded disconnect).
            surface.destroy()

    # -- commands ------------------------------------------------------------

    def _await(self, name: str, deadline: float, on_settled: Optional[Callable] = None) -> None:
        self._expected = name
        self._deadline = self._scheduler.monotonic() + deadline
        self._on_settled = on_settled
        self._update(busy=True)

    def _command(self, name: str, invoke: Callable[[], int],
                 on_settled: Optional[Callable[[NativeEvent, bool], None]] = None) -> bool:
        if self._surface is None:
            self._update(message="Prepare this computer first.")
            return False
        if self._expected is not None:
            return False
        try:
            code = invoke()
        except NativeError as error:
            code = error.code
        if code != OK:
            log.warning("native %s refused with status %s", name, code)
            failure = Failure.BUSY if code == QUEUE_FULL else Failure.CONNECTION_UNAVAILABLE
            self._update(failure=failure, message=failure.message)
            return False
        self._await(name, COMMAND_DEADLINE, on_settled)
        return True

    def _defer(self, name: str, invoke: Callable[[], int], on_settled: Optional[Callable] = None,
               guard: Optional[Callable[[], bool]] = None, replace_same: bool = False) -> None:
        if replace_same:
            self._deferred = deque(entry for entry in self._deferred if entry.name != name)
        self._deferred.append(_Deferred(name, invoke, on_settled, guard))

    def _run_deferred(self) -> None:
        while self._deferred and self._expected is None and self._surface is not None:
            entry = self._deferred.popleft()
            if entry.guard is not None and not entry.guard():
                continue
            self._command(entry.name, entry.invoke, entry.on_settled)

    # -- polling -------------------------------------------------------------

    def drain(self) -> None:
        """One poll tick: fold queued snapshots, run deferred commands, arm reconnection."""
        if self._surface is not None:
            for _ in range(POLL_BUDGET):
                try:
                    raw = self._surface.poll()
                except NativeError:
                    self._blocked(Failure.INVALID_RESPONSE)
                    break
                if raw is None:
                    break
                try:
                    event = decode(raw)
                except InvalidEvent as error:
                    log.warning("undecodable snapshot: %s", error)
                    self._blocked(Failure.INVALID_RESPONSE)
                    break
                self._fold(event)
            self._check_deadline()
            self._run_deferred()
        self._schedule_reconnect()

    def _blocked(self, failure: Failure) -> None:
        self._expected = None
        self._on_settled = None
        self._update(phase=Phase.BLOCKED, busy=False, failure=failure, message=failure.message)

    def _check_deadline(self) -> None:
        if self._expected is None or self._scheduler.monotonic() < self._deadline:
            return
        name = self._expected
        self._expected = None
        self._on_settled = None
        log.warning("native %s did not settle before its deadline", name)
        if name == "prepare":
            self._destroy_surface()
            self._update(phase=Phase.DISCONNECTED, busy=False, failure=Failure.CONNECTION_UNAVAILABLE,
                         message=Failure.CONNECTION_UNAVAILABLE.message, disconnecting=False)
            return
        self._update(busy=False, has_pending=True, needs_reconnect=True, can_retry=False,
                     failure=Failure.UNCERTAIN_REQUEST, message=Failure.UNCERTAIN_REQUEST.message,
                     disconnecting=False)

    def _descriptor_matches(self, descriptor: Descriptor) -> bool:
        try:
            return (descriptor.enrollment_id == str(self._identity.enrollment_id)
                    and fingerprint_of_encoded(descriptor.public_key)
                    == fingerprint(self._identity.public_key_sec1()))
        except (ValueError, TypeError):
            return False

    def _fold(self, event: NativeEvent) -> None:
        previous = self._state
        log.debug("snapshot %s %s connected=%s visible=%s", event.operation,
                  "ok" if event.ok else event.error, event.connected, event.visible)
        failure = failure_for(event.error)
        if failure is None and event.operation in ("display", "speech") and not event.connected:
            # Watcher snapshots while disconnected carry no verdict; keep the last one.
            failure = previous.failure
        if failure is not None and event.error is not None and self._surface is not None:
            callback = self._surface.take_callback_failure()
            if callback == "identity":
                failure = Failure.IDENTITY_UNAVAILABLE
            elif callback == "storage":
                failure = Failure.STORAGE_BLOCKED if event.error == "persistence" else Failure.STORAGE_UNAVAILABLE
        storage_blocked = failure in (Failure.STORAGE_BLOCKED, Failure.STORAGE_UNAVAILABLE)
        has_pending = event.pending is not None or event.pending_open or storage_blocked
        if failure == Failure.CONNECTION_UNAVAILABLE and has_pending:
            failure = Failure.UNCERTAIN_REQUEST
        descriptor = previous.descriptor
        if event.descriptor is not None:
            if self._descriptor_matches(event.descriptor):
                descriptor = event.descriptor
            else:
                failure = Failure.INVALID_RESPONSE
        if event.connected:
            phase = Phase.CONNECTED
        elif event.operation == "prepare" and event.ok:
            phase = Phase.PREPARED
        elif descriptor is not None:
            phase = Phase.PREPARED
        else:
            phase = Phase.DISCONNECTED
        if failure in BLOCKING_FAILURES:
            phase = Phase.BLOCKED
        elif previous.disconnecting and event.operation != "disconnect":
            phase = Phase.DISCONNECTING
        elif self._expected == "connect" and event.operation != "connect" and not event.connected:
            phase = Phase.CONNECTING
        dropped = (previous.phase == Phase.CONNECTED and phase != Phase.CONNECTED
                   and self._wants_connection and event.operation not in ("disconnect", "connect"))
        if failure is not None:
            message = failure.message
        elif dropped:
            message = "The Cosmos connection dropped. Reconnecting…"
        else:
            message = self._message_for(event, previous.message)
        if event.operation == "prepare" and event.ok and (event.pending_open or event.needs_reconnect):
            # A retained signed connection means the owner connected on purpose;
            # rejoin it after a relaunch or a dropped room without another click.
            self._wants_connection = True
        self._update(
            phase=phase, descriptor=descriptor, has_pending=has_pending, pending_open=event.pending_open,
            needs_reconnect=event.needs_reconnect,
            can_retry=storage_blocked or (event.pending is not None and event.pending.can_retry
                                          and not event.needs_reconnect),
            has_unknown_outcome=event.last_unknown is not None, admission=event.admission,
            visible=event.visible, display=event.display, speech=event.speech,
            speaking=event.speech is not None and self._playing == event.speech.action_id,
            invitation=event.invitation, failure=failure, message=message,
            wants_connection=self._wants_connection,
        )
        if event.operation == self._expected:
            self._settle(event, event.ok and failure is None)
        self._sync_playback(event.speech)

    @staticmethod
    def _message_for(event: NativeEvent, previous: str) -> str:
        if event.operation == "prepare":
            return "Approve this public descriptor in Center, then connect."
        if event.operation == "connect":
            return CONNECTED_MESSAGE
        if event.operation == "send_text":
            return "Request admitted by Cosmos. The response appears on the approved display it selects."
        if event.operation == "cancel":
            return "Cancellation admitted by Cosmos."
        if event.operation == "disconnect":
            return "Session disconnected. Owner approval remains in Center."
        if event.operation == "retry_pending":
            return "Cosmos confirmed the pending operation with its exact request."
        if event.operation == "speech" and event.speech is not None:
            return "Cosmos is speaking the reply on this computer."
        if event.operation == "display" and event.display is not None:
            if event.display.private:
                return "Cosmos delivered a private card to this window. It stays only while this window is in front."
            return "Cosmos delivered a card to this window."
        if event.operation == "invitation" and event.invitation is not None:
            return "A private reply is waiting for this computer. Keep this window in front to receive it."
        return previous

    def _settle(self, event: NativeEvent, ok: bool) -> None:
        callback = self._on_settled
        self._expected = None
        self._on_settled = None
        self._deadline = 0.0
        self._update(busy=False)
        if callback is not None:
            callback(event, ok)

    # -- reconnection --------------------------------------------------------

    def _schedule_reconnect(self) -> None:
        """A dropped room is rejoined without a click: bounded backoff, only while the
        installation was connected on purpose and never over a pending or blocked operation."""
        if self._reconnect_handle is not None or self._surface is None:
            return
        state = self._state
        eligible = (self._wants_connection and not state.busy and state.descriptor is not None
                    and state.phase in (Phase.PREPARED, Phase.DISCONNECTED) and not state.has_pending
                    and not state.disconnecting)
        if not eligible:
            if state.reconnect_armed:
                self._update(reconnect_armed=False)
            return
        delay = self._delays[min(self._reconnect_attempt, len(self._delays) - 1)]
        self._reconnect_attempt = min(self._reconnect_attempt + 1, len(self._delays))
        log.debug("automatic reconnect in %.1fs (attempt %d)", delay, self._reconnect_attempt)
        self._reconnect_handle = self._scheduler.call_later(delay, self._reconnect_fire)
        self._update(reconnect_armed=True, wants_connection=True)

    def _reconnect_fire(self) -> None:
        self._reconnect_handle = None
        self._update(reconnect_armed=False)
        if not self._wants_connection or not self._state.can_connect or self._surface is None:
            return
        self._update(phase=Phase.CONNECTING)
        self._command("connect", self._surface.connect, self._connect_settled)

    def _cancel_reconnect(self) -> None:
        if self._reconnect_handle is not None:
            self._scheduler.cancel(self._reconnect_handle)
            self._reconnect_handle = None
        if self._state.reconnect_armed:
            self._update(reconnect_armed=False)

    # -- speech --------------------------------------------------------------

    def _sync_playback(self, speech: Optional[SpeechReply]) -> None:
        """Plays each delivered reply exactly once and acknowledges only complete playback.
        A retired or replaced reply stops immediately and is never acknowledged."""
        if self._playing is not None and (speech is None or speech.action_id != self._playing):
            self._stop_playback()
        if speech is None or speech.action_id in (self._playing, self._played) or self._surface is None:
            return
        try:
            audio = self._surface.speech_audio(speech.byte_length)
        except NativeError:
            log.warning("speech bytes were not available")
            return
        if len(audio) != speech.byte_length:
            log.warning("speech bytes did not match the snapshot")
            return
        reply = speech
        started = self._player.play(reply, audio, lambda completed: self.playback_finished(reply, completed))
        if started:
            self._playing = reply.action_id
            self._update(speaking=True)

    def playback_finished(self, reply: SpeechReply, completed: bool) -> None:
        if self._playing != reply.action_id:
            return
        self._playing = None
        self._update(speaking=False)
        current = self._state.speech
        if not completed or current is None or current.action_id != reply.action_id or self._surface is None:
            return
        self._played = reply.action_id
        self._defer("acknowledge_speech", self._surface.acknowledge_speech,
                    guard=lambda: (self._state.speech is not None
                                   and self._state.speech.action_id == reply.action_id
                                   and self._state.phase == Phase.CONNECTED))

    def _stop_playback(self) -> None:
        if self._playing is None:
            return
        self._playing = None
        self._player.stop()
        self._update(speaking=False)
