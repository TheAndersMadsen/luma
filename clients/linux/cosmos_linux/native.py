"""ctypes binding to the shared Rust surface client (``cosmos_surface.h``).

The C worker owns the connection; this module sees public configuration,
bounded commands and redacted snapshots. Key material and the journal stay
behind the platform callbacks, which run on the worker thread.
"""
from __future__ import annotations

import ctypes
import os
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Protocol

OK = 0
EMPTY = 1
BUFFER_TOO_SMALL = 2
INVALID_ARGUMENT = -1
QUEUE_FULL = -2
CLOSED = -3
PANIC = -4
UNAVAILABLE = -5
CALLBACK_NOT_FOUND = 1
MAX_CONFIG_BYTES = 2048
MAX_TEXT_BYTES = 4000
MAX_CONTEXT_APP_BYTES = 64
MAX_CONTEXT_BYTES = 8000
MAX_TARGET_BYTES = 16
MAX_JOURNAL_BYTES = 32768
MAX_EVENT_BYTES = 16384
MAX_SPEECH_BYTES = 1_048_576
# The owner's own policy document for this installation, bounded so the whole
# `policy` frame fits the transport envelope.
MAX_POLICY_BYTES = 8192
# Bounded like the macOS bridge: the client never signs more than one transcript.
MAX_SIGN_MESSAGE_BYTES = 2048
# The report a task ends with is bounded UTF-8 JSON; this client never sends
# command output, because it never runs commands.
MAX_REPORT_BYTES = 16 * 1024
MAX_ATTESTATION_BYTES = 64
# The action a report is about, exactly as the snapshot spelled it.
ACTION_ID_BYTES = 36

LIBRARY_NAMES = {
    "linux": "libcosmos_surface_client_ffi.so",
    "darwin": "libcosmos_surface_client_ffi.dylib",
}
ENVIRONMENT_VARIABLE = "COSMOS_SURFACE_LIBRARY"


class NativeError(Exception):
    """A status code the shared client returned instead of OK."""

    def __init__(self, code: int, operation: str) -> None:
        super().__init__(f"{operation} returned native status {code}")
        self.code = code
        self.operation = operation


class PlatformBindings(Protocol):
    """The platform-owned key and protected journal. Called on the worker thread."""

    def public_key_sec1(self) -> bytes: ...

    def sign_sha256(self, message: bytes) -> bytes: ...

    def read_journal(self) -> Optional[bytes]: ...

    def write_journal_atomically(self, journal: bytes) -> None: ...


def library_name() -> str:
    return LIBRARY_NAMES.get(sys.platform, LIBRARY_NAMES["linux"])


def library_candidates() -> list[Path]:
    """Where the shared library may live: an explicit override, then beside the app."""
    candidates: list[Path] = []
    override = os.environ.get(ENVIRONMENT_VARIABLE)
    if override:
        candidates.append(Path(override))
    package = Path(__file__).resolve().parent
    for directory in (package.parent, package):
        for name in dict.fromkeys([library_name(), *LIBRARY_NAMES.values()]):
            candidates.append(directory / name)
    return candidates


def find_library() -> Optional[Path]:
    for candidate in library_candidates():
        if candidate.is_file():
            return candidate
    return None


ReadCallback = ctypes.CFUNCTYPE(
    ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_size_t),
)
SignCallback = ctypes.CFUNCTYPE(
    ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t),
)
WriteCallback = ctypes.CFUNCTYPE(
    ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t,
)


class CosmosSurfaceCallbacks(ctypes.Structure):
    _fields_ = [
        ("context", ctypes.c_void_p),
        ("public_key", ReadCallback),
        ("sign_sha256", SignCallback),
        ("read_journal", ReadCallback),
        ("write_journal_atomically", WriteCallback),
    ]


