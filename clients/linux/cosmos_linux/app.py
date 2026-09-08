"""Qt Quick host for the Omarchy client: one calm window, keyboard first.

The window reports its own visibility to Cosmos (visible and active), plays
spoken replies once, acknowledges cards after they are painted and hides on
Escape. Launching the command again brings the running window back.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import replace
from html import escape
from pathlib import Path
from typing import Callable, Optional

from . import actions
from . import document
from . import context as screen_context
from .attachment import AttachmentError, read_file
from . import strings as S
from . import viewstate
from .controller import CONNECTED_MESSAGE, Controller, Failure, Phase, State
from .endpoint import (
    DEFAULT_SERVER_ORIGIN, InvalidServer, approval_url, canonical_origin, descriptor_json, display_host,
    fingerprint_of_encoded, group_fingerprint,
)
from .events import (
    APPROVAL_PROFILE, PLATFORM, ChoiceItem, Confirmation, CreditPart, Descriptor, Description, DisplayCard,
    PlaceItem, SpeechReply, TurnStatus,
)
from .identity import APP_ID, IdentityError, InstallationStore, default_data_dir, open_identity
from .journal import AlreadyRunning, InstallationLease, JournalStore
from .native import Features, Surface, load_library
from .policy import example_document as example_openers, load_openers, openers_path
from .qr import approval_qr_data_url
from .viewstate import TASK_REFUSED, TASK_WORKING, Line, TaskView

APP_NAME = S.APP_NAME
PACKAGE_DIR = Path(__file__).resolve().parent
POLL_INTERVAL_MS = 200
SCREENSHOT_DELAY_MS = 900
VIEWS = ("setup", "approval", "connected", "empty", "working", "choices", "reconnecting", "task", "refused",
         "ceremony", "ceremony-locked", "document")
CENTER_DEVICES_PATH = "/settings/account/surfaces"
# The kit's graphite palette; the light variant keeps the same roles for a light desktop.
LIGHT_COLORS = {
    "background": "#EEF2F3", "surface": "#FFFFFF", "panel": "#F7FAFA", "accent": "#0E8F8A",
    "response": "#0B5F5C", "primary": "#101A1E", "secondary": "#4C5E65", "border": "#C5D0D4",
    "error": "#A83A24", "success": "#1F7A55",
}
log = logging.getLogger("cosmos.app")


def theme_tokens(dark: bool = True) -> dict:
    """Colour and size tokens for QML: the kit's design-tokens.json, or its light counterpart."""
    with open(PACKAGE_DIR / "assets" / "design-tokens.json", encoding="utf-8") as handle:
        tokens = json.load(handle)
    colors = dict(tokens["colors"]) if dark else dict(LIGHT_COLORS)
    profile = tokens.get("profile", {})
    return {
        **colors,
        "dark": dark,
        "body": int(profile.get("body", 17)),
        "lineHeight": int(profile.get("lineHeight", 25)),
        "controlHeight": int(profile.get("controlHeight", 40)),
        "panelRadius": int(profile.get("panelRadius", 12)),
        "panelPadding": int(profile.get("panelPadding", 22)),
        "nebulaOpacity": float(profile.get("nebulaOpacity", 0.3)),
        "motionMs": 200,
        "maxLineWidth": 620,
    }


def system_prefers_dark() -> bool:
    """The desktop's colour scheme; the kit's dark look when the platform does not say."""
    override = os.environ.get("COSMOS_THEME")
    if override in ("dark", "light"):
        return override == "dark"
    try:
        from PySide6.QtCore import Qt
        from PySide6.QtGui import QGuiApplication
        scheme = QGuiApplication.styleHints().colorScheme()
        return scheme != Qt.ColorScheme.Light
    except Exception:
        return True


def boot_epoch() -> str:
    """The host boot identifier. It fences protocol state, never identity or privacy."""
    linux = Path("/proc/sys/kernel/random/boot_id")
    if linux.exists():
        return str(uuid.UUID(linux.read_text(encoding="ascii").strip()))
    if sys.platform == "darwin":
        result = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], capture_output=True,
                                text=True, check=True)
        return str(uuid.UUID(result.stdout.strip()))
    raise RuntimeError("The operating system boot identifier is unavailable.")


