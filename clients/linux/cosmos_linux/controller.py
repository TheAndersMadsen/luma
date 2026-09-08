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
import shutil
import time
from collections import deque
from dataclasses import dataclass, replace
from enum import Enum
from typing import Callable, Deque, Optional, Protocol

from . import actions
from .commands import CommandRunner
from .document import Document
from . import strings as S
from .context import ScreenContext
from .endpoint import (
    DEFAULT_SERVER_ORIGIN, InvalidServer, canonical_origin, fingerprint, fingerprint_of_encoded,
    valid_text,
)
from .events import (
    PLATFORM, Admission, Confirmation, Descriptor, DisplayCard, InvalidEvent, Invitation, NativeEvent,
    PolicyRecord, Revoked, SpeechReply, Task, TurnStatus, decode,
)
from .native import (
    INVALID_ARGUMENT, OK, QUEUE_FULL, UNAVAILABLE, Features, NativeError, PlatformBindings, Surface,
)
from .policy import NO_OPENERS, InvalidPolicy, Openers, Policy, parse_policy
from .viewstate import (
    EMPTY_LINE, TARGETS, TASK_DONE, TASK_FAILED, TASK_REFUSED, TASK_STOPPED, TASK_UNKNOWN, TASK_WORKING, Line,
    TaskView, status_line,
)

