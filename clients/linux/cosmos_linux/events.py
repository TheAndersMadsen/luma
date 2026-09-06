"""Strict decoding of the shared client's redacted state snapshots.

Only presentation-safe fields exist here. Journals, session tokens, signatures
and request text never enter this interface.
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from typing import Optional

from .native import MAX_SPEECH_BYTES, MAX_TEXT_BYTES

# Mirrors PROFILE in the Rust client (surface-client wire.rs). The descriptor the
# library reports is verified against it; a different profile is an invalid response.
APPROVAL_PROFILE = "native-shared-speech-v3"
PLATFORM = "linux"
OPERATIONS = frozenset({
    "prepare", "connect", "send_text", "retry_pending", "cancel", "set_visible", "acknowledge",
    "acknowledge_speech", "display", "speech", "invitation", "disconnect", "heartbeat",
})
PRIVACY_LEVELS = ("public", "shared_room", "near_user", "private")
PRIVATE_LEVELS = frozenset({"near_user", "private"})
ORIGINS = frozenset({"pin", "browser", "macos", "linux", "android", "android_tv"})
PENDING_KINDS = frozenset({"text", "heartbeat", "cancel", "state", "acknowledge"})
MAX_SAFE_INTEGER = 9_007_199_254_740_991
HEX64 = re.compile(r"^[0-9a-f]{64}$")
BASE64URL_KEY = re.compile(r"^[A-Za-z0-9_-]{87}$")


class InvalidEvent(ValueError):
    """Any snapshot shape this client does not understand."""


@dataclass(frozen=True)
class Descriptor:
    enrollment_id: str
    public_key: str
    platform: str
    approval: str


@dataclass(frozen=True)
class Pending:
    kind: str
    instance_id: str
    sequence: int
    can_retry: bool


@dataclass(frozen=True)
class Admission:
    turn_id: str
    generation: int
    duplicate: bool


@dataclass(frozen=True)
class CreditPart:
    kind: str
    text: str
    href: Optional[str] = None


@dataclass(frozen=True)
class PlaceItem:
    place_id: str
    name: str
    address: str
    source_url: Optional[str]


@dataclass(frozen=True)
class DisplayCard:
    action_id: str
    turn_id: str
    generation: int
    content_digest: str
    expires_at_ms: int
    kind: str
    text: str = ""
    query: str = ""
    items: tuple = ()
    credits: tuple = ()
    # Above shared_room the card is private: shown in this window only, never in a
    # notification or preview, and retired once the window leaves the foreground.
    privacy: str = "shared_room"

    @property
    def private(self) -> bool:
        return self.privacy in PRIVATE_LEVELS


@dataclass(frozen=True)
class Invitation:
    """A private card is waiting for this installation. It carries no content."""

    id: str
    origin: str
    privacy: str
    expires_at_ms: int


@dataclass(frozen=True)
class SpeechReply:
    action_id: str
    turn_id: str
    generation: int
    content_digest: str
    expires_at_ms: int
    text: str
    format: str
    byte_length: int


@dataclass(frozen=True)
class NativeEvent:
    operation: str
    error: Optional[str]
    connected: bool
    pending_open: bool
    needs_reconnect: bool
    descriptor: Optional[Descriptor]
    pending: Optional[Pending]
    last_unknown: Optional[Pending]
    admission: Optional[Admission]
    visible: bool
    display: Optional[DisplayCard]
    speech: Optional[SpeechReply]
    events_skipped: int
    invitation: Optional[Invitation] = None

    @property
    def ok(self) -> bool:
        return self.error is None


def _record(value, label: str) -> dict:
    if not isinstance(value, dict):
        raise InvalidEvent(f"{label} is not an object")
    return value


def _string(value: dict, key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str):
        raise InvalidEvent(f"{key} is not a string")
    return item


def _bool(value: dict, key: str) -> bool:
    item = value.get(key)
    if not isinstance(item, bool):
        raise InvalidEvent(f"{key} is not a boolean")
    return item


def _integer(value: dict, key: str, minimum: int = 1, maximum: int = MAX_SAFE_INTEGER) -> int:
    item = value.get(key)
    if isinstance(item, bool) or not isinstance(item, int) or item < minimum or item > maximum:
        raise InvalidEvent(f"{key} is out of range")
    return item


def _uuid(value: dict, key: str) -> str:
    text = _string(value, key)
    try:
        parsed = uuid.UUID(text)
    except ValueError as error:
        raise InvalidEvent(f"{key} is not a UUID") from error
    if parsed.int == 0 or str(parsed) != text.lower():
        raise InvalidEvent(f"{key} is not a canonical nonnil UUID")
    return str(parsed)


def _text(value: str, label: str) -> str:
    if not value.strip() or len(value.encode("utf-8")) > MAX_TEXT_BYTES or "\0" in value:
        raise InvalidEvent(f"{label} is empty, oversized or contains NUL")
    return value


def _https(value: str, label: str) -> str:
    if not value.startswith("https://") or len(value) <= len("https://") or any(c.isspace() for c in value):
        raise InvalidEvent(f"{label} is not an HTTPS link")
    return value


def _pending(value) -> Optional[Pending]:
    if value is None:
        return None
    record = _record(value, "pending")
    kind = _string(record, "kind")
    if kind not in PENDING_KINDS:
        raise InvalidEvent("unsupported pending kind")
    return Pending(kind, _uuid(record, "instanceId"), _integer(record, "sequence"), _bool(record, "canRetry"))


def _admission(value) -> Optional[Admission]:
    if value is None:
        return None
    record = _record(value, "admission")
    return Admission(_uuid(record, "turnId"), _integer(record, "generation"), _bool(record, "duplicate"))


def _descriptor(value) -> Optional[Descriptor]:
    if value is None:
        return None
    record = _record(value, "descriptor")
    descriptor = Descriptor(
        _uuid(record, "enrollmentId"), _string(record, "publicKey"),
        _string(record, "platform"), _string(record, "approval"),
    )
    if descriptor.platform != PLATFORM or descriptor.approval != APPROVAL_PROFILE:
        raise InvalidEvent("foreign descriptor")
    if not BASE64URL_KEY.match(descriptor.public_key):
        raise InvalidEvent("descriptor public key is not a base64url SEC1 point")
    return descriptor


def _credit(value) -> CreditPart:
    record = _record(value, "credit")
    kind = _string(record, "kind")
    text = _string(record, "text")
    if kind == "text":
        if "href" in record and record["href"] is not None:
            raise InvalidEvent("text credit with href")
        return CreditPart("text", text)
    if kind == "link":
        href = _https(_string(record, "href"), "credit href")
        if not text.strip():
            raise InvalidEvent("empty credit link text")
        return CreditPart("link", text, href)
    raise InvalidEvent("unsupported credit kind")


def _place(value) -> PlaceItem:
    record = _record(value, "place")
    source = record.get("sourceUrl")
    if source is not None:
        source = _https(_string(record, "sourceUrl"), "place source")
    place = PlaceItem(_string(record, "placeId"), _string(record, "name"), _string(record, "address"), source)
    if not place.place_id or not place.name or not place.address:
        raise InvalidEvent("incomplete place")
    return place


def _display(value) -> Optional[DisplayCard]:
    if value is None:
        return None
    record = _record(value, "display")
    content = _record(record.get("content"), "content")
    credits = record.get("credits")
    if not isinstance(credits, list):
        raise InvalidEvent("credits is not a list")
    privacy = record.get("privacy", "shared_room")
    if privacy not in PRIVACY_LEVELS:
        raise InvalidEvent("unsupported card privacy")
    identity = dict(
        action_id=_uuid(record, "actionId"), turn_id=_uuid(record, "turnId"),
        generation=_integer(record, "generation"), content_digest=_string(record, "contentDigest"),
        expires_at_ms=_integer(record, "expiresAtMs"), privacy=privacy,
    )
    if not HEX64.match(identity["content_digest"]):
        raise InvalidEvent("content digest is not lowercase hex")
    kind = _string(content, "kind")
    if kind == "text":
        if credits or set(content) - {"kind", "text"}:
            raise InvalidEvent("text card with extra fields")
        return DisplayCard(kind="text", text=_text(_string(content, "text"), "card text"), **identity)
    if kind == "places":
        if set(content) - {"kind", "query", "items", "attributions"}:
            raise InvalidEvent("places card with extra fields")
        query = _string(content, "query")
        items = content.get("items")
        attributions = content.get("attributions")
        if not query or not isinstance(items, list) or not isinstance(attributions, list):
            raise InvalidEvent("invalid places card")
        if len(items) > 4 or len(attributions) != len(credits) or len(credits) > 16:
            raise InvalidEvent("places card bounds")
        if not all(isinstance(entry, str) for entry in attributions):
            raise InvalidEvent("attribution is not a string")
        parts = tuple(tuple(_credit(part) for part in _list(line, "credit line")) for line in credits)
        return DisplayCard(kind="places", query=query, items=tuple(_place(item) for item in items),
                           credits=parts, **identity)
    raise InvalidEvent("unsupported card")


def _list(value, label: str) -> list:
    if not isinstance(value, list):
        raise InvalidEvent(f"{label} is not a list")
    return value


def _invitation(value) -> Optional[Invitation]:
    if value is None:
        return None
    record = _record(value, "invitation")
    invitation = Invitation(_uuid(record, "id"), _string(record, "origin"), _string(record, "privacy"),
                            _integer(record, "expiresAtMs"))
    if invitation.origin not in ORIGINS or invitation.privacy not in PRIVATE_LEVELS:
        raise InvalidEvent("invalid invitation")
    return invitation


def _speech(value) -> Optional[SpeechReply]:
    if value is None:
        return None
    record = _record(value, "speech")
    reply = SpeechReply(
        action_id=_uuid(record, "actionId"), turn_id=_uuid(record, "turnId"),
        generation=_integer(record, "generation"), content_digest=_string(record, "contentDigest"),
        expires_at_ms=_integer(record, "expiresAtMs"), text=_text(_string(record, "text"), "speech text"),
        format=_string(record, "format"), byte_length=_integer(record, "byteLength", 1, MAX_SPEECH_BYTES),
    )
    if reply.format != "audio/mpeg" or not HEX64.match(reply.content_digest):
        raise InvalidEvent("invalid speech reply")
    return reply


def decode(raw: bytes) -> NativeEvent:
    """Strict decode; any unsupported shape is a client-side invalid response."""
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise InvalidEvent("snapshot is not UTF-8 JSON") from error
    record = _record(value, "snapshot")
    if record.get("version") != 1 or record.get("kind") != "state":
        raise InvalidEvent("unsupported snapshot")
    operation = _string(record, "operation")
    if operation not in OPERATIONS:
        raise InvalidEvent("unsupported operation")
    outcome = _string(record, "outcome")
    error = record.get("error")
    if error is not None and not isinstance(error, str):
        raise InvalidEvent("error is not a string")
    if outcome not in ("ok", "error") or (outcome == "ok") != (error is None) or (error and len(error) > 64):
        raise InvalidEvent("inconsistent outcome")
    connected = _bool(record, "connected")
    return NativeEvent(
        operation=operation, error=error, connected=connected,
        pending_open=_bool(record, "pendingOpen"), needs_reconnect=_bool(record, "needsReconnect"),
        descriptor=_descriptor(record.get("descriptor")), pending=_pending(record.get("pending")),
        last_unknown=_pending(record.get("lastUnknown")), admission=_admission(record.get("admission")),
        visible=_bool(record, "visible"),
        display=_display(record.get("display")) if connected else None,
        speech=_speech(record.get("speech")) if connected else None,
        events_skipped=_integer(record, "eventsSkipped", 0),
        invitation=_invitation(record.get("invitation")) if connected else None,
    )
