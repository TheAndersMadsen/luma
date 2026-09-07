"""ctypes smoke test against the shared client library when one is built.

The CLI builds libcosmos_surface_client_ffi into the external Cargo target
directory (``client check macos`` / ``client build macos``); this test finds it
through COSMOS_SURFACE_LIBRARY, REVIVAL_BUILD_DIR or the default build path and
is skipped otherwise. Preparing never contacts the server, and it needs only a
valid public point, so the test carries the P-256 generator instead of a real
signing key.
"""
import json
import os
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from cosmos_linux import native
from cosmos_linux.endpoint import fingerprint, fingerprint_of_encoded
from cosmos_linux.events import APPROVAL_PROFILE, decode

# The P-256 base point in uncompressed SEC1 form: a valid public key with no private half here.
GENERATOR_SEC1 = bytes.fromhex(
    "04"
    "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"
    "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"
)


def library_path():
    explicit = os.environ.get(native.ENVIRONMENT_VARIABLE)
    candidates = [Path(explicit)] if explicit else []
    build = Path(os.environ.get("REVIVAL_BUILD_DIR") or Path.home() / ".local/share/ai-pin-revival/build")
    for name in dict.fromkeys([native.library_name(), *native.LIBRARY_NAMES.values()]):
        candidates.append(build / "cosmos-target" / "debug" / name)
        candidates.append(build / "cosmos-target" / "release" / name)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


LIBRARY = library_path()


class FakeFunction:
    """A C entry point the fake library exports; records every call."""

    def __init__(self, name, calls, result=native.OK):
        self.name = name
        self.calls = calls
        self.result = result
        self.argtypes = None
        self.restype = None

    def __call__(self, *arguments):
        self.calls.append((self.name, arguments))
        if self.name == "cosmos_surface_create":
            arguments[3]._obj.value = 0x1234
        return self.result


class FakeHandle:
    """What ctypes.CDLL hands back: only the exported names resolve."""

    REQUIRED = (
        "cosmos_surface_create", "cosmos_surface_connect", "cosmos_surface_send_text", "cosmos_surface_retry_pending",
        "cosmos_surface_cancel", "cosmos_surface_set_visible", "cosmos_surface_acknowledge",
        "cosmos_surface_acknowledge_speech", "cosmos_surface_speech_audio", "cosmos_surface_disconnect",
        "cosmos_surface_poll", "cosmos_surface_destroy",
    )

    def __init__(self, optional=()):
        self.calls = []
        self.exported = set(self.REQUIRED) | set(optional)
        self.functions = {}

    def __getattr__(self, name):
        if name.startswith("_") or name not in self.exported:
            raise AttributeError(name)
        if name not in self.functions:
            self.functions[name] = FakeFunction(name, self.calls)
        return self.functions[name]


class NullBindings:
    def public_key_sec1(self):
        return GENERATOR_SEC1

    def sign_sha256(self, message):
        return b"\x30\x06\x02\x01\x01\x02\x01\x01"

    def read_journal(self):
        return None

    def write_journal_atomically(self, data):
        pass