RECONNECT_DELAYS = (1.5, 3.0, 6.0, 12.0, 30.0)
COMMAND_DEADLINE = 90.0
PREPARE_DEADLINE = 30.0
CREATE_RETRY_DELAY = 0.3
CREATE_RETRY_LIMIT = 30
POLL_BUDGET = 16
INITIAL_MESSAGE = ""
CONNECTED_MESSAGE = S.NOTICE_CONNECTED
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

    INVALID_SERVER = S.FAIL_INVALID_SERVER
    INVALID_TEXT = S.FAIL_INVALID_TEXT
    INVALID_RESPONSE = S.FAIL_INVALID_RESPONSE
    IDENTITY_UNAVAILABLE = S.FAIL_IDENTITY_UNAVAILABLE
    STORAGE_UNAVAILABLE = S.FAIL_STORAGE_UNAVAILABLE
    STORAGE_BLOCKED = S.FAIL_STORAGE_BLOCKED
    APPROVAL_REQUIRED = S.FAIL_APPROVAL_REQUIRED
    CONNECTION_UNAVAILABLE = S.FAIL_CONNECTION_UNAVAILABLE
    UNCERTAIN_REQUEST = S.FAIL_UNCERTAIN_REQUEST
    BUSY = S.FAIL_BUSY
    FEATURE_UNAVAILABLE = S.FAIL_FEATURE_UNAVAILABLE
    SCREEN_CONTEXT_OFF = S.FAIL_SCREEN_CONTEXT_OFF
    ACTIONS_UNAVAILABLE = S.FAIL_ACTIONS_UNAVAILABLE

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
              "no_display", "no_speech", "no_task", "no_confirmation"):
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
    # The runtime's committed status for this installation's own turn, and its words.
    status: Optional[TurnStatus] = None
    status_line: Line = EMPTY_LINE
    # The "Now" line: what was sent, shown the instant it is enqueued.
    sent_text: str = ""
    sending: bool = False
    # True from admission until Cosmos reports the turn finished somewhere.
    turn_open: bool = False
    # The explicit destination for the session (None: this screen) and attached screen text.
    target: Optional[str] = None
    context: Optional[ScreenContext] = None
    context_busy: bool = False
    features: Features = Features()
    # One command this computer was asked to carry out, as it is going here,
    # and the ceremony this computer is the venue for.
    task: Optional[TaskView] = None
    document: Optional[Document] = None
    confirmation: Optional[Confirmation] = None
    # Escape dismisses the panel and answers nothing; the request then runs out.
    ceremony_dismissed: bool = False
    ceremony_seconds: int = 0
    # Whether Cosmos has given this installation permission on this connection.
    # Without one it carries nothing out, which is an ordinary state.
    policy_held: bool = False
    # Set when a delivered document arrived and this client would not act on it.
    policy_refused: bool = False
    # How this desktop opens a file, read from its own openers file.
    openers_loaded: bool = False
    openers_error: Optional[str] = None

    @property
    def presence(self) -> Line:
        """The headline from the state vocabulary and the sentence under it."""
        if self.phase == Phase.BLOCKED:
            return Line(S.DISCONNECTED)
        if self.disconnecting or self.phase == Phase.DISCONNECTING:
            return Line(S.DISCONNECTED, S.DISCONNECTING)
        if self.phase == Phase.PREPARING:
            return Line(S.DISCONNECTED, S.SETTING_UP)
        if self.phase == Phase.CONNECTING:
            return Line(S.DISCONNECTED, S.RECONNECTING if self.session_seen else S.CONNECTING)
        if self.phase != Phase.CONNECTED:
            reconnecting = self.wants_connection and self.reconnect_armed
            return Line(S.DISCONNECTED, S.RECONNECTING if reconnecting else "")
        if self.has_pending:
            return Line(S.CANNOT_CONFIRM, S.NOTICE_PENDING)
        if self.ceremony_open:
            return Line(S.WAITING_FOR_YOU, S.CONFIRM_HERE)
        if self.task is not None and self.task.running:
            return Line(S.WORKING, S.ACTING_HERE)
        if self.sending:
            return Line(S.WORKING)
        if self.speaking:
            return Line(S.WORKING, S.SPEAKING_HERE)
        if self.invitation is not None:
            return Line(S.WAITING_FOR_YOU, S.WAITING_HERE)
        if self.status_line.title:
            return self.status_line
        if self.display is not None:
            return Line(S.COMPLETED)
        if self.turn_open:
            return Line(S.WORKING)
        return Line("", S.CONNECTED)

    @property
    def status_text(self) -> str:
        return self.presence.text

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
        return (not self.busy and not self.context_busy and not self.has_pending and not self.pending_open
                and self.phase == Phase.CONNECTED)

    @property
    def can_cancel(self) -> bool:
        return self.can_send and self.admission is not None

    @property
    def ceremony_open(self) -> bool:
        """A ceremony is on screen only while it has not been dismissed. Closing
        the panel answers nothing at all."""
        return self.confirmation is not None and not self.ceremony_dismissed

    @property
    def can_cancel_task(self) -> bool:
        """Stopping the work this computer is doing. Closing the window is not this."""
        return self.task is not None and self.task.running

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
                 reconnect_delays: tuple = RECONNECT_DELAYS,
                 openers: Optional[Openers] = None,
                 launcher: Optional[actions.Launcher] = None,
                 command_runner: Optional[CommandRunner] = None,
                 which: Callable[[str], Optional[str]] = shutil.which,
                 now_ms: Callable[[], int] = lambda: int(time.time() * 1000)) -> None:
        self._factory = surface_factory
        self._identity = identity
        self._platform = PlatformAdapter(identity, journal)
        self._scheduler = scheduler
        self._player = player
        self._boot_epoch = boot_epoch
        self._persist_server = persist_server
        self._delays = tuple(reconnect_delays)
        self._openers = openers if openers is not None else NO_OPENERS
        # The owner's own permission, as delivered on the connection this
        # installation holds. It is never read from or written to disk.
        self._policy: Optional[Policy] = None
        # The copy this client last decided about, so re-delivery of the same
        # document is idempotent and a refusal is not re-reported every tick.
        self._policy_seen: Optional[tuple] = None
        # The surface and approval revision this connection's policy belongs
        # to, learned from the first copy delivered on it. A later document
        # naming any other is not this connection's and is refused.
        self._policy_binding: Optional[tuple] = None
        self._launcher = launcher if launcher is not None else actions.ProcessLauncher()
        self._runner = command_runner if command_runner is not None else CommandRunner()
        self.capture_token = 0
        self._capture_policy = None
        self._capture_file = False
        self._attached_policy = None
        self._command_action: Optional[str] = None
        self._run_confirmation: Optional[tuple] = None
        self._run_granted = False
        self._progress_sequence = 0
        self._progress_sent = 0.0
        self._which = which
        self._now_ms = now_ms
        self._ledger = actions.Ledger()
        self._task: Optional[Task] = None
        self._task_action: Optional[str] = None
        self._task_launch: Optional[actions.Launch] = None
        self._task_started = 0.0
        self._task_reported = True
        self._grant_id: Optional[str] = None
        self._listeners: list[Callable[[State], None]] = []
        self._state = State(server_origin=server_origin or DEFAULT_SERVER_ORIGIN,
                            openers_loaded=self._openers.loaded, openers_error=self._openers.error)
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
        self._reset_actions()
        self._update(
            phase=Phase.PREPARING, server_origin=origin, descriptor=None, has_pending=False,
            pending_open=False, needs_reconnect=False, can_retry=False, has_unknown_outcome=False,
            admission=None, visible=False, display=None, speech=None, speaking=False, failure=None,
            message="", busy=True, disconnecting=False,
            wants_connection=False, reconnect_armed=False, session_seen=False,
            status=None, status_line=EMPTY_LINE, sent_text="", sending=False, turn_open=False,
            context=None, context_busy=False, task=None, confirmation=None, ceremony_dismissed=False,
            ceremony_seconds=0,
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
        self._update(features=getattr(surface, "features", Features()))
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
        self._update(phase=Phase.CONNECTING, failure=None, message="", wants_connection=True)
        return self._command("connect", self._surface.connect, self._connect_settled)

    def _connect_settled(self, event: NativeEvent, ok: bool) -> None:
        if ok and self._state.phase == Phase.CONNECTED:
            self._reconnect_attempt = 0
            self._update(session_seen=True)
            # Visibility lives on the connection: re-report the retained foreground state.
            if self._wanted_visible and not self._state.visible and self._surface is not None:
                self._defer("set_visible", lambda: self._surface.set_visible(True), replace_same=True)

    def send(self, text: str, target: Optional[str] = None, context: Optional[ScreenContext] = None) -> bool:
        """One request. The session's destination and any attached selection apply unless
        overridden; the plain call stays the default path and richer calls are never narrowed."""
        if not self._state.can_send or self._surface is None:
            return False
        if not valid_text(text):
            self._update(failure=Failure.INVALID_TEXT, message=Failure.INVALID_TEXT.message)
            return False
        target = self._state.target if target is None else target
        context = self._state.context if context is None else context
        features = self._state.features
        surface = self._surface
        operation = "send_text"
        if context is not None:
            if not features.context:
                self._update(failure=Failure.FEATURE_UNAVAILABLE, message=Failure.FEATURE_UNAVAILABLE.message)
                return False
            operation = "send_text_with_context"
            if context.document is not None:
                if not features.document or self._policy is None or self._attached_policy != self._policy_seen:
                    self._update(message="The file attachment is no longer available. Attach it again.")
                    return False
                operation = "send_text_with_document"
                invoke = lambda: surface.send_text_with_context(text, context.app, context.text, target, context.document)
            else:
                invoke = lambda: surface.send_text_with_context(text, context.app, context.text, target)
        elif target is not None:
            if not features.targets:
                self._update(failure=Failure.FEATURE_UNAVAILABLE, message=Failure.FEATURE_UNAVAILABLE.message)
                return False
            invoke = lambda: surface.send_text_to(text, target)
            operation = "send_text_to"
        else:
            invoke = lambda: surface.send_text(text)
        if not self._command(operation, invoke, self._send_settled):
            return False
        # Acknowledged at once: the Now line and "Working" appear before Cosmos answers.
        self._update(sent_text=text, sending=True, status=None, status_line=EMPTY_LINE, turn_open=False,
                     failure=None, message="")
        return True

    def _send_settled(self, event: NativeEvent, ok: bool) -> None:
        admitted = ok and event.admission is not None
        self._update(sending=False, turn_open=admitted, context=None if admitted else self._state.context,
                     sent_text=self._state.sent_text if admitted else "")
        if self.on_sent is not None:
            self.on_sent(admitted)

    def select_choice(self, index: int) -> bool:
        """A numbered option from the current choices card; its title becomes a new turn."""
        card = self._state.display
        if card is None or card.kind != "choices" or not 0 <= index < len(card.items):
            return False
        return self.send(card.items[index].title)

    def set_target(self, target: Optional[str]) -> bool:
        """The explicit destination for this session only. None names none at all, which
        is the default: Cosmos chooses the screen from what the answer is."""
        if target is not None and target not in TARGETS:
            return False
        if target is not None and not self._state.features.targets:
            return False
        self._update(target=target)
        return True

    def begin_context_capture(self, *, document: bool = False) -> bool:
        if self._state.context_busy or not self._state.features.context:
            return False
        if document and (not self._state.features.document or self._state.phase != Phase.CONNECTED
                         or self._policy is None or not self._policy.roots):
            self._update(message="Connect and allow a document folder for this computer in Center first.")
            return False
        self.capture_token += 1
        self._capture_file = document
        self._capture_policy = self._policy_seen
        self._update(context_busy=True, message="")
        return True

    def context_captured(self, context: Optional[ScreenContext], token: Optional[int] = None,
                         error: Optional[str] = None) -> None:
        """The host read the selection (or found none) off the UI thread."""
        if not self._state.context_busy or token is not None and token != self.capture_token:
            return
        if self._capture_file and (self._capture_policy != self._policy_seen or self._policy is None):
            context, error = None, "The file permission changed. Attach it again."
        self._attached_policy = self._capture_policy if context is not None and context.document is not None else None
        self._capture_file = False
        self._update(context_busy=False, context=context,
                     message=error or (S.NO_SELECTION if context is None else self._state.message))

    def drop_context(self) -> None:
        self.capture_token += 1
        self._attached_policy = None
        self._capture_file = False
        if self._state.context is not None or self._state.context_busy:
            self._update(context=None, context_busy=False)

    def cancel(self) -> bool:
        if not self._state.can_cancel or self._surface is None:
            return False
        return self._command("cancel", self._surface.cancel, self._cancel_settled)

    def _cancel_settled(self, event: NativeEvent, ok: bool) -> None:
        if ok:
            self._update(sent_text="", turn_open=False, status_line=EMPTY_LINE)

    def retry_pending(self) -> bool:
        if not self._state.can_retry_pending or self._surface is None:
            return False
        return self._command("retry_pending", self._surface.retry_pending)

    def disconnect(self) -> bool:
        if not self._state.can_disconnect or self._surface is None:
            return False
        self._wants_connection = False
        self._cancel_reconnect()
        self._update(disconnecting=True, phase=Phase.DISCONNECTING, failure=None, message="",
                     wants_connection=False)
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
            message = S.NOTICE_DISCONNECTED if not self._state.has_pending else Failure.UNCERTAIN_REQUEST.message
        self._update(disconnecting=False, phase=phase, message=message, sent_text="", turn_open=False,
                     status=None, status_line=EMPTY_LINE)

    def set_visible(self, visible: bool) -> None:
        """The window's own foreground report: availability only, never occupancy or identity."""
        if self._wanted_visible == visible:
            return
        self._wanted_visible = visible
        if not visible:
            self.close_document()
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

    # -- device actions ------------------------------------------------------

    @property
    def policy(self) -> Optional[Policy]:
        """The owner's own permission for this installation, or None while it
        holds none. It lives only as long as the connection that carried it."""
        return self._policy

    @property
    def openers(self) -> Openers:
        return self._openers

    def _sync_policy(self, event: NativeEvent) -> None:
        """Hold exactly what the owner allowed on this connection, and nothing
        while there is no connection.

        The snapshot names the copy; the bytes are copied out of the library and
        re-verified here against that digest, that surface and that approval
        revision, exactly as against a file. A document this client will not act
        on leaves it holding nothing rather than half a permission.
        """
        record: Optional[PolicyRecord] = event.policy if event.connected else None
        if record is None:
            self._drop_policy(refused=False)
            return
        seen = (record.surface_id, record.approval_revision, record.digest)
        if self._policy_seen == seen or self._surface is None:
            # This exact copy was already decided about; re-delivery is idempotent.
            return
        self.close_document()
        self._stop_command()
        if self._capture_file or self._state.context is not None and self._state.context.document is not None:
            self.drop_context()
        self._policy_seen = seen
        binding = (record.surface_id, record.approval_revision)
        if self._policy_binding is not None and self._policy_binding != binding:
            # A copy for another surface or another approval is not this
            # connection's permission, whatever the snapshot said.
            log.warning("a delivered policy named another surface or approval; nothing is held")
            self._drop_policy(refused=True)
            return
        try:
            raw = self._surface.device_policy(record.byte_length)
        except NativeError:
            log.warning("the delivered policy bytes were not available")
            self._drop_policy(refused=False)
            return
        if raw is None:
            self._drop_policy(refused=False)
            return
        try:
            policy = parse_policy(raw, surface_id=record.surface_id,
                                  approval_revision=record.approval_revision, digest=record.digest)
            if (policy.revision != record.actions_revision or policy.commands_revision != record.commands_revision
                    or len(raw) != record.byte_length):
                raise InvalidPolicy("the policy sections do not match the snapshot revisions")
        except InvalidPolicy as error:
            log.warning("a delivered policy was refused whole: %s", error)
            self._drop_policy(refused=True)
            return
        self._policy = policy
        self._policy_binding = binding
        log.info("holding the owner's policy for this installation (actions %s, commands %s)",
                 policy.revision, policy.commands_revision)
        self._update(policy_held=True, policy_refused=False)

    def _drop_policy(self, refused: bool) -> None:
        """Holding nothing is an ordinary state: this computer then does nothing."""
        self._policy = None
        if self._capture_file or self._state.context is not None and self._state.context.document is not None:
            self.drop_context()
        self._stop_command()
        self.close_document()
        if not refused:
            # A connection that ends takes its copy and its binding with it; a
            # transient read failure is retried on the next snapshot.
            self._policy_seen = None
            self._policy_binding = None
        if self._state.policy_held or self._state.policy_refused != refused:
            self._update(policy_held=False, policy_refused=refused)

    def _begin_task(self, task: Task) -> None:
        """One command, decided entirely here. Acknowledging says it is legal on
        this computer; only what this computer then observes may be reported."""
        self.close_document()
        if self._command_action is not None:
            self._runner.stop()
        # Only the viewer retains transferred bytes. Task metadata and the
        # outcome ledger must not keep another copy after the view is closed.
        self._task = replace(task, document=None)
        self._task_action = task.action_id
        self._task_launch = None
        self._task_reported = False
        self._task_started = self._scheduler.monotonic()
        label = task.label
        if not self._state.features.actions or self._surface is None:
            # Without the library calls this build cannot say what it did, so it
            # does nothing at all and says so here rather than dropping a command.
            self._task_reported = True
            self._update(task=TaskView(task.action_id, label, TASK_REFUSED, reason="no_handler"),
                         failure=Failure.ACTIONS_UNAVAILABLE, message=Failure.ACTIONS_UNAVAILABLE.message)
            return
        retained = self._ledger.recall(task.idempotency_key, self._task_started)
        if retained is not None:
            # A repeat of the same command opens nothing a second time; it
            # re-sends the report this computer already made.
            log.info("a repeated command was answered with its existing report")
            self._acknowledge_task(task)
            self._send_report(task, retained, self._phase_for(retained), label)
            return
        decision = actions.plan(task, self._policy, self._openers, self._which)
        if not decision.bound:
            # Never acknowledge a command this computer will not attempt.
            self._send_report(task, actions.refusal_report(decision.refusal), TASK_REFUSED, label,
                              reason=decision.refusal, unsupported=decision.unsupported)
            return
        if decision.command is not None:
            if (not self._state.features.commands or self._runner.busy
                    or not self._run_authorized(task)):
                self._send_report(task, actions.refusal_report("no_attestation"), TASK_REFUSED, label,
                                  reason="no_attestation")
                return
            binding = self._policy_seen
            self._update(task=TaskView(task.action_id, label, TASK_WORKING, elapsed=0, kind="run"),
                         message=S.NOTICE_TASK, failure=None)

            def acknowledged(_event, ok: bool) -> None:
                if (not ok or self._task_action != task.action_id or self._task_reported
                        or self._policy_seen != binding or not self._run_granted
                        or not self._run_authorized(task)):
                    if self._task_action == task.action_id and not self._task_reported:
                        self._send_report(task, actions.refusal_report("no_attestation"), TASK_REFUSED, label)
                    return
                self._run_confirmation = None
                self._run_granted = False
                if self._runner.start(decision.command):
                    self._command_action = task.action_id
                    self._progress_sequence = 0
                    self._progress_sent = self._task_started = self._scheduler.monotonic()
                else:
                    self._send_report(task, actions.refusal_report("no_handler"), TASK_REFUSED, label)

            self._defer("acknowledge_task", self._surface.acknowledge_task, on_settled=acknowledged,
                        guard=lambda: self._task_action == task.action_id and self._state.phase == Phase.CONNECTED)
            return
        self._task_launch = decision.launch
        self._acknowledge_task(task)
        self._update(task=TaskView(task.action_id, label, TASK_WORKING, elapsed=0),
                     document=decision.document, message=S.NOTICE_TASK, failure=None)
        if decision.launch is not None:
            self._launcher.start(decision.launch)

    def document_committed(self, action_id: str, digest: str, line: int) -> bool:
        """The viewer painted this immutable version with the requested line visible.

        This callback is separate from binding/transport acknowledgment. The
        Qt bridge calls it after a frame swap, only for a matching laid-out view.
        """
        task, document = self._task, self._state.document
        if (task is None or document is None or self._task_reported or self._policy is None
                or task.action_id != action_id or document.digest != digest or document.line != line
                or self._state.phase != Phase.CONNECTED or not self._wanted_visible
                or self._state.ceremony_open
                or not self._state.visible or self._now_ms() >= min(task.expires_at_ms, task.report_by_ms)):
            return False
        report = {"outcome": actions.COMPLETED, "evidence": {
            "kind": "open", "opened": True, "resolvedApp": "dk.andersmadsen.cosmos.linux",
            "documentDigest": document.digest}}
        self._send_report(task, report, TASK_DONE, task.label)
        return True

    def close_document(self, outcome: str = actions.UNKNOWN) -> None:
        """Release the bytes on closure, loss of availability/permission or expiry."""
        if self._state.document is None:
            return
        self._update(document=None)
        if self._task is not None and not self._task_reported:
            report = {"outcome": outcome, "evidence": {"kind": "open", "opened": False}}
            self._send_report(self._task, report, self._phase_for(report), self._task.label)

    def _acknowledge_task(self, task: Task) -> None:
        self._defer("acknowledge_task", self._surface.acknowledge_task,
                    guard=lambda: self._task_action == task.action_id and self._state.phase == Phase.CONNECTED)

    @staticmethod
    def _phase_for(report: dict) -> str:
        return {actions.COMPLETED: TASK_DONE, actions.REFUSED: TASK_REFUSED, actions.FAILED: TASK_FAILED,
                actions.CANCELLED: TASK_STOPPED, actions.UNKNOWN: TASK_UNKNOWN}.get(
                    str(report.get("outcome")), TASK_UNKNOWN)

    def _send_report(self, task: Task, report: dict, phase: str, label: str,
                     reason: Optional[str] = None, unsupported: Optional[str] = None) -> None:
        """Exactly one report per command, and only what this computer saw."""
        self._task_reported = True
        self._task_launch = None
        self._ledger.remember(task.idempotency_key, report, self._scheduler.monotonic())
        elapsed = int(max(0.0, self._scheduler.monotonic() - self._task_started))
        # A positive local observation is reported first. Only the runtime's
        # successful report acknowledgment may turn the card into Completed.
        self._update(task=TaskView(task.action_id, label, TASK_WORKING if phase == TASK_DONE else phase,
                                   elapsed=elapsed, reason=reason,
                                   unsupported=unsupported, kind=task.operation.get("kind", "open"),
                                   exit_code=report.get("evidence", {}).get("exitCode")))
        if self._surface is None:
            return
        payload = actions.report_bytes(report)
        action_id = task.action_id
        def settled(_event, ok: bool) -> None:
            if phase == TASK_DONE and self._task_action == action_id:
                self._update(task=TaskView(action_id, label, TASK_DONE if ok else TASK_UNKNOWN, elapsed=elapsed,
                                          kind=task.operation.get("kind", "open"),
                                          exit_code=report.get("evidence", {}).get("exitCode")))

        def send() -> int:
            try:
                code = self._surface.report(action_id, payload)
            except NativeError:
                settled(None, False)
                raise
            if code != OK:
                settled(None, False)
            return code

        # The report names the action it is about, so a command the runtime
        # replaced between this decision and the worker's queue closes nothing.
        self._defer("report", send, on_settled=settled,
                    guard=lambda: self._task_action == action_id and self._state.phase == Phase.CONNECTED)

    def _collect_launch(self) -> None:
        """What the launcher saw, folded into the one report this command gets."""
        command_report = self._runner.poll()
        if command_report is not None:
            if self._command_action == self._task_action and self._task is not None and not self._task_reported:
                self._send_report(self._task, command_report, self._phase_for(command_report), self._task.label)
            self._command_action = None
        observation = self._launcher.poll()
        task = self._task
        if observation is None or self._task_reported or task is None or self._task_launch is None:
            return
        report = actions.report_for(self._task_launch, observation)
        self._send_report(task, report, self._phase_for(report), task.label)

    def _stop_task(self, reason: str) -> None:
        """The runtime revoked it, or the owner cancelled it. Stop what can be
        stopped; the launcher then says what it saw, and ``cancelled`` is only
        for what this computer can prove."""
        self.close_document(actions.CANCELLED)
        self._stop_command()
        if self._task_action is None or self._task_reported:
            return
        log.info("stopping the running command (%s)", reason)
        self._launcher.stop()

    def cancel_task(self) -> bool:
        """"Cancel task" is explicit and separate from closing the window."""
        if not self._state.can_cancel_task:
            return False
        self._stop_task("cancelled here")
        return True

    def confirm(self) -> bool:
        """Answer the ceremony with what this desktop can actually prove: that
        someone was at this window and pressed the key."""
        confirmation = self._state.confirmation
        if (confirmation is None or self._surface is None or self._state.ceremony_dismissed
                or self._state.phase != Phase.CONNECTED or not self._state.visible
                or not self._wanted_visible or self._now_ms() >= confirmation.expires_at_ms):
            return False
        if confirmation.attestation != "foreground_tap":
            # A keypress here is not device-owner authentication and never
            # stands in for it.
            return False
        binding = self._policy_seen
        self._run_confirmation = (confirmation, binding)
        self._run_granted = False

        def current() -> bool:
            return (self._state.phase == Phase.CONNECTED and self._state.visible and self._wanted_visible
                    and self._state.confirmation == confirmation and self._policy_seen == binding
                    and self._now_ms() < confirmation.expires_at_ms and not self._state.ceremony_dismissed)

        def granted(_event, ok: bool) -> None:
            if self._run_confirmation == (confirmation, binding):
                self._run_granted = ok
                if not ok:
                    self._run_confirmation = None

        self._defer("grant", lambda: self._surface.grant(True, "foreground_tap"),
                    on_settled=granted, guard=current)
        self._update(message=S.NOTICE_TASK)
        return True

    def _run_authorized(self, task: Task) -> bool:
        if (self._run_confirmation is None or self._policy is None or self._state.phase != Phase.CONNECTED
                or not self._state.visible or not self._wanted_visible
                or self._now_ms() >= min(task.expires_at_ms, task.report_by_ms)):
            return False
        ceremony, binding = self._run_confirmation
        return (binding == self._policy_seen and ceremony.action_id == task.action_id
                and ceremony.turn_id == task.turn_id and ceremony.generation == task.generation
                and ceremony.attestation == "foreground_tap" and ceremony.risk == "moderate"
                and self._now_ms() < ceremony.expires_at_ms
                and ceremony.description_digest == actions.confirmation_digest({
                    "verb": "run", "subject": task.label, "deviceKind": "linux",
                    "effect": "does not change files", "class": task.privacy}))

    def _stop_command(self) -> None:
        self._runner.stop()
        self._run_confirmation = None
        self._run_granted = False

    def decline(self) -> bool:
        """Declining is one control away and weighs exactly as much as confirming."""
        if self._state.confirmation is None or self._surface is None:
            return False
        self._run_confirmation = None
        self._run_granted = False
        self._defer("grant", lambda: self._surface.grant(False, None),
                    guard=lambda: self._state.phase == Phase.CONNECTED)
        self._update(message=S.CONFIRM_DECLINED)
        return True

    def dismiss_ceremony(self) -> bool:
        """Escape hides the ceremony and answers nothing; it then runs out on its
        own, which denies by default."""
        if not self._state.ceremony_open:
            return False
        self._run_confirmation = None
        self._run_granted = False
        self._update(ceremony_dismissed=True, message=S.CONFIRM_DISMISSED)
        return True

    def _fold_action(self, event: NativeEvent) -> None:
        """Everything the snapshot says about permission, commands and ceremonies."""
        # The permission first: a command in this same snapshot is verified
        # against the copy this snapshot delivered, never against an older one.
        self._sync_policy(event)
        revoked: Optional[Revoked] = event.revoked
        if revoked is not None and self._task_action == revoked.action_id:
            self._stop_task(revoked.reason)
        task = event.task
        if task is not None and task.action_id != self._task_action:
            self._begin_task(task)
        else:
            self._collect_launch()
        confirmation = event.confirmation
        if confirmation is not None and not self._words_bind(confirmation):
            # The answer must bind to the exact sentence the owner read. If the
            # words and the digest disagree, this computer shows no ceremony at
            # all and the request runs out, which denies by default.
            log.warning("a confirmation's words did not match its digest; it was not shown")
            confirmation = None
        grant = confirmation.grant_id if confirmation is not None else None
        dismissed = self._state.ceremony_dismissed and grant == self._grant_id
        self._grant_id = grant
        seconds = 0
        if confirmation is not None:
            seconds = max(0, (confirmation.expires_at_ms - self._now_ms() + 999) // 1000)
        self._update(confirmation=confirmation, ceremony_dismissed=dismissed, ceremony_seconds=int(seconds))

    @staticmethod
    def _words_bind(confirmation: Confirmation) -> bool:
        """The sentence on screen, hashed the way Cosmos hashed it."""
        description = confirmation.description
        return actions.confirmation_digest({
            "verb": description.verb, "subject": description.subject,
            "deviceKind": description.device_kind, "effect": description.effect,
            "class": description.privacy_class,
        }) == confirmation.description_digest

    def _tick_action(self) -> None:
        """The clocks the cards read: elapsed time and the ceremony countdown."""
        if self._command_action == self._task_action and self._task is not None and not self._task_reported:
            if self._state.phase != Phase.CONNECTED or self._now_ms() >= min(self._task.expires_at_ms, self._task.report_by_ms):
                self._stop_command()
            now = self._scheduler.monotonic()
            if self._runner.busy and self._surface is not None and now - self._progress_sent >= 5:
                self._progress_sequence += 1
                sequence = self._progress_sequence
                elapsed = min(900_000, int((now - self._task_started) * 1000))
                action_id = self._command_action
                self._progress_sent = now
                self._defer("progress", lambda seq=sequence, duration=elapsed: self._surface.progress(seq, duration),
                            guard=lambda: self._command_action == action_id and not self._task_reported
                            and self._state.phase == Phase.CONNECTED)
        if self._state.document is not None and self._task is not None:
            deadline = self._task.expires_at_ms if self._task_reported else min(
                self._task.expires_at_ms, self._task.report_by_ms)
            if self._now_ms() >= deadline or self._state.phase != Phase.CONNECTED:
                self.close_document()
        state = self._state
        changes = {}
        if state.task is not None and state.task.running:
            elapsed = int(max(0.0, self._scheduler.monotonic() - self._task_started))
            if elapsed != state.task.elapsed:
                changes["task"] = replace(state.task, elapsed=elapsed)
        if state.confirmation is not None:
            seconds = max(0, (state.confirmation.expires_at_ms - self._now_ms() + 999) // 1000)
            if int(seconds) != state.ceremony_seconds:
                changes["ceremony_seconds"] = int(seconds)
        if changes:
            self._update(**changes)

    def _reset_actions(self) -> None:
        self.close_document()
        self._stop_command()
        self._command_action = None
        if self._task_action is not None or self._launcher.busy:
            self._launcher.stop()
        # The permission belongs to the connection; without one, nothing is held.
        self._drop_policy(refused=False)
        self._task = None
        self._task_action = None
        self._task_launch = None
        self._task_reported = True
        self._grant_id = None

    def shutdown(self) -> None:
        self._cancel_reconnect()
        if self._create_handle is not None:
            self._scheduler.cancel(self._create_handle)
            self._create_handle = None
        self._wants_connection = False
        self._stop_playback()
        self._reset_actions()
        self._deferred.clear()
        self._expected = None
        self._on_settled = None
        self._destroy_surface()
        self._update(phase=Phase.DISCONNECTED, busy=False, disconnecting=False, wants_connection=False,
                     reconnect_armed=False, visible=False, display=None, speech=None, speaking=False,
                     sending=False, turn_open=False, status=None, status_line=EMPTY_LINE, context_busy=False,
                     confirmation=None, ceremony_dismissed=False, ceremony_seconds=0)

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
            return False
        if self._expected is not None:
            return False
        try:
            code = invoke()
        except NativeError as error:
            code = error.code
        if code != OK:
            log.warning("native %s refused with status %s", name, code)
            if code == QUEUE_FULL:
                failure = Failure.BUSY
            elif name in ("send_text", "send_text_to", "send_text_with_context", "send_text_with_document") and code == UNAVAILABLE:
                failure = Failure.FEATURE_UNAVAILABLE
            elif name in ("send_text", "send_text_to", "send_text_with_context", "send_text_with_document") and code == INVALID_ARGUMENT:
                failure = Failure.INVALID_TEXT
            else:
                failure = Failure.CONNECTION_UNAVAILABLE
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
            self._collect_launch()
            self._tick_action()
            self._check_deadline()
            self._run_deferred()
        self._schedule_reconnect()

    def _blocked(self, failure: Failure) -> None:
        self._expected = None
        self._on_settled = None
        self._update(phase=Phase.BLOCKED, busy=False, failure=failure, message=failure.message)
        self.close_document()
        self._stop_command()

    def _check_deadline(self) -> None:
        if self._expected is None or self._scheduler.monotonic() < self._deadline:
            return
        name = self._expected
        self._expected = None
        self._on_settled = None
        log.warning("native %s did not settle before its deadline", name)
        if (name in ("grant", "acknowledge_task") and self._task is not None
                and self._task.channel == "action.run" and self._command_action is None):
            self._stop_command()
            self._task_reported = True
            self._update(task=replace(self._state.task, phase=TASK_UNKNOWN))
        if name == "report" and self._task_reported and self._state.task is not None and self._state.task.running:
            self._update(task=replace(self._state.task, phase=TASK_UNKNOWN))
        if name == "prepare":
            self._destroy_surface()
            self._update(phase=Phase.DISCONNECTED, busy=False, failure=Failure.CONNECTION_UNAVAILABLE,
                         message=Failure.CONNECTION_UNAVAILABLE.message, disconnecting=False)
            return
        self._update(busy=False, has_pending=True, needs_reconnect=True, can_retry=False,
                     failure=Failure.UNCERTAIN_REQUEST, message=Failure.UNCERTAIN_REQUEST.message,
                     disconnecting=False, sending=False)

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
        if event.error in ("no_task", "no_confirmation", "stale_task"):
            # The runtime withdrew or replaced the command, or the ceremony,
            # before this answer reached it. `stale_task` says this report was
            # about a command that is no longer current, so it closed nothing:
            # it is not a failure of the effect and not a fault in the
            # connection. There is simply nothing left to say.
            failure = None
        storage_blocked = failure in (Failure.STORAGE_BLOCKED, Failure.STORAGE_UNAVAILABLE)
        has_pending = event.pending is not None or event.pending_open or storage_blocked
        if failure == Failure.CONNECTION_UNAVAILABLE and has_pending:
            failure = Failure.UNCERTAIN_REQUEST
        if (failure == Failure.APPROVAL_REQUIRED and event.operation in ("send_text", "send_text_with_context", "send_text_with_document") and event.connected
                and previous.context is not None):
            # An approved installation refused only for its screen text: the permission is off.
            failure = Failure.SCREEN_CONTEXT_OFF
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
            message = S.NOTICE_DROPPED
        else:
            message = self._message_for(event, previous.message)
        if event.operation == "prepare" and event.ok and (event.pending_open or event.needs_reconnect):
            # A retained signed connection means the owner connected on purpose;
            # rejoin it after a relaunch or a dropped room without another click.
            self._wants_connection = True
        line = status_line(event.status, previous.status_line) if event.connected else EMPTY_LINE
        turn_open = previous.turn_open and event.connected and line.title not in (S.COMPLETED, S.CANNOT_CONFIRM)
        if turn_open and event.admission is not None:
            for reply in (event.display, event.speech):
                if reply is not None and reply.turn_id == event.admission.turn_id:
                    turn_open = False
        self._update(
            phase=phase, descriptor=descriptor, has_pending=has_pending, pending_open=event.pending_open,
            needs_reconnect=event.needs_reconnect,
            can_retry=storage_blocked or (event.pending is not None and event.pending.can_retry
                                          and not event.needs_reconnect),
            has_unknown_outcome=event.last_unknown is not None, admission=event.admission,
            visible=event.visible, display=event.display, speech=event.speech,
            speaking=event.speech is not None and self._playing == event.speech.action_id,
            invitation=event.invitation, failure=failure, message=message,
            wants_connection=self._wants_connection, status=event.status, status_line=line, turn_open=turn_open,
        )
        self._fold_action(event)
        if event.operation == self._expected:
            self._settle(event, event.ok and failure is None)
        self._sync_playback(event.speech)

    @staticmethod
    def _message_for(event: NativeEvent, previous: str) -> str:
        """Plain sentences for the notice line; the presence line carries the state itself."""
        if event.operation == "prepare":
            return S.NOTICE_PREPARED
        if event.operation == "connect":
            return CONNECTED_MESSAGE
        if event.operation in ("send_text", "send_text_to", "send_text_with_context", "send_text_with_document"):
            return S.NOTICE_SENT
        if event.operation == "cancel":
            return S.NOTICE_CANCELLED
        if event.operation == "disconnect":
            return S.NOTICE_DISCONNECTED
        if event.operation == "retry_pending":
            return S.NOTICE_RETRIED
        if event.operation == "speech" and event.speech is not None:
            return S.NOTICE_SPEAKING
        if event.operation == "display" and event.display is not None:
            return S.NOTICE_PRIVATE_CARD if event.display.private else S.NOTICE_CARD
        if event.operation == "invitation" and event.invitation is not None:
            return S.NOTICE_TASK_WAITING if event.invitation.is_task else S.NOTICE_INVITATION
        if event.operation == "task" and event.task is not None:
            return S.NOTICE_TASK
        if event.operation == "confirmation" and event.confirmation is not None:
            return S.NOTICE_CONFIRM
        if event.operation == "status" and event.status is not None:
            return ""
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
