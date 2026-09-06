"""The selected Center origin, the public descriptor and the approval link.

The server is configuration, never part of the installation key. The
descriptor carries public enrollment data only; the approval link hands it to
Center as a fragment, which never reaches the server.
"""
from __future__ import annotations

import base64
import hashlib
import json
from urllib.parse import urlsplit

from .native import MAX_TEXT_BYTES

DEFAULT_SERVER_ORIGIN = "https://center.andersmadsen.dk"
SURFACES_PATH = "/settings/account/surfaces"
MAX_DESCRIPTOR_BYTES = 1024


class InvalidServer(ValueError):
    """The address is not a plain HTTPS origin."""


def canonical_origin(text: str) -> str:
    """Normalize ``https://Host[:port][/]`` to the origin form the client signs."""
    value = text.strip()
    if not value or len(value) > 255 or "%" in value or "\\" in value or any(c.isspace() for c in value):
        raise InvalidServer("invalid server")
    try:
        parts = urlsplit(value)
    except ValueError as error:
        raise InvalidServer("invalid server") from error
    host = parts.hostname
    if (parts.scheme.lower() != "https" or not host or not host.isascii() or parts.username is not None
            or parts.password is not None or parts.query or parts.fragment or parts.path not in ("", "/")):
        raise InvalidServer("invalid server")
    try:
        port = parts.port
    except ValueError as error:
        raise InvalidServer("invalid server") from error
    if port is not None and not 1 <= port <= 65535:
        raise InvalidServer("invalid server")
    if not all(c.isalnum() or c in ".-" for c in host) or host.startswith(".") or host.endswith("."):
        if not (host.startswith("[") and host.endswith("]")):
            raise InvalidServer("invalid server")
    origin = f"https://{host.lower()}"
    if port is not None and port != 443:
        origin += f":{port}"
    return origin


def display_host(origin: str) -> str:
    """The host shown in the UI ("center.andersmadsen.dk")."""
    return origin[len("https://"):]


def surfaces_url(origin: str) -> str:
    return origin + SURFACES_PATH


def base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def debase64url(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def descriptor_json(enrollment_id: str, public_key: str, platform: str, approval: str) -> bytes:
    """The public descriptor exactly as Center expects it (four fields, sorted keys)."""
    encoded = json.dumps(
        {"approval": approval, "enrollmentId": enrollment_id, "platform": platform, "publicKey": public_key},
        separators=(",", ":"), sort_keys=True, ensure_ascii=True,
    ).encode("utf-8")
    if len(encoded) > MAX_DESCRIPTOR_BYTES:
        raise ValueError("descriptor exceeds 1 KB")
    return encoded


def approval_url(origin: str, descriptor: bytes) -> str:
    """Center's approval page with the descriptor as a link fragment."""
    if len(descriptor) > MAX_DESCRIPTOR_BYTES:
        raise ValueError("descriptor exceeds 1 KB")
    return f"{surfaces_url(origin)}#descriptor={base64url(descriptor)}"


def fingerprint(public_key_sec1: bytes) -> str:
    """SHA-256 of the 65 uncompressed SEC1 bytes, lowercase hex; Center shows the same."""
    if len(public_key_sec1) != 65 or public_key_sec1[0] != 4:
        raise ValueError("public key is not an uncompressed SEC1 point")
    return hashlib.sha256(public_key_sec1).hexdigest()


def fingerprint_of_encoded(public_key: str) -> str:
    return fingerprint(debase64url(public_key))


def group_fingerprint(digest: str, size: int = 4) -> str:
    """Space-separated groups so the owner can compare against Center by eye."""
    return " ".join(digest[index:index + size] for index in range(0, len(digest), size))


def valid_text(text: str) -> bool:
    return bool(text.strip()) and len(text.encode("utf-8")) <= MAX_TEXT_BYTES and "\0" not in text