@dataclass(frozen=True)
class Features:
    """Which of the newer library calls this build offers. A missing call hides the
    matching feature; the plain text call is never substituted for a richer request."""

    targets: bool = False  # cosmos_surface_send_text_to
    context: bool = False  # cosmos_surface_send_text_with_context
    # acknowledge_task + report + grant + device_policy: without all four this
    # build cannot carry a command out honestly — it could not read the owner's
    # permission, and its `report` would be the older call that names no
    # action — so it refuses locally and says so.
    actions: bool = False
    commands: bool = False  # action calls plus bounded progress


_BYTES = ctypes.POINTER(ctypes.c_uint8)
# Resolved by name after load; an older library simply lacks them.
OPTIONAL_SIGNATURES = {
    "cosmos_surface_send_text_to": [ctypes.c_void_p, _BYTES, ctypes.c_size_t, _BYTES, ctypes.c_size_t],
    "cosmos_surface_send_text_with_context": [ctypes.c_void_p, _BYTES, ctypes.c_size_t, _BYTES, ctypes.c_size_t,
                                              _BYTES, ctypes.c_size_t, _BYTES, ctypes.c_size_t],
    "cosmos_surface_acknowledge_task": [ctypes.c_void_p],
    # A report names the action it is about: a task the runtime replaced
    # between this client's read and the worker's queue closes nothing.
    "cosmos_surface_report": [ctypes.c_void_p, _BYTES, ctypes.c_size_t, _BYTES, ctypes.c_size_t],
    "cosmos_surface_grant": [ctypes.c_void_p, ctypes.c_int32, _BYTES, ctypes.c_size_t],
    "cosmos_surface_progress": [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int64],
    "cosmos_surface_device_policy": [ctypes.c_void_p, _BYTES, ctypes.c_size_t,
                                     ctypes.POINTER(ctypes.c_size_t)],
}


