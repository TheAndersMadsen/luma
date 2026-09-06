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