class OptionalSymbolTest(unittest.TestCase):
    """The newer calls are resolved by name; a library without them hides the feature
    and the plain call is never substituted."""

    def load(self, optional):
        handle = FakeHandle(optional)
        original = native.ctypes.CDLL
        native.ctypes.CDLL = lambda path: handle
        try:
            library = native.load_library(Path(__file__))
        finally:
            native.ctypes.CDLL = original
        return handle, library

    @staticmethod
    def argument_bytes(arguments, index):
        buffer, length = arguments[index], arguments[index + 1]
        return bytes(buffer)[:length] if buffer is not None else None

    def test_older_library_reports_no_features_and_refuses_the_richer_calls(self):
        handle, library = self.load(())
        self.assertEqual(library.features, native.Features(targets=False, context=False))
        surface = native.Surface(library, b'{"version":1}', NullBindings())
        self.assertEqual(surface.send_text_to("hello", "macos"), native.UNAVAILABLE)
        self.assertEqual(surface.send_text_with_context("hello", "Mail", "body", None), native.UNAVAILABLE)
        self.assertEqual([name for name, _ in handle.calls], ["cosmos_surface_create"])
        self.assertEqual(surface.send_text("hello"), native.OK)
        self.assertEqual(handle.calls[-1][0], "cosmos_surface_send_text")
        self.assertEqual(self.argument_bytes(handle.calls[-1][1], 1), b"hello")
        surface.destroy()

    def test_newer_library_binds_send_text_to_and_with_context(self):
        handle, library = self.load(("cosmos_surface_send_text_to", "cosmos_surface_send_text_with_context"))
        self.assertEqual(library.features, native.Features(targets=True, context=True))
        self.assertEqual(len(handle.functions["cosmos_surface_send_text_to"].argtypes), 5)
        self.assertEqual(len(handle.functions["cosmos_surface_send_text_with_context"].argtypes), 9)
        surface = native.Surface(library, b'{"version":1}', NullBindings())
        self.assertEqual(surface.send_text_to("hello", "android_tv"), native.OK)
        name, arguments = handle.calls[-1]
        self.assertEqual(name, "cosmos_surface_send_text_to")
        self.assertEqual(self.argument_bytes(arguments, 1), b"hello")
        self.assertEqual(self.argument_bytes(arguments, 3), b"android_tv")
        self.assertEqual(surface.send_text_to("hello", None), native.OK)
        name, arguments = handle.calls[-1]
        self.assertIsNone(arguments[3], "no destination is NULL with length 0")
        self.assertEqual(arguments[4], 0)
        self.assertEqual(surface.send_text_with_context("hello", "Mail", "Lunch?", "macos"), native.OK)
        name, arguments = handle.calls[-1]
        self.assertEqual(name, "cosmos_surface_send_text_with_context")
        self.assertEqual(self.argument_bytes(arguments, 1), b"hello")
        self.assertEqual(self.argument_bytes(arguments, 3), b"Mail")
        self.assertEqual(self.argument_bytes(arguments, 5), b"Lunch?")
        self.assertEqual(self.argument_bytes(arguments, 7), b"macos")
        surface.destroy()

    def test_bounds_are_checked_before_the_library_sees_them(self):
        handle, library = self.load(("cosmos_surface_send_text_to", "cosmos_surface_send_text_with_context"))
        surface = native.Surface(library, b'{"version":1}', NullBindings())
        before = len(handle.calls)
        self.assertEqual(surface.send_text_to("   ", "macos"), native.INVALID_ARGUMENT)
        self.assertEqual(surface.send_text_to("x" * 4001, "macos"), native.INVALID_ARGUMENT)
        self.assertEqual(surface.send_text_to("hello", "x" * 17), native.INVALID_ARGUMENT)
        self.assertEqual(surface.send_text_with_context("hello", "", "body", None), native.INVALID_ARGUMENT)
        self.assertEqual(surface.send_text_with_context("hello", "a" * 65, "body", None), native.INVALID_ARGUMENT)
        self.assertEqual(surface.send_text_with_context("hello", "Mail", "b" * 8001, None), native.INVALID_ARGUMENT)
        self.assertEqual(surface.send_text_with_context("hello", "Mail", "b\0", None), native.INVALID_ARGUMENT)
        self.assertEqual(len(handle.calls), before, "nothing reached the library")
        surface.destroy()


class Bindings:
    def __init__(self):
        self.journal = None
        self.writes = 0
        self.signatures = 0

    def public_key_sec1(self):
        return GENERATOR_SEC1

    def sign_sha256(self, message):
        self.signatures += 1
        return b"\x30\x06\x02\x01\x01\x02\x01\x01"

    def read_journal(self):
        return self.journal

    def write_journal_atomically(self, data):
        self.journal = bytes(data)
        self.writes += 1


