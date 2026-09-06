import os
import tempfile
import unittest
from pathlib import Path

from cosmos_linux.journal import AlreadyRunning, InstallationLease, JournalStore

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec

    from cosmos_linux.identity import InstallationStore, open_identity
    HAVE_CRYPTOGRAPHY = True
except ImportError:  # pragma: no cover - exercised only on hosts without the package
    HAVE_CRYPTOGRAPHY = False


@unittest.skipUnless(HAVE_CRYPTOGRAPHY, "cryptography is not installed")
class IdentityTest(unittest.TestCase):
    def test_file_key_is_a_private_p256_software_key_that_signs_der(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "cosmos"
            store = InstallationStore(directory)
            identity = open_identity(directory, store, allow_keyring=False)
            self.assertEqual(identity.storage, "file")
            self.assertIn("Software key", identity.notice)
            self.assertNotIn("hardware", identity.notice.lower().replace("no hardware attestation", ""))
            key_file = directory / "installation-key.pem"
            self.assertEqual(key_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(directory.stat().st_mode & 0o077, 0)
            public = identity.public_key_sec1()
            self.assertEqual(len(public), 65)
            self.assertEqual(public[0], 4)
            message = b"transcript"
            signature = identity.sign_sha256(message)
            self.assertLessEqual(len(signature), 72)
            verifier = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public)
            verifier.verify(signature, message, ec.ECDSA(hashes.SHA256()))
            with self.assertRaises(InvalidSignature):
                verifier.verify(signature, b"other", ec.ECDSA(hashes.SHA256()))
            reopened = open_identity(directory, InstallationStore(directory), allow_keyring=False)
            self.assertEqual(reopened.public_key_sec1(), public)
            self.assertEqual(reopened.enrollment_id, identity.enrollment_id)
            self.assertNotIn("installation-key.pem.tmp", os.listdir(directory))

    def test_installation_store_persists_public_settings_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "cosmos"
            store = InstallationStore(directory)
            self.assertIsNone(store.get("serverOrigin"))
            store.set("serverOrigin", "https://center.andersmadsen.dk")
            first = store.enrollment_id()
            again = InstallationStore(directory)
            self.assertEqual(again.get("serverOrigin"), "https://center.andersmadsen.dk")
            self.assertEqual(again.enrollment_id(), first)
            self.assertEqual((directory / "installation.json").stat().st_mode & 0o777, 0o600)


class JournalTest(unittest.TestCase):
    def test_journal_is_replaced_atomically_at_mode_0600(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "cosmos"
            journal = JournalStore(directory)
            self.assertIsNone(journal.read())
            journal.write_atomically(b"first")
            self.assertEqual(journal.read(), b"first")
            journal.write_atomically(b"second")
            self.assertEqual(journal.read(), b"second")
            self.assertEqual(journal.path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(sorted(os.listdir(directory)), ["journal.bin"])
            with self.assertRaises(ValueError):
                journal.write_atomically(b"")
            with self.assertRaises(ValueError):
                journal.write_atomically(b"x" * 32769)
            self.assertEqual(journal.read(), b"second")

    def test_lease_is_exclusive(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "cosmos"
            lease = InstallationLease(directory)
            with self.assertRaises(AlreadyRunning):
                InstallationLease(directory)
            lease.release()
            InstallationLease(directory).release()


if __name__ == "__main__":
    unittest.main()