class Library:
    """One loaded copy of the shared client. Keep it loaded for the process lifetime."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        handle = ctypes.CDLL(str(self.path))
        surface = ctypes.c_void_p
        signatures = {
            "cosmos_surface_create": [ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t,
                                      ctypes.POINTER(CosmosSurfaceCallbacks), ctypes.POINTER(surface)],
            "cosmos_surface_connect": [surface],
            "cosmos_surface_send_text": [surface, ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t],
            "cosmos_surface_retry_pending": [surface],
            "cosmos_surface_cancel": [surface],
            "cosmos_surface_set_visible": [surface, ctypes.c_int32],
            "cosmos_surface_acknowledge": [surface],
            "cosmos_surface_acknowledge_speech": [surface],
            "cosmos_surface_speech_audio": [surface, ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t,
                                            ctypes.POINTER(ctypes.c_size_t)],
            "cosmos_surface_disconnect": [surface],
            "cosmos_surface_poll": [surface, ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t,
                                    ctypes.POINTER(ctypes.c_size_t)],
            "cosmos_surface_destroy": [surface],
        }
        for name, argtypes in signatures.items():
            function = getattr(handle, name)
            function.argtypes = argtypes
            function.restype = ctypes.c_int32
        self._handle = handle
        actions = [self._bind_optional(name) for name in
                   ("cosmos_surface_acknowledge_task", "cosmos_surface_report", "cosmos_surface_grant",
                    "cosmos_surface_device_policy")]
        self.features = Features(
            targets=self._bind_optional("cosmos_surface_send_text_to"),
            context=self._bind_optional("cosmos_surface_send_text_with_context"),
            actions=all(actions),
            commands=self._bind_optional("cosmos_surface_progress") and all(actions),
        )

    def _bind_optional(self, name: str) -> bool:
        try:
            function = getattr(self._handle, name)
        except AttributeError:
            return False
        function.argtypes = OPTIONAL_SIGNATURES[name]
        function.restype = ctypes.c_int32
        return True

    def __getattr__(self, name: str):
        return getattr(self._handle, name)


def load_library(explicit: Optional[Path] = None) -> Library:
    path = Path(explicit) if explicit else find_library()
    if path is None or not path.is_file():
        searched = ", ".join(str(candidate) for candidate in library_candidates())
        raise FileNotFoundError(
            f"The shared Cosmos client library was not found. Set {ENVIRONMENT_VARIABLE} or place "
            f"{library_name()} beside the app package (searched {searched}).")
    return Library(path)


def _copy_out(data: bytes, output, capacity: int, written) -> int:
    if not written:
        return INVALID_ARGUMENT
    written[0] = 0
    if not output or capacity < len(data):
        return INVALID_ARGUMENT
    ctypes.memmove(output, data, len(data))
    written[0] = len(data)
    return OK


class Surface:
    """One native handle. All methods are called from the application thread;
    the platform bindings are called from the worker thread."""

    def __init__(self, library: Library, config: bytes, platform: PlatformBindings) -> None:
        if not isinstance(config, (bytes, bytearray)) or not config or len(config) > MAX_CONFIG_BYTES:
            raise NativeError(INVALID_ARGUMENT, "create")
        self._library = library
        self._platform = platform
        self._failure_lock = threading.Lock()
        self._failure: Optional[str] = None
        self._handle: Optional[int] = None
        # The C contract copies the callback table but not the trampolines; they
        # must outlive the handle, so they are retained on this object.
        self._callbacks = CosmosSurfaceCallbacks(
            None,
            ReadCallback(self._public_key),
            SignCallback(self._sign),
            ReadCallback(self._read_journal),
            WriteCallback(self._write_journal),
        )
        buffer = (ctypes.c_uint8 * len(config)).from_buffer_copy(bytes(config))
        created = ctypes.c_void_p()
        code = library.cosmos_surface_create(buffer, len(config), ctypes.byref(self._callbacks),
                                             ctypes.byref(created))
        if code != OK or not created.value:
            raise NativeError(code if code != OK else UNAVAILABLE, "create")
        self._handle = created.value

    # -- platform callbacks (worker thread) ---------------------------------

    def _record(self, kind: str) -> None:
        with self._failure_lock:
            self._failure = kind

    def take_callback_failure(self) -> Optional[str]:
        """The last callback failure ("identity" or "storage"), consumed."""
        with self._failure_lock:
            failure, self._failure = self._failure, None
            return failure

    def _public_key(self, _context, output, capacity, written) -> int:
        try:
            key = bytes(self._platform.public_key_sec1())
            if len(key) != 65 or key[0] != 4:
                raise ValueError("public key is not an uncompressed SEC1 point")
            return _copy_out(key, output, capacity, written)
        except Exception:
            self._record("identity")
            return UNAVAILABLE

    def _sign(self, _context, message, length, output, capacity, written) -> int:
        try:
            if written:
                written[0] = 0
            if not message or length <= 0 or length > MAX_SIGN_MESSAGE_BYTES:
                return INVALID_ARGUMENT
            signature = bytes(self._platform.sign_sha256(ctypes.string_at(message, length)))
            if not signature or len(signature) > 72:
                raise ValueError("signature is not bounded DER")
            return _copy_out(signature, output, capacity, written)
        except Exception:
            self._record("identity")
            return UNAVAILABLE

    def _read_journal(self, _context, output, capacity, written) -> int:
        try:
            if written:
                written[0] = 0
            journal = self._platform.read_journal()
            if journal is None:
                return CALLBACK_NOT_FOUND
            journal = bytes(journal)
            if not journal or len(journal) > MAX_JOURNAL_BYTES:
                raise ValueError("journal is empty or oversized")
            return _copy_out(journal, output, capacity, written)
        except Exception:
            self._record("storage")
            return UNAVAILABLE

    def _write_journal(self, _context, journal, length) -> int:
        try:
            if not journal or length <= 0 or length > MAX_JOURNAL_BYTES:
                return INVALID_ARGUMENT
            self._platform.write_journal_atomically(ctypes.string_at(journal, length))
            return OK
        except Exception:
            self._record("storage")
            return UNAVAILABLE

    # -- commands (application thread) --------------------------------------

    @property
    def live(self) -> bool:
        return self._handle is not None

    def _require(self) -> int:
        if self._handle is None:
            raise NativeError(CLOSED, "command")
        return self._handle

    def connect(self) -> int:
        return self._library.cosmos_surface_connect(self._require())

    @property
    def features(self) -> Features:
        return self._library.features

    @staticmethod
    def _encoded(text: str, maximum: int) -> Optional[bytes]:
        encoded = text.encode("utf-8")
        if not encoded or len(encoded) > maximum or "\0" in text or not text.strip():
            return None
        return encoded

    @staticmethod
    def _buffer(encoded: bytes):
        return (ctypes.c_uint8 * len(encoded)).from_buffer_copy(encoded)

    def send_text(self, text: str) -> int:
        encoded = self._encoded(text, MAX_TEXT_BYTES)
        if encoded is None:
            return INVALID_ARGUMENT
        return self._library.cosmos_surface_send_text(self._require(), self._buffer(encoded), len(encoded))

    def send_text_to(self, text: str, target: Optional[str]) -> int:
        """Text with an explicit destination kind; needs the newer library call."""
        handle = self._require()
        if not self.features.targets:
            return UNAVAILABLE
        encoded = self._encoded(text, MAX_TEXT_BYTES)
        if encoded is None:
            return INVALID_ARGUMENT
        destination = (target or "").encode("utf-8")
        if len(destination) > MAX_TARGET_BYTES:
            return INVALID_ARGUMENT
        # An empty target is passed as NULL with length 0: no explicit destination.
        target_buffer = self._buffer(destination) if destination else None
        return self._library.cosmos_surface_send_text_to(handle, self._buffer(encoded), len(encoded),
                                                         target_buffer, len(destination))

    def send_text_with_context(self, text: str, app: str, context: str, target: Optional[str]) -> int:
        """Text with bounded screen text from this installation; needs the newer library call."""
        handle = self._require()
        if not self.features.context:
            return UNAVAILABLE
        encoded = self._encoded(text, MAX_TEXT_BYTES)
        app_bytes = self._encoded(app, MAX_CONTEXT_APP_BYTES)
        context_bytes = self._encoded(context, MAX_CONTEXT_BYTES)
        if encoded is None or app_bytes is None or context_bytes is None:
            return INVALID_ARGUMENT
        destination = (target or "").encode("utf-8")
        if len(destination) > MAX_TARGET_BYTES:
            return INVALID_ARGUMENT
        target_buffer = self._buffer(destination) if destination else None
        return self._library.cosmos_surface_send_text_with_context(
            handle, self._buffer(encoded), len(encoded), self._buffer(app_bytes), len(app_bytes),
            self._buffer(context_bytes), len(context_bytes), target_buffer, len(destination))

    def retry_pending(self) -> int:
        return self._library.cosmos_surface_retry_pending(self._require())

    def cancel(self) -> int:
        return self._library.cosmos_surface_cancel(self._require())

    def set_visible(self, visible: bool) -> int:
        return self._library.cosmos_surface_set_visible(self._require(), 1 if visible else 0)

    def acknowledge(self) -> int:
        return self._library.cosmos_surface_acknowledge(self._require())

    def acknowledge_speech(self) -> int:
        return self._library.cosmos_surface_acknowledge_speech(self._require())

    def acknowledge_task(self) -> int:
        """This installation bound that exact command and it is legal here. It
        is not an outcome and Cosmos records none."""
        handle = self._require()
        if not self.features.actions:
            return UNAVAILABLE
        return self._library.cosmos_surface_acknowledge_task(handle)

    def report(self, action_id: str, report: bytes) -> int:
        """What this computer observed, once per task, about the action it names.

        A report for anything but the current task comes back as ``stale_task``
        and closes nothing: the runtime replaced the command between the
        snapshot this client read and this call, so it is a different command.
        """
        handle = self._require()
        if not self.features.actions:
            return UNAVAILABLE
        if not isinstance(report, (bytes, bytearray)) or not report or len(report) > MAX_REPORT_BYTES:
            return INVALID_ARGUMENT
        action = (action_id or "").encode("utf-8")
        if len(action) != ACTION_ID_BYTES or "\0" in (action_id or ""):
            return INVALID_ARGUMENT
        encoded = bytes(report)
        return self._library.cosmos_surface_report(handle, self._buffer(action), len(action),
                                                   self._buffer(encoded), len(encoded))

    def progress(self, sequence: int, elapsed_ms: int) -> int:
        handle = self._require()
        if not self.features.commands:
            return UNAVAILABLE
        if not 1 <= sequence <= 0xFFFFFFFF or not 0 <= elapsed_ms <= 900_000:
            return INVALID_ARGUMENT
        return self._library.cosmos_surface_progress(handle, sequence, elapsed_ms)

    def grant(self, granted: bool, attestation: Optional[str]) -> int:
        """Answer the ceremony. Granting needs the evidence the request asked
        for; declining carries none."""
        handle = self._require()
        if not self.features.actions:
            return UNAVAILABLE
        encoded = (attestation or "").encode("utf-8")
        if len(encoded) > MAX_ATTESTATION_BYTES or (granted and not encoded):
            return INVALID_ARGUMENT
        buffer = self._buffer(encoded) if encoded else None
        return self._library.cosmos_surface_grant(handle, 1 if granted else 0, buffer, len(encoded))

    def disconnect(self) -> int:
        return self._library.cosmos_surface_disconnect(self._require())

    def poll(self) -> Optional[bytes]:
        """The oldest snapshot, or None when the queue is empty."""
        handle = self._require()
        buffer = (ctypes.c_uint8 * MAX_EVENT_BYTES)()
        written = ctypes.c_size_t(0)
        code = self._library.cosmos_surface_poll(handle, buffer, MAX_EVENT_BYTES, ctypes.byref(written))
        if code == EMPTY:
            return None
        if code != OK or written.value == 0 or written.value > MAX_EVENT_BYTES:
            raise NativeError(code, "poll")
        return ctypes.string_at(buffer, written.value)

    def speech_audio(self, expected_length: int) -> bytes:
        """The current spoken reply's exact bytes; the snapshot's byteLength bounds the copy."""
        handle = self._require()
        if expected_length <= 0 or expected_length > MAX_SPEECH_BYTES:
            raise NativeError(INVALID_ARGUMENT, "speech_audio")
        buffer = (ctypes.c_uint8 * expected_length)()
        written = ctypes.c_size_t(0)
        code = self._library.cosmos_surface_speech_audio(handle, buffer, expected_length, ctypes.byref(written))
        if code != OK or written.value != expected_length:
            raise NativeError(code if code != OK else BUFFER_TOO_SMALL, "speech_audio")
        return ctypes.string_at(buffer, expected_length)

    def device_policy(self, expected_length: int) -> Optional[bytes]:
        """The owner's own policy document for this installation; the snapshot's
        byteLength bounds the copy. None means this installation holds none,
        which is an ordinary state and means it may do nothing at all."""
        handle = self._require()
        if not self.features.actions:
            # A build that cannot read the policy holds none, and holding none
            # is exactly what it should then do.
            return None
        if expected_length <= 0 or expected_length > MAX_POLICY_BYTES:
            raise NativeError(INVALID_ARGUMENT, "device_policy")
        buffer = (ctypes.c_uint8 * expected_length)()
        written = ctypes.c_size_t(0)
        code = self._library.cosmos_surface_device_policy(handle, buffer, expected_length,
                                                          ctypes.byref(written))
        if code == EMPTY:
            return None
        if code != OK or written.value != expected_length:
            raise NativeError(code if code != OK else BUFFER_TOO_SMALL, "device_policy")
        return ctypes.string_at(buffer, expected_length)

    def destroy(self) -> int:
        """Exclusively destroy the handle once; waits for every callback to finish."""
        handle, self._handle = self._handle, None
        if handle is None:
            return OK
        return self._library.cosmos_surface_destroy(handle)


SurfaceFactory = Callable[[bytes, PlatformBindings], Surface]