@unittest.skipUnless(LIBRARY is not None, "shared client library unavailable (set COSMOS_SURFACE_LIBRARY)")
class NativeSmokeTest(unittest.TestCase):
    def setUp(self):
        self.library = native.load_library(LIBRARY)

    @staticmethod
    def config(enrollment_id):
        return json.dumps({
            "version": 1, "serverOrigin": "https://center.andersmadsen.dk", "enrollmentId": str(enrollment_id),
            "platform": "linux", "bootEpoch": str(uuid.uuid4()),
        }).encode("utf-8")

    def test_prepare_reports_this_identity_as_a_linux_descriptor(self):
        enrollment_id = uuid.uuid4()
        bindings = Bindings()
        surface = native.Surface(self.library, self.config(enrollment_id), bindings)
        try:
            event = None
            deadline = time.monotonic() + 15
            while event is None and time.monotonic() < deadline:
                raw = surface.poll()
                if raw is None:
                    time.sleep(0.05)
                    continue
                event = decode(raw)
            self.assertIsNotNone(event, "the prepare snapshot never arrived")
            self.assertEqual(event.operation, "prepare")
            self.assertTrue(event.ok, event.error)
            self.assertEqual(event.descriptor.platform, "linux")
            self.assertEqual(event.descriptor.approval, APPROVAL_PROFILE)
            self.assertEqual(event.descriptor.enrollment_id, str(enrollment_id))
            self.assertEqual(fingerprint_of_encoded(event.descriptor.public_key), fingerprint(GENERATOR_SEC1))
            self.assertFalse(event.connected)
            self.assertTrue(event.needs_reconnect)
            self.assertGreaterEqual(bindings.writes, 1)
            self.assertTrue(bindings.journal)
            self.assertEqual(bindings.signatures, 0, "preparing signs nothing")
            self.assertIsNone(surface.take_callback_failure())
            with self.assertRaises(native.NativeError):
                surface.speech_audio(0)
            self.assertEqual(surface.set_visible(True), native.OK)
            self.assertEqual(surface.send_text("   "), native.INVALID_ARGUMENT)
            self.assertIsInstance(self.library.features, native.Features)
            if self.library.features.targets:
                self.assertEqual(surface.send_text_to("   ", "macos"), native.INVALID_ARGUMENT)
                self.assertEqual(surface.send_text_to("hello", "plan9"), native.INVALID_ARGUMENT)
            else:
                self.assertEqual(surface.send_text_to("hello", "macos"), native.UNAVAILABLE)
            self.assertTrue(self.library.features.actions,
                            "this library predates the device-action calls")
            # The three calls exist and bound input is refused before anything
            # is enqueued; there is no task or ceremony on a prepared surface.
            self.assertEqual(surface.report(b""), native.INVALID_ARGUMENT)
            self.assertEqual(surface.report(b'{"outcome":"nonsense"}'), native.INVALID_ARGUMENT)
            self.assertEqual(surface.grant(True, None), native.INVALID_ARGUMENT)
            self.assertEqual(surface.grant(True, "not_an_attestation"), native.INVALID_ARGUMENT)
            self.assertEqual(surface.acknowledge_task(), native.OK)
            self.assertEqual(surface.report(
                b'{"outcome":"unknown","evidence":{"kind":"open","opened":false}}'), native.OK)
            self.assertEqual(surface.grant(False, None), native.OK)
        finally:
            self.assertEqual(surface.destroy(), native.OK)
            self.assertEqual(surface.destroy(), native.OK)
        with self.assertRaises(native.NativeError):
            surface.connect()

    def test_journal_bytes_round_trip_through_the_callbacks(self):
        enrollment_id = uuid.uuid4()
        first = Bindings()
        surface = native.Surface(self.library, self.config(enrollment_id), first)
        try:
            deadline = time.monotonic() + 15
            while first.writes == 0 and time.monotonic() < deadline:
                time.sleep(0.05)
        finally:
            surface.destroy()
        self.assertTrue(first.journal)
        second = Bindings()
        second.journal = first.journal
        deadline = time.monotonic() + 15
        surface = None
        while surface is None and time.monotonic() < deadline:
            try:
                surface = native.Surface(self.library, self.config(enrollment_id), second)
            except native.NativeError as error:
                if error.code != native.QUEUE_FULL:
                    raise
                time.sleep(0.2)
        self.assertIsNotNone(surface, "the native slot was not released")
        try:
            event = None
            deadline = time.monotonic() + 15
            while event is None and time.monotonic() < deadline:
                raw = surface.poll()
                if raw is None:
                    time.sleep(0.05)
                    continue
                event = decode(raw)
            self.assertIsNotNone(event)
            self.assertTrue(event.ok, event.error)
            self.assertEqual(event.descriptor.enrollment_id, str(enrollment_id))
        finally:
            surface.destroy()

    def test_invalid_public_configuration_is_refused_before_any_callback(self):
        class Untouchable:
            def __getattr__(self, name):
                raise AssertionError("no callback may run for an invalid configuration")

        with self.assertRaises(native.NativeError) as refused:
            native.Surface(self.library, b'{"version":2}', Untouchable())
        self.assertEqual(refused.exception.code, native.INVALID_ARGUMENT)
        with self.assertRaises(native.NativeError):
            native.Surface(self.library, self.config(uuid.uuid4()).replace(b"linux", b"plan9"), Untouchable())

    def test_missing_library_is_reported_with_the_search_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(FileNotFoundError) as missing:
                native.load_library(Path(temporary) / "nothing.so")
            self.assertIn(native.ENVIRONMENT_VARIABLE, str(missing.exception))


if __name__ == "__main__":
    unittest.main()
