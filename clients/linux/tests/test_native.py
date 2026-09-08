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
from cosmos_linux.events import KNOWN_APPROVALS, decode

# The P-256 base point in uncompressed SEC1 form: a valid public key with no private half here.
GENERATOR_SEC1 = bytes.fromhex(
    "04"
    "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"
    "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"
)
# The four calls a build needs before it may carry a command out at all.
ACTION_SYMBOLS = ("cosmos_surface_acknowledge_task", "cosmos_surface_report", "cosmos_surface_grant",
                  "cosmos_surface_device_policy")
ACTION_ID = "2f1c8a90-4d5e-4a6b-8c7d-9e0f1a2b3c4d"


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
            # Holding no policy is the ordinary state of a fresh handle.
            result = native.EMPTY if name == "cosmos_surface_device_policy" else native.OK
            self.functions[name] = FakeFunction(name, self.calls, result)
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
        self.assertEqual(library.features, native.Features(targets=False, context=False, actions=False))
        surface = native.Surface(library, b'{"version":1}', NullBindings())
        self.assertEqual(surface.send_text_to("hello", "macos"), native.UNAVAILABLE)
        self.assertEqual(surface.send_text_with_context("hello", "Mail", "body", None), native.UNAVAILABLE)
        self.assertEqual(surface.report(ACTION_ID, b'{"outcome":"unknown"}'), native.UNAVAILABLE)
        # A build that cannot read the owner's policy holds none, which is
        # exactly what it should then do.
        self.assertIsNone(surface.device_policy(64))
        self.assertEqual([name for name, _ in handle.calls], ["cosmos_surface_create"])
        self.assertEqual(surface.send_text("hello"), native.OK)
        self.assertEqual(handle.calls[-1][0], "cosmos_surface_send_text")
        self.assertEqual(self.argument_bytes(handle.calls[-1][1], 1), b"hello")
        surface.destroy()

    def test_the_device_action_calls_are_one_set_and_report_names_its_action(self):
        """A build missing any of the four cannot carry a command out honestly:
        without the policy call it could not read the owner's permission, and
        its `report` would be the older call that names no action."""
        for missing in ACTION_SYMBOLS:
            handle, library = self.load(tuple(name for name in ACTION_SYMBOLS if name != missing))
            self.assertFalse(library.features.actions, missing)
        handle, library = self.load(ACTION_SYMBOLS)
        self.assertTrue(library.features.actions)
        self.assertEqual(len(handle.functions["cosmos_surface_report"].argtypes), 5)
        self.assertEqual(len(handle.functions["cosmos_surface_device_policy"].argtypes), 4)
        surface = native.Surface(library, b'{"version":1}', NullBindings())
        self.assertEqual(surface.report(ACTION_ID, b'{"outcome":"unknown"}'), native.OK)
        name, arguments = handle.calls[-1]
        self.assertEqual(name, "cosmos_surface_report")
        self.assertEqual(self.argument_bytes(arguments, 1), ACTION_ID.encode("utf-8"))
        self.assertEqual(self.argument_bytes(arguments, 3), b'{"outcome":"unknown"}')
        # The action the report is about is bounded before the library sees it.
        before = len(handle.calls)
        for action in ("", "not-a-uuid", ACTION_ID + "0", ACTION_ID[:-1] + "\0"):
            self.assertEqual(surface.report(action, b'{"outcome":"unknown"}'), native.INVALID_ARGUMENT, action)
        self.assertEqual(surface.report(ACTION_ID, b""), native.INVALID_ARGUMENT)
        self.assertEqual(len(handle.calls), before, "nothing reached the library")
        surface.destroy()

    def test_a_document_never_falls_back_to_an_ordinary_context_call(self):
        handle, library = self.load(("cosmos_surface_send_text_with_context",))
        surface = native.Surface(library, b'{"version":1}', NullBindings())
        try:
            self.assertEqual(surface.send_text_with_context("Explain", "Text file", "body", None, b'{}'),
                             native.UNAVAILABLE)
            self.assertEqual([name for name, _ in handle.calls], ["cosmos_surface_create"])
        finally:
            surface.destroy()

    def test_the_policy_document_is_copied_out_by_the_length_the_snapshot_named(self):
        handle, library = self.load(ACTION_SYMBOLS)
        surface = native.Surface(library, b'{"version":1}', NullBindings())
        self.assertIsNone(surface.device_policy(64), "an empty buffer means this installation holds none")
        name, arguments = handle.calls[-1]
        self.assertEqual(name, "cosmos_surface_device_policy")
        self.assertEqual(arguments[2], 64)
        for length in (0, -1, native.MAX_POLICY_BYTES + 1):
            with self.assertRaises(native.NativeError, msg=length):
                surface.device_policy(length)
        surface.destroy()

    def test_task_progress_requires_all_action_calls_and_preserves_milliseconds(self):
        _, old = self.load(ACTION_SYMBOLS)
        self.assertFalse(old.features.commands)
        handle, library = self.load((*ACTION_SYMBOLS, "cosmos_surface_progress"))
        self.assertTrue(library.features.commands)
        surface = native.Surface(library, b'{"version":1}', NullBindings())
        self.assertEqual(surface.progress(2, 10500), native.OK)
        self.assertEqual(handle.calls[-1], ("cosmos_surface_progress", (surface._handle, 2, 10500)))
        for sequence, elapsed in ((0, 1), (2**32, 1), (1, -1), (1, 900001)):
            self.assertEqual(surface.progress(sequence, elapsed), native.INVALID_ARGUMENT)
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
            # The shared library enrols at its own newest profile; this client
            # accepts that one and every earlier rung it published.
            self.assertIn(event.descriptor.approval, KNOWN_APPROVALS)
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
            # The four calls exist and bound input is refused before anything
            # is enqueued; there is no task, ceremony or policy on a prepared
            # surface, and holding no policy is an ordinary state.
            self.assertIsNone(surface.device_policy(native.MAX_POLICY_BYTES))
            self.assertEqual(surface.report(ACTION_ID, b""), native.INVALID_ARGUMENT)
            self.assertEqual(surface.report(ACTION_ID, b'{"outcome":"nonsense"}'), native.INVALID_ARGUMENT)
            self.assertEqual(surface.report("00000000-0000-0000-0000-000000000000",
                                            b'{"outcome":"unknown","evidence":{"kind":"open","opened":false}}'),
                             native.INVALID_ARGUMENT)
            self.assertEqual(surface.grant(True, None), native.INVALID_ARGUMENT)
            self.assertEqual(surface.grant(True, "not_an_attestation"), native.INVALID_ARGUMENT)
            self.assertEqual(surface.acknowledge_task(), native.OK)
            self.assertEqual(surface.report(
                ACTION_ID, b'{"outcome":"unknown","evidence":{"kind":"open","opened":false}}'), native.OK)
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

    def test_document_and_target_calls_report_the_exact_operation_the_controller_waits_for(self):
        surface = native.Surface(self.library, self.config(uuid.uuid4()), Bindings())
        try:
            self.assertTrue(self.library.features.document)
            document = json.dumps({"app": "Text file", "locator": {"scheme": "file", "rootId": "docs", "relative": "notes.txt"},
                                   "label": "notes.txt", "version": "1" * 64}).encode()
            for name, send in (
                ("send_text_to", lambda: surface.send_text_to("Continue", "macos")),
                ("send_text_with_context", lambda: surface.send_text_with_context("Explain", "Text file", "Saved text", None)),
                ("send_text_with_document", lambda: surface.send_text_with_context("Explain", "Text file", "Saved text", "macos", document)),
            ):
                self.assertEqual(send(), native.OK)
                deadline = time.monotonic() + 15
                found = None
                while time.monotonic() < deadline:
                    raw = surface.poll()
                    if raw is not None:
                        event = decode(raw)
                        if event.operation == name:
                            found = event
                            break
                    time.sleep(0.01)
                self.assertIsNotNone(found, name)
                self.assertFalse(found.ok, "the fixture has not connected to any server")
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
