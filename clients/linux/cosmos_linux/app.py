"""Qt Quick host for the Omarchy client: one calm window, keyboard first.

The window reports its own visibility to Cosmos (visible and active), plays
spoken replies once, acknowledges cards after they are painted and hides on
Escape. Launching the command again brings the running window back.
"""
from __future__ import annotations

import argparse
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from html import escape
from pathlib import Path
from typing import Callable, Optional

from .controller import CONNECTED_MESSAGE, Controller, Failure, Phase, State
from .endpoint import (
    DEFAULT_SERVER_ORIGIN, InvalidServer, approval_url, canonical_origin, descriptor_json, display_host,
    fingerprint_of_encoded, group_fingerprint,
)
from .events import APPROVAL_PROFILE, PLATFORM, CreditPart, Descriptor, DisplayCard, PlaceItem, SpeechReply
from .identity import APP_ID, IdentityError, InstallationStore, default_data_dir, open_identity
from .journal import AlreadyRunning, InstallationLease, JournalStore
from .native import Surface, load_library
from .qr import approval_qr_data_url

APP_NAME = "Cosmos"
PACKAGE_DIR = Path(__file__).resolve().parent
POLL_INTERVAL_MS = 200
SCREENSHOT_DELAY_MS = 900
VIEWS = ("setup", "approval", "connected")
log = logging.getLogger("cosmos.app")


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
    if kind == "setup":
        return State()
    if kind == "approval":
        return State(phase=Phase.PREPARED, descriptor=descriptor, wants_connection=True,
                     failure=Failure.APPROVAL_REQUIRED, message=Failure.APPROVAL_REQUIRED.message,
                     reconnect_armed=True)
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
    return State(phase=Phase.CONNECTED, descriptor=descriptor, visible=True, display=card, speech=speech,
                 speaking=True, message=CONNECTED_MESSAGE, wants_connection=True, session_seen=True)


def make_backend_class():
    """The QObject bridge is defined lazily so the pure modules import without Qt."""
    from PySide6.QtCore import Property, QObject, Signal, Slot

    class Backend(QObject):
        stateChanged = Signal()
        sent = Signal(bool)
        showRequested = Signal()
        quitRequested = Signal()
        hideRequested = Signal()

        def __init__(self, controller: Optional[Controller], key_notice: str, reduced_motion: bool,
                     preview: Optional[State] = None, on_reduced_motion: Optional[Callable[[bool], None]] = None,
                     parent: Optional[QObject] = None) -> None:
            super().__init__(parent)
            self._controller = controller
            self._key_notice = key_notice
            self._reduced_motion = reduced_motion
            self._on_reduced_motion = on_reduced_motion
            self._preview = preview
            self._editing_server = False
            self._qr_link = ""
            self._qr_data = ""
            self._pending_render: Optional[str] = None
            self._snapshot: dict = {}
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
            if state.speaking:
                waveform = "speaking"
            elif state.busy or state.phase in (Phase.CONNECTING, Phase.PREPARING, Phase.DISCONNECTING):
                waveform = "thinking"
            elif state.phase == Phase.BLOCKED:
                waveform = "error"
            else:
                waveform = "idle"
            return {
                "view": view_for(state, has_surface, self._editing_server),
                "phase": state.phase.value,
                "statusText": state.status_text,
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
                "busy": state.busy,
                "visible": state.visible,
                "speaking": state.speaking,
                "connected": state.phase == Phase.CONNECTED,
                "waveformPhase": waveform,
                "hasPending": state.has_pending or state.pending_open,
                "unknownOutcome": state.has_unknown_outcome,
                "display": self._display(state.display),
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
            return {
                "actionId": card.action_id,
                "kind": card.kind,
                "private": card.private,
                "text": card.text,
                "query": card.query,
                "items": [{"placeId": item.place_id, "name": item.name, "address": item.address,
                           "sourceUrl": item.source_url or ""} for item in card.items],
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

        def frame_painted(self) -> None:
            action_id, self._pending_render = self._pending_render, None
            controller = self._live()
            if action_id and controller is not None:
                controller.display_committed(action_id)

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
    parser.add_argument("--verbose", action="store_true", help="debug logging on stderr")
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    arguments = parse_arguments(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(level=logging.DEBUG if arguments.verbose else logging.INFO,
                        format="%(levelname)s %(name)s: %(message)s")
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
        controller = Controller(
            surface_factory=lambda config, platform: Surface(library, config, platform),
            identity=identity, journal=journal, scheduler=QtScheduler(), player=_player(player_holder),
            boot_epoch=epoch, server_origin=initial,
            persist_server=lambda origin: store.set("serverOrigin", origin),
        )
        log.info("installation %s (%s)", identity.enrollment_id, identity.storage)

    Backend = make_backend_class()
    backend = Backend(controller, key_notice, reduced_motion, preview=preview,
                      on_reduced_motion=(lambda value: store.set("reducedMotion", "true" if value else "false"))
                      if store is not None else None)
    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("backend", backend)
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
        controller.set_visible(window.isVisible() and window.visibility() not in hidden and window.isActive())

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
    return application.exec()


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