def open_in_browser(link: str) -> bool:
    """xdg-open on Linux, the Qt desktop service elsewhere. HTTPS links only."""
    if not link.startswith("https://"):
        return False
    xdg_open = shutil.which("xdg-open")
    if xdg_open:
        try:
            subprocess.Popen([xdg_open, link], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            return True
        except OSError:
            log.exception("xdg-open failed")
    from PySide6.QtCore import QUrl
    from PySide6.QtGui import QDesktopServices
    return bool(QDesktopServices.openUrl(QUrl(link)))


def activation_socket_name() -> str:
    runtime = os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()
    return os.path.join(runtime, f"cosmos-linux-{os.getuid()}.sock")


def signal_running_instance(name: str) -> bool:
    from PySide6.QtNetwork import QLocalSocket

    socket = QLocalSocket()
    socket.connectToServer(name)
    if not socket.waitForConnected(500):
        return False
    socket.write(b"show\n")
    socket.waitForBytesWritten(500)
    socket.disconnectFromServer()
    return True


class QtScheduler:
    """Single-shot timers on the application thread."""

    def __init__(self) -> None:
        from PySide6.QtCore import QTimer
        self._timer_type = QTimer
        self._active: set = set()

    def call_later(self, delay: float, callback: Callable[[], None]) -> object:
        timer = self._timer_type()
        timer.setSingleShot(True)
        timer.setInterval(max(0, int(delay * 1000)))

        def fire() -> None:
            self._active.discard(timer)
            timer.deleteLater()
            callback()

        timer.timeout.connect(fire)
        self._active.add(timer)
        timer.start()
        return timer

    def cancel(self, handle: object) -> None:
        if handle in self._active:
            self._active.discard(handle)
            handle.stop()
            handle.deleteLater()

    @staticmethod
    def monotonic() -> float:
        return time.monotonic()


def credit_line_html(parts) -> str:
    """Inert credit tokens as styled text: text verbatim, a link as exactly one anchor."""
    pieces = []
    for part in parts:
        if part.kind == "link" and part.href:
            pieces.append(f'<a href="{escape(part.href, quote=True)}">{escape(part.text)}</a>')
        else:
            pieces.append(escape(part.text))
    return "".join(pieces)


def policy_notice(state: State) -> str:
    """What this computer may open, and how it opens it, said once and plainly.

    The permission is Cosmos's and arrives on the connection; the openers file
    is this machine's own and grants nothing. A computer holding no permission
    says so rather than looking ready.
    """
    if state.openers_error is not None:
        return S.OPENERS_INVALID + " " + S.OPENERS_INVALID_REMEDY
    if state.policy_refused:
        return S.POLICY_REFUSED + " " + S.POLICY_REFUSED_REMEDY
    if state.phase == Phase.CONNECTED and not state.policy_held:
        return S.POLICY_NONE + " " + S.POLICY_NONE_REMEDY
    if state.policy_held and not state.openers_loaded:
        return S.OPENERS_MISSING + " " + S.OPENERS_MISSING_REMEDY
    return ""


def window_in_front(*, shown: bool, hidden: bool, exposed: bool) -> bool:
    """This window's own foreground report: on screen, not minimised, and not
    covered or on another workspace.

    Keyboard focus is deliberately not part of it. The report is availability,
    never occupancy or identity, and a card Cosmos held for this computer is
    handed over when it says it is in front — so a window the owner is looking
    at while typing somewhere else must not claim to be gone.
    """
    return shown and not hidden and exposed


def view_for(state: State, has_surface: bool, editing_server: bool) -> str:
    if editing_server or state.descriptor is None or not has_surface:
        return "setup"
    if state.session_seen or state.phase in (Phase.CONNECTING, Phase.CONNECTED, Phase.DISCONNECTING):
        return "connected"
    return "approval"


def preview_state(kind: str) -> State:
    """Synthetic UI state for screenshots and layout work. Never a live connection."""
    descriptor = Descriptor(
        enrollment_id="6f0f4c6a-6d4d-4a1e-9f7c-1d2a3b4c5d6e",
        public_key="BBVfhxmwx6C1s9Vo8Xgk5A4Fn3p8eLzBqcOX5v4kU0XxDGq1wKk3yTr6bMzq3o1bJPRO2s7AYgbQxcEuJ9jUhCA",
        platform=PLATFORM, approval=APPROVAL_PROFILE,
    )
    features = Features(targets=True, context=True)
    if kind == "setup":
        return State()
    if kind == "approval":
        return State(phase=Phase.PREPARED, descriptor=descriptor, wants_connection=True,
                     failure=Failure.APPROVAL_REQUIRED, message=Failure.APPROVAL_REQUIRED.message,
                     reconnect_armed=True)
    if kind == "empty":
        return State(phase=Phase.CONNECTED, descriptor=descriptor, visible=True, message=CONNECTED_MESSAGE,
                     wants_connection=True, session_seen=True, features=features)
    if kind == "reconnecting":
        return State(phase=Phase.PREPARED, descriptor=descriptor, wants_connection=True, reconnect_armed=True,
                     message=S.NOTICE_DROPPED, session_seen=True, features=features,
                     sent_text="Find cafés near me", turn_open=True)
    if kind == "working":
        return State(phase=Phase.CONNECTED, descriptor=descriptor, visible=True, wants_connection=True,
                     session_seen=True, features=features, sent_text="Find cafés near me", sending=True,
                     context=screen_context.ScreenContext(app="Chrome", text="Copenhagen coffee guide"))
    if kind == "document":
        data = ("# A shared workspace\n\n"
                "Keep the document and the conversation together.\n\n"
                "This read-only snapshot keeps the version that was selected.\n"
                "The source file can change without changing this view.\n").encode("utf-8")
        import hashlib
        snapshot = document.from_bytes(data, hashlib.sha256(data).hexdigest(), {"kind": "line", "line": 3})
        return State(phase=Phase.CONNECTED, descriptor=descriptor, visible=True, wants_connection=True,
                     session_seen=True, features=replace(features, actions=True), document=snapshot,
                     task=TaskView("2f1c8a90-4d5e-4a6b-8c7d-9e0f1a2b3c4d", "Workspace notes.md",
                                   viewstate.TASK_DONE), sent_text="Continue with these notes", policy_held=True)
    if kind in ("task", "refused"):
        # A command Cosmos asked this computer to carry out: what is happening,
        # how long it has been happening, and afterwards only what was seen.
        task = (TaskView("2f1c8a90-4d5e-4a6b-8c7d-9e0f1a2b3c4d", "state.rs", TASK_WORKING, elapsed=14)
                if kind == "task"
                else TaskView("2f1c8a90-4d5e-4a6b-8c7d-9e0f1a2b3c4d", "state.rs", TASK_REFUSED,
                              reason="unresolvable"))
        status = TurnStatus(turn_id="1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", generation=4,
                            state="acting" if kind == "task" else "refused", surface_platform=PLATFORM,
                            privacy="private")
        return State(phase=Phase.CONNECTED, descriptor=descriptor, visible=True, wants_connection=True,
                     session_seen=True, features=replace(features, actions=True), task=task, status=status,
                     status_line=viewstate.status_line(status, Line()),
                     sent_text="Continue on my PC", message=S.NOTICE_TASK, policy_held=True,
                     openers_loaded=True)
    if kind in ("ceremony", "ceremony-locked"):
        # The ceremony: the owner's own words for the effect, two equal choices,
        # a visible countdown. Enter confirms, Escape answers nothing.
        description = Description(verb="open", subject="state.rs", device_kind="linux",
                                  effect="opens that document on this computer", privacy_class="private")
        confirmation = Confirmation(
            grant_id="e5aa1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c", action_id="2f1c8a90-4d5e-4a6b-8c7d-9e0f1a2b3c4d",
            turn_id="1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", generation=4, description=description,
            # The preview binds its own words, exactly as a real request must.
            description_digest=actions.confirmation_digest({
                "verb": description.verb, "subject": description.subject,
                "deviceKind": description.device_kind, "effect": description.effect,
                "class": description.privacy_class}),
            risk="moderate", privacy="private", expires_at_ms=30_000,
            # A request needing evidence this desktop cannot produce: confirming
            # is not offered at all, and declining still is.
            attestation="foreground_tap" if kind == "ceremony" else "device_owner_auth",
        )
        return State(phase=Phase.CONNECTED, descriptor=descriptor, visible=True, wants_connection=True,
                     session_seen=True, features=replace(features, actions=True), confirmation=confirmation,
                     ceremony_seconds=21, sent_text="Continue on my PC", message=S.NOTICE_CONFIRM,
                     policy_held=True, openers_loaded=True)
    if kind == "choices":
        choices = DisplayCard(
            action_id="0d3b5f2e-8a4c-4f1a-9b6d-2e7c8a9f0b1c", turn_id="1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
            generation=3, content_digest="a" * 64, expires_at_ms=1, kind="choices", title="Which notes?",
            items=(ChoiceItem("1", "Kitchen renovation", "Updated yesterday"),
                   ChoiceItem("2", "Kitchen shopping list", "12 items"),
                   ChoiceItem("3", "Kitchen garden", "Planted in April")),
        )
        status = TurnStatus(turn_id=choices.turn_id, generation=3, state="waiting", surface_platform=PLATFORM,
                            privacy="shared_room")
        return State(phase=Phase.CONNECTED, descriptor=descriptor, visible=True, display=choices, status=status,
                     status_line=viewstate.status_line(status, Line()), wants_connection=True, session_seen=True,
                     features=features, sent_text="Show my notes about the kitchen")
    card = DisplayCard(
        action_id="0d3b5f2e-8a4c-4f1a-9b6d-2e7c8a9f0b1c", turn_id="1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        generation=3, content_digest="a" * 64, expires_at_ms=1, kind="places", query="Coffee near the office",
        items=(PlaceItem("p1", "Prolog Coffee Bar", "Høkerboderne 16, 1712 København",
                         "https://maps.google.com/?cid=1"),
               PlaceItem("p2", "Andersen & Maillard", "Nørrebrogade 62, 2200 København", None)),
        credits=((CreditPart("text", "Data from "), CreditPart("link", "Google Maps", "https://maps.google.com/")),),
    )
    speech = SpeechReply(
        action_id="7c6b5a49-3827-4c1d-9e0f-a1b2c3d4e5f6", turn_id=card.turn_id, generation=3,
        content_digest="b" * 64, expires_at_ms=1,
        text="There are two well-reviewed coffee bars within a ten-minute walk. Prolog Coffee Bar is the closest.",
        format="audio/mpeg", byte_length=1,
    )
    status = TurnStatus(turn_id=card.turn_id, generation=3, state="shown", surface_platform=PLATFORM,
                        privacy="shared_room")
    return State(phase=Phase.CONNECTED, descriptor=descriptor, visible=True, display=card, speech=speech,
                 speaking=False, message=CONNECTED_MESSAGE, wants_connection=True, session_seen=True,
                 status=status, status_line=viewstate.status_line(status, Line()), features=features,
                 sent_text="Find cafés near me", target="macos")


def make_backend_class():
    """The QObject bridge is defined lazily so the pure modules import without Qt."""
    from PySide6.QtCore import Property, QObject, Signal, Slot

    class Backend(QObject):
        stateChanged = Signal()
        sent = Signal(bool)
        showRequested = Signal()
        quitRequested = Signal()
        hideRequested = Signal()
        # Emitted from the capture thread; the queued connection lands it on the UI thread.
        _captured = Signal(object)

        def __init__(self, controller: Optional[Controller], key_notice: str, reduced_motion: bool,
                     preview: Optional[State] = None, on_reduced_motion: Optional[Callable[[bool], None]] = None,
                     has_screen_context: bool = False, capture: Callable[[], object] = screen_context.capture,
                     parent: Optional[QObject] = None) -> None:
            super().__init__(parent)
            self._controller = controller
            self._key_notice = key_notice
            self._reduced_motion = reduced_motion
            self._on_reduced_motion = on_reduced_motion
            self._preview = preview
            self._has_screen_context = has_screen_context
            self._capture = capture
            self._editing_server = False
            self._qr_link = ""
            self._qr_data = ""
            self._pending_render: Optional[str] = None
            self._pending_document: Optional[tuple] = None
            self._snapshot: dict = {}
            self._captured.connect(self._on_captured)
            if controller is not None:
                controller.subscribe(lambda _state: self._refresh())
                controller.on_sent = self._sent
            self._refresh()

        # -- state for QML --------------------------------------------------

        def _current(self) -> State:
            return self._preview if self._preview is not None else self._controller.state

        def _refresh(self) -> None:
            self._snapshot = self._build()
            self.stateChanged.emit()

        def _build(self) -> dict:
            state = self._current()
            has_surface = self._preview is not None or self._controller.has_surface
            descriptor = state.descriptor
            link = ""
            fingerprint = ""
            descriptor_text = ""
            if descriptor is not None:
                encoded = descriptor_json(descriptor.enrollment_id, descriptor.public_key, descriptor.platform,
                                          descriptor.approval)
                descriptor_text = encoded.decode("utf-8")
                link = approval_url(state.server_origin, encoded)
                try:
                    fingerprint = group_fingerprint(fingerprint_of_encoded(descriptor.public_key))
                except ValueError:
                    fingerprint = ""
            if link != self._qr_link:
                self._qr_link = link
                self._qr_data = approval_qr_data_url(link) if link else ""
            presence = state.presence
            if state.speaking:
                waveform = "speaking"
            elif presence.title == S.WORKING or state.busy or state.phase in (
                    Phase.CONNECTING, Phase.PREPARING, Phase.DISCONNECTING):
                waveform = "thinking"
            elif state.phase == Phase.BLOCKED or presence.title == S.CANNOT_CONFIRM:
                waveform = "error"
            elif presence.title == S.NOT_DONE:
                waveform = "error"
            elif presence.title in (S.WAITING_FOR_YOU, S.WAITING_FOR_DEVICE):
                waveform = "listening"
            else:
                waveform = "idle"
            destination = viewstate.destination_for(state.target)
            context = state.context
            card = viewstate.task_card(state.task)
            ceremony = viewstate.ceremony(state.confirmation if state.ceremony_open else None,
                                          state.ceremony_seconds)
            return {
                "view": view_for(state, has_surface, self._editing_server),
                "phase": state.phase.value,
                "statusText": state.status_text,
                "presenceTitle": presence.title,
                "presenceDetail": presence.detail,
                "sentText": state.sent_text,
                "sending": state.sending,
                "turnOpen": state.turn_open,
                "features": {"targets": state.features.targets, "context": state.features.context,
                             "document": state.features.document and state.features.context},
                "target": state.target or "",
                "destinationChip": destination.chip,
                "destinations": [{"target": entry.target or "", "name": entry.name, "online": entry.online,
                                  "current": entry.target == state.target}
                                 for entry in viewstate.destinations()],
                "context": ({"label": "Using: " + context.label if context.source == "file" and context.label else viewstate.context_label(context.app), "app": context.app,
                             "truncated": context.truncated} if context is not None else None),
                "contextBusy": state.context_busy,
                "hasScreenContext": self._has_screen_context and state.features.context,
                "examplePrompts": list(viewstate.example_prompts(self._has_screen_context and state.features.context)),
                "centerDevicesUrl": state.server_origin + CENTER_DEVICES_PATH,
                "screenContextOff": state.failure == Failure.SCREEN_CONTEXT_OFF,
                "message": state.message,
                "serverOrigin": state.server_origin,
                "serverHost": display_host(state.server_origin),
                "editingServer": self._editing_server,
                "keyNotice": self._key_notice,
                "fingerprint": fingerprint,
                "approvalUrl": link,
                "approvalQr": self._qr_data,
                "descriptorJson": descriptor_text,
                "canPrepare": state.can_prepare,
                "canConnect": state.can_connect,
                "canSend": state.can_send,
                "canCancel": state.can_cancel,
                "canDisconnect": state.can_disconnect,
                "canRetry": state.can_retry_pending,
                "reconnectArmed": state.reconnect_armed,
                "busy": state.busy,
                "visible": state.visible,
                "speaking": state.speaking,
                "connected": state.phase == Phase.CONNECTED,
                "waveformPhase": waveform,
                "hasPending": state.has_pending or state.pending_open,
                "unknownOutcome": state.has_unknown_outcome,
                "display": self._display(state.display),
                "document": ({"actionId": state.task.action_id, "label": state.task.label,
                              "digest": state.document.digest, "text": state.document.text,
                              "line": state.document.line, "cursor": state.document.cursor,
                              "pending": state.task.running}
                             if state.document is not None and state.task is not None else None),
                "task": ({"title": card.title, "detail": card.detail, "remedy": card.remedy,
                          "elapsed": card.elapsed, "cancellable": card.cancellable, "tone": card.tone}
                         if card is not None else None),
                "ceremony": ({"question": ceremony.question, "effect": ceremony.effect, "note": ceremony.note,
                              "countdown": ceremony.countdown, "seconds": ceremony.seconds,
                              "canConfirm": ceremony.can_confirm, "cannotReason": ceremony.cannot_reason}
                             if ceremony is not None else None),
                "canCancelTask": state.can_cancel_task,
                "policyNotice": policy_notice(state),
                "speech": ({"actionId": state.speech.action_id, "text": state.speech.text}
                           if state.speech is not None else None),
                "invitation": state.invitation is not None,
                "reducedMotion": self._reduced_motion,
                "preview": self._preview is not None,
            }

        @staticmethod
        def _display(card: Optional[DisplayCard]) -> Optional[dict]:
            if card is None:
                return None
            if card.kind == "choices":
                items = [{"id": item.id, "title": item.title, "detail": item.detail, "number": index + 1}
                         for index, item in enumerate(card.items)]
            else:
                items = [{"placeId": item.place_id, "name": item.name, "address": item.address,
                          "sourceUrl": item.source_url or ""} for item in card.items]
            return {
                "actionId": card.action_id,
                "kind": card.kind,
                "private": card.private,
                "text": card.text,
                "query": card.query,
                "title": card.title,
                "items": items,
                "creditLines": [credit_line_html(parts) for parts in card.credits],
            }

        @Property("QVariantMap", notify=stateChanged)
        def state(self) -> dict:
            return self._snapshot

        # -- actions from QML -------------------------------------------------

        def _live(self) -> Optional[Controller]:
            return self._controller if self._preview is None else None

        @Slot(str, result=bool)
        def prepare(self, server: str) -> bool:
            controller = self._live()
            if controller is None:
                return False
            try:
                canonical_origin(server)
            except InvalidServer:
                self._refresh()
                return controller.prepare(server)
            self._editing_server = False
            started = controller.prepare(server)
            self._refresh()
            return started

        @Slot()
        def beginServerChange(self) -> None:
            self._editing_server = True
            self._refresh()

        @Slot()
        def cancelServerChange(self) -> None:
            self._editing_server = False
            self._refresh()

        @Slot(result=bool)
        def connect(self) -> bool:
            controller = self._live()
            return controller.connect() if controller is not None else False

        @Slot(str, result=bool)
        def send(self, text: str) -> bool:
            controller = self._live()
            return controller.send(text) if controller is not None else False

        def _sent(self, ok: bool) -> None:
            self.sent.emit(ok)

        @Slot(int, result=bool)
        def selectChoice(self, index: int) -> bool:
            controller = self._live()
            return controller.select_choice(int(index)) if controller is not None else False

        @Slot(str, result=bool)
        def setTarget(self, target: str) -> bool:
            controller = self._live()
            return controller.set_target(target or None) if controller is not None else False

        @Slot(result=bool)
        def useSelection(self) -> bool:
            """Read the selection off the UI thread; attach it only when it holds text."""
            controller = self._live()
            if controller is None or not controller.begin_context_capture():
                return False
            capture = self._capture
            emit = self._captured.emit
            token = controller.capture_token

            def work() -> None:
                try:
                    result = capture()
                except Exception:
                    log.exception("selection capture failed")
                    result = None
                emit((token, result, None))

            threading.Thread(target=work, name="cosmos-selection", daemon=True).start()
            return True

        @Slot(str, result=bool)
        def attachFile(self, url: str) -> bool:
            from PySide6.QtCore import QUrl
            chosen = QUrl(url)
            controller = self._live()
            if (not chosen.isLocalFile() or controller is None
                    or not controller.begin_context_capture(document=True)):
                return False
            token, policy, path = controller.capture_token, controller.policy, chosen.toLocalFile()
            emit = self._captured.emit

            def work() -> None:
                try:
                    result, error = read_file(path, policy), None
                except AttachmentError as problem:
                    result, error = None, str(problem)
                except Exception:
                    result, error = None, "The file could not be attached. Try another saved text file."
                emit((token, result, error))

            threading.Thread(target=work, name="cosmos-file", daemon=True).start()
            return True

        @Slot(object)
        def _on_captured(self, result: object) -> None:
            controller = self._live()
            if controller is not None and isinstance(result, tuple) and len(result) == 3:
                token, context, error = result
                controller.context_captured(context if isinstance(context, screen_context.ScreenContext) else None,
                                            token, error)

        @Slot()
        def dropContext(self) -> None:
            controller = self._live()
            if controller is not None:
                controller.drop_context()

        @Slot(result=bool)
        def openCenterDevices(self) -> bool:
            return open_in_browser(self._snapshot.get("centerDevicesUrl", ""))

        @Slot(result=bool)
        def cancelTask(self) -> bool:
            """Stop the work this computer is doing. Closing the window is not this."""
            live = self._live()
            return bool(live is not None and live.cancel_task())

        @Slot(result=bool)
        def confirmTask(self) -> bool:
            live = self._live()
            return bool(live is not None and live.confirm())

        @Slot(result=bool)
        def declineTask(self) -> bool:
            live = self._live()
            return bool(live is not None and live.decline())

        @Slot(str, result=bool)
        def ceremonyKey(self, name: str) -> bool:
            """One key, one rule: Enter confirms, Escape dismisses without
            answering, everything else does nothing at all."""
            ceremony = viewstate.ceremony(self._current().confirmation, 0)
            decision = viewstate.ceremony_key(name, ceremony is not None and ceremony.can_confirm)
            if decision == viewstate.CONFIRM:
                return self.confirmTask()
            if decision == viewstate.DISMISS:
                return self.dismissCeremony()
            return False

        @Slot(result=bool)
        def dismissCeremony(self) -> bool:
            """Escape hides the ceremony and answers nothing at all."""
            live = self._live()
            return bool(live is not None and live.dismiss_ceremony())

        @Slot(result=bool)
        def cancel(self) -> bool:
            controller = self._live()
            return controller.cancel() if controller is not None else False

        @Slot(result=bool)
        def retryPending(self) -> bool:
            controller = self._live()
            return controller.retry_pending() if controller is not None else False

        @Slot(result=bool)
        def disconnect(self) -> bool:
            controller = self._live()
            return controller.disconnect() if controller is not None else False

        @Slot(result=bool)
        def openApproval(self) -> bool:
            link = self._snapshot.get("approvalUrl", "")
            return open_in_browser(link) if link else False

        @Slot(str, result=bool)
        def openLink(self, link: str) -> bool:
            return open_in_browser(link)

        @Slot(result=bool)
        def copyDescriptor(self) -> bool:
            return self._copy(self._snapshot.get("descriptorJson", ""))

        @Slot(result=bool)
        def copyApprovalLink(self) -> bool:
            return self._copy(self._snapshot.get("approvalUrl", ""))

        @staticmethod
        def _copy(text: str) -> bool:
            if not text:
                return False
            from PySide6.QtGui import QGuiApplication
            clipboard = QGuiApplication.clipboard()
            if clipboard is None:
                return False
            clipboard.setText(text)
            return True

        @Slot(str)
        def cardRendered(self, action_id: str) -> None:
            """The card is composed; it is acknowledged once the next frame is painted."""
            self._pending_render = action_id

        @Slot(str, str, int)
        def documentRendered(self, action_id: str, digest: str, line: int) -> None:
            self._pending_document = (action_id, digest, line)

        @Slot()
        def closeDocument(self) -> None:
            controller = self._live()
            if controller is not None:
                controller.close_document(actions.CANCELLED)

        def frame_painted(self) -> None:
            action_id, self._pending_render = self._pending_render, None
            document, self._pending_document = self._pending_document, None
            controller = self._live()
            if action_id and controller is not None:
                controller.display_committed(action_id)
            if document is not None and controller is not None:
                controller.document_committed(*document)

        @Slot(bool)
        def setReducedMotion(self, value: bool) -> None:
            self._reduced_motion = bool(value)
            if self._on_reduced_motion is not None:
                self._on_reduced_motion(self._reduced_motion)
            self._refresh()

        @Slot()
        def hideWindow(self) -> None:
            self.hideRequested.emit()

        @Slot()
        def quit(self) -> None:
            self.quitRequested.emit()

    return Backend


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="cosmos", description="Cosmos client for the Omarchy desktop.")
    parser.add_argument("--server", help="HTTPS Center origin to prepare against (default: the stored one)")
    parser.add_argument("--data-dir", type=Path, help="installation data directory (default: $XDG_DATA_HOME/cosmos)")
    parser.add_argument("--library", type=Path, help="path to libcosmos_surface_client_ffi")
    parser.add_argument("--no-keyring", action="store_true", help="keep the software key in a file even when a keyring exists")
    parser.add_argument("--reduced-motion", action="store_true", help="disable the waveform animation")
    parser.add_argument("--preview", choices=VIEWS, help="show a synthetic state without a backend")
    parser.add_argument("--screenshot", type=Path, help="save a PNG of the window and exit")
    parser.add_argument("--screenshot-delay", type=int, default=SCREENSHOT_DELAY_MS,
                        help="milliseconds to wait before the screenshot")
    parser.add_argument("--no-auto-prepare", action="store_true", help="wait on the setup view even with a stored installation")
    parser.add_argument("--example-openers", action="store_true",
                        help="print an example openers.json and exit")
    parser.add_argument("--verbose", action="store_true", help="debug logging on stderr")
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    arguments = parse_arguments(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(level=logging.DEBUG if arguments.verbose else logging.INFO,
                        format="%(levelname)s %(name)s: %(message)s")
    if arguments.example_openers:
        # How this desktop opens a document at a line or a page. It allows
        # nothing on its own: what this computer may open is the permission the
        # owner gives it in Center, which Cosmos delivers over the connection.
        data_dir = arguments.data_dir or default_data_dir()
        print(f"# {openers_path(data_dir)}")
        print(example_openers())
        return 0
    os.environ.setdefault("QT_QUICK_CONTROLS_STYLE", "Basic")
    try:
        from PySide6.QtCore import QTimer, QUrl
        from PySide6.QtGui import QGuiApplication, QIcon, QWindow
        from PySide6.QtNetwork import QLocalServer
        from PySide6.QtQml import QQmlApplicationEngine
        from PySide6.QtQuick import QQuickWindow
    except ImportError:
        print("PySide6 is not installed. Create a venv and install requirements.txt.", file=sys.stderr)
        return 2

    application = QGuiApplication(sys.argv[:1])
    application.setApplicationName(APP_NAME)
    application.setApplicationVersion(_version())
    application.setOrganizationName("dk.andersmadsen")
    application.setDesktopFileName(APP_ID)
    application.setWindowIcon(QIcon(str(PACKAGE_DIR / "assets" / "cosmos-logo.png")))
    application.setQuitOnLastWindowClosed(False)

    lease: Optional[InstallationLease] = None
    server: Optional[QLocalServer] = None
    controller: Optional[Controller] = None
    preview: Optional[State] = None
    key_notice = "Preview: no installation identity."
    store: Optional[InstallationStore] = None
    reduced_motion = arguments.reduced_motion or os.environ.get("COSMOS_REDUCED_MOTION") == "1"
    data_dir = arguments.data_dir or default_data_dir()

    if arguments.preview:
        preview = preview_state(arguments.preview)
    else:
        try:
            lease = InstallationLease(data_dir)
        except AlreadyRunning:
            if signal_running_instance(activation_socket_name()):
                print("Cosmos is already running; its window was brought back.", file=sys.stderr)
                return 0
            print("Cosmos is already running for this installation.", file=sys.stderr)
            return 1
        except OSError as error:
            print(f"Cosmos could not open local storage: {error}", file=sys.stderr)
            return 1
        try:
            library = load_library(arguments.library)
            store = InstallationStore(data_dir)
            identity = open_identity(data_dir, store, allow_keyring=not arguments.no_keyring)
            journal = JournalStore(data_dir)
            epoch = boot_epoch()
        except (FileNotFoundError, OSError, IdentityError, RuntimeError, ValueError) as error:
            print(f"Cosmos could not start: {error}", file=sys.stderr)
            lease.release()
            return 1
        key_notice = identity.notice
        if store.get("reducedMotion") == "true":
            reduced_motion = True
        stored_origin = store.get("serverOrigin")
        initial = arguments.server or stored_origin or DEFAULT_SERVER_ORIGIN
        try:
            initial = canonical_origin(initial)
        except InvalidServer:
            initial = DEFAULT_SERVER_ORIGIN
        player_holder: dict = {}
        # How this desktop opens a document. What it may open at all is the
        # owner's permission, and that arrives from Cosmos on the connection.
        openers = load_openers(openers_path(data_dir))
        controller = Controller(
            surface_factory=lambda config, platform: Surface(library, config, platform),
            identity=identity, journal=journal, scheduler=QtScheduler(), player=_player(player_holder),
            boot_epoch=epoch, server_origin=initial,
            persist_server=lambda origin: store.set("serverOrigin", origin),
            openers=openers,
        )
        log.info("installation %s (%s)", identity.enrollment_id, identity.storage)
        if openers.error is not None:
            log.warning("the openers file was not read: %s", openers.error)
        elif not openers.loaded:
            log.info("no openers at %s; documents open with this desktop's own handler",
                     openers_path(data_dir))

    Backend = make_backend_class()
    backend = Backend(controller, key_notice, reduced_motion, preview=preview,
                      on_reduced_motion=(lambda value: store.set("reducedMotion", "true" if value else "false"))
                      if store is not None else None,
                      has_screen_context=screen_context.available() or preview is not None)
    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("backend", backend)
    engine.rootContext().setContextProperty("theme", theme_tokens(system_prefers_dark()))
    engine.rootContext().setContextProperty("S", S.as_map())
    engine.load(QUrl.fromLocalFile(str(PACKAGE_DIR / "qml" / "Main.qml")))
    roots = engine.rootObjects()
    if not roots:
        print("Unable to load the QML interface.", file=sys.stderr)
        return 1
    window = roots[0]
    if not isinstance(window, QQuickWindow):
        print("The QML root is not a window.", file=sys.stderr)
        return 1

    def report_visibility() -> None:
        if controller is None:
            return
        hidden = (QWindow.Visibility.Hidden, QWindow.Visibility.Minimized)
        controller.set_visible(window_in_front(
            shown=window.isVisible(),
            hidden=window.visibility() in hidden,
            exposed=window.isExposed(),
        ))

    window.visibilityChanged.connect(lambda _visibility: report_visibility())
    window.activeChanged.connect(report_visibility)
    window.frameSwapped.connect(backend.frame_painted)

    def show_window() -> None:
        window.show()
        window.raise_()
        window.requestActivate()

    backend.showRequested.connect(show_window)
    backend.hideRequested.connect(window.hide)
    backend.quitRequested.connect(application.quit)

    if controller is not None:
        poller = QTimer()
        poller.setInterval(POLL_INTERVAL_MS)
        poller.timeout.connect(controller.drain)
        # A reply can be bound for this computer while its window is behind
        # something else; Cosmos holds it and hands it over the moment this
        # client says it is in front. No compositor signal covers every way a
        # window is uncovered, so the report is recomputed on the same tick the
        # snapshots are drained on. `set_visible` sends nothing when the answer
        # has not changed.
        poller.timeout.connect(report_visibility)
        poller.start()
        socket_name = activation_socket_name()
        QLocalServer.removeServer(socket_name)
        server = QLocalServer()
        server.newConnection.connect(lambda: _accept_activation(server, show_window))
        if not server.listen(socket_name):
            log.warning("activation socket unavailable: %s", server.errorString())
        if not arguments.no_auto_prepare and (arguments.server or stored_origin):
            controller.prepare(initial)

    def shutdown() -> None:
        if controller is not None:
            controller.set_visible(False)
            controller.shutdown()
        if server is not None:
            server.close()
        if lease is not None:
            lease.release()

    application.aboutToQuit.connect(shutdown)

    if arguments.screenshot:
        def take_screenshot() -> None:
            arguments.screenshot.parent.mkdir(parents=True, exist_ok=True)
            ok = window.grabWindow().save(str(arguments.screenshot), "PNG")
            application.exit(0 if ok else 1)
        QTimer.singleShot(max(0, arguments.screenshot_delay), take_screenshot)

    show_window()
    report_visibility()
    code = application.exec()
    # The engine goes first: its bindings still read the backend during teardown.
    del window
    del engine
    return code


def _player(holder: dict):
    from .playback import QtSpeechPlayer
    holder["player"] = QtSpeechPlayer()
    return holder["player"]


def _accept_activation(server, show_window: Callable[[], None]) -> None:
    while server.hasPendingConnections():
        connection = server.nextPendingConnection()
        if connection is None:
            break
        connection.disconnected.connect(connection.deleteLater)
        show_window()


def _version() -> str:
    from . import __version__
    return __version__
