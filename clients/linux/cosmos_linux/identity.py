"""The installation identity: one P-256 software key plus an enrollment locator.

The private key lives in the Secret Service keyring when one is reachable and
otherwise in a 0600 file under the Cosmos data directory. Both are software
keys: nothing here attests hardware, and the UI says so.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path
from typing import Optional

APP_ID = "dk.andersmadsen.cosmos.linux"
KEY_FILE = "installation-key.pem"
INSTALLATION_FILE = "installation.json"
KEYRING_ATTRIBUTES = {"application": APP_ID, "role": "installation-key"}
KEYRING_LABEL = "Cosmos installation key (Linux)"


class IdentityError(Exception):
    """The key or locator could not be opened or created."""


def default_data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return Path(base) / "cosmos"


def ensure_private_dir(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink() or not directory.is_dir():
        raise IdentityError(f"{directory} is not a directory")
    mode = directory.stat().st_mode & 0o777
    if mode & 0o077:
        os.chmod(directory, 0o700)
    return directory


def write_private_file(path: Path, data: bytes) -> None:
    """Replace a 0600 file atomically: temporary sibling, fsync, rename, directory fsync."""
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _serialize(key) -> bytes:
    from cryptography.hazmat.primitives import serialization

    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


def _deserialize(data: bytes):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = serialization.load_pem_private_key(data, password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise IdentityError("the stored installation key is not a P-256 key")
    return key


class InstallationStore:
    """Public installation settings: enrollment locator and selected server origin."""

    def __init__(self, directory: Path) -> None:
        self.directory = ensure_private_dir(directory)
        self.path = self.directory / INSTALLATION_FILE
        self._lock = threading.Lock()
        self._values = self._read()

    def _read(self) -> dict:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as error:
            raise IdentityError(f"{self.path} is unreadable") from error
        return value if isinstance(value, dict) else {}

    def get(self, key: str) -> Optional[str]:
        value = self._values.get(key)
        return value if isinstance(value, str) else None

    def set(self, key: str, value: str) -> None:
        with self._lock:
            self._values[key] = value
            write_private_file(self.path, json.dumps(self._values, indent=2, sort_keys=True).encode("utf-8"))

    def enrollment_id(self) -> uuid.UUID:
        current = self.get("enrollmentId")
        if current:
            try:
                parsed = uuid.UUID(current)
            except ValueError as error:
                raise IdentityError("the stored enrollment locator is invalid") from error
            if parsed.int != 0:
                return parsed
        fresh = uuid.uuid4()
        self.set("enrollmentId", str(fresh))
        return fresh


class Identity:
    """Signs with the software key; the private key never leaves this object."""

    def __init__(self, key, enrollment_id: uuid.UUID, storage: str, location: str) -> None:
        self._key = key
        self.enrollment_id = enrollment_id
        self.storage = storage
        self.location = location

    @property
    def notice(self) -> str:
        if self.storage == "keyring":
            return "Software key held by the Secret Service keyring. No hardware attestation."
        return f"Software key on disk at {self.location}. No hardware attestation."

    def public_key_sec1(self) -> bytes:
        """Uncompressed SEC1 point: 0x04 || X || Y."""
        from cryptography.hazmat.primitives import serialization

        return self._key.public_key().public_bytes(serialization.Encoding.X962,
                                                   serialization.PublicFormat.UncompressedPoint)

    def sign_sha256(self, message: bytes) -> bytes:
        """DER ECDSA over SHA-256 of the complete message, hashed exactly once."""
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec

        return self._key.sign(message, ec.ECDSA(hashes.SHA256()))


class _Keyring:
    """Secret Service access through ``secretstorage``; every failure means unavailable."""

    def __init__(self) -> None:
        import secretstorage  # noqa: F401 (imported lazily; absent on hosts without D-Bus)
        self._module = secretstorage
        self._connection = secretstorage.dbus_init()
        self._collection = secretstorage.get_default_collection(self._connection)
        if self._collection.is_locked():
            self._collection.unlock()
        if self._collection.is_locked():
            raise IdentityError("the default keyring is locked")

    def load(self) -> Optional[bytes]:
        for item in self._collection.search_items(KEYRING_ATTRIBUTES):
            return bytes(item.get_secret())
        return None

    def store(self, secret: bytes) -> None:
        self._collection.create_item(KEYRING_LABEL, KEYRING_ATTRIBUTES, secret, replace=True,
                                     content_type="application/x-pem-file")

    def close(self) -> None:
        try:
            self._connection.close()
        except Exception:
            pass


def open_identity(directory: Path, store: InstallationStore, allow_keyring: bool = True) -> Identity:
    """Open the existing key or create one. Existing material is never replaced."""
    from cryptography.hazmat.primitives.asymmetric import ec

    ensure_private_dir(directory)
    key_file = directory / KEY_FILE
    keyring: Optional[_Keyring] = None
    if allow_keyring:
        try:
            keyring = _Keyring()
        except Exception:
            keyring = None
    try:
        if keyring is not None:
            secret = keyring.load()
            if secret:
                return Identity(_deserialize(secret), store.enrollment_id(), "keyring", "Secret Service")
        if key_file.exists():
            if key_file.is_symlink() or not key_file.is_file():
                raise IdentityError(f"{key_file} is not a regular file")
            if key_file.stat().st_mode & 0o077:
                raise IdentityError(f"{key_file} is readable by other users; fix its mode to 0600")
            return Identity(_deserialize(key_file.read_bytes()), store.enrollment_id(), "file", str(key_file))
        key = ec.generate_private_key(ec.SECP256R1())
        serialized = _serialize(key)
        if keyring is not None:
            try:
                keyring.store(serialized)
                return Identity(key, store.enrollment_id(), "keyring", "Secret Service")
            except Exception:
                pass
        write_private_file(key_file, serialized)
        return Identity(key, store.enrollment_id(), "file", str(key_file))
    except (OSError, ValueError, ImportError) as error:
        raise IdentityError(str(error)) from error
    finally:
        if keyring is not None:
            keyring.close()
