"""Shared fakes: a native surface, a scheduler, a player and an identity."""
from __future__ import annotations

import hashlib
import json
import uuid
from collections import deque
from typing import Callable, Optional

from cosmos_linux.endpoint import base64url
from cosmos_linux.events import APPROVAL_PROFILE, PLATFORM
from cosmos_linux.native import OK, UNAVAILABLE, Features, NativeError

ENROLLMENT_ID = "6f0f4c6a-6d4d-4a1e-9f7c-1d2a3b4c5d6e"
BOOT_EPOCH = "0b1e2d3c-4a5f-4e6d-8c7b-9a0f1e2d3c4b"
PUBLIC_KEY_SEC1 = b"\x04" + hashlib.sha512(b"cosmos-linux-test-key").digest()
PUBLIC_KEY = base64url(PUBLIC_KEY_SEC1)
TURN_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
ACTION_ID = "0d3b5f2e-8a4c-4f1a-9b6d-2e7c8a9f0b1c"
SPEECH_ID = "7c6b5a49-3827-4c1d-9e0f-a1b2c3d4e5f6"
DIGEST = "c" * 64


def descriptor() -> dict:
    return {"enrollmentId": ENROLLMENT_ID, "publicKey": PUBLIC_KEY, "platform": PLATFORM,
            "approval": APPROVAL_PROFILE}


def snapshot(operation: str, **overrides) -> dict:
    value = {
        "version": 1, "kind": "state", "operation": operation, "outcome": "ok", "error": None,
        "connected": False, "pendingOpen": False, "needsReconnect": True, "descriptor": descriptor(),
        "pending": None, "lastUnknown": None, "admission": None, "visible": False, "display": None,
        "speech": None, "eventsSkipped": 0,
    }
    value.update(overrides)
    if value["error"] is not None:
        value["outcome"] = "error"
    return value


def encode(value: dict) -> bytes:
    return json.dumps(value).encode("utf-8")


def text_card(action_id: str = ACTION_ID, text: str = "Hello from Cosmos") -> dict:
    return {"actionId": action_id, "turnId": TURN_ID, "generation": 2, "contentDigest": DIGEST,
            "expiresAtMs": 1_900_000_000_000, "content": {"kind": "text", "text": text}, "credits": []}


def choices_card(action_id: str = ACTION_ID, count: int = 3) -> dict:
    items = [{"id": str(index + 1), "title": f"Option {index + 1}", "detail": "" if index else "Best match"}
             for index in range(count)]
    return {"actionId": action_id, "turnId": TURN_ID, "generation": 2, "contentDigest": DIGEST,
            "expiresAtMs": 1_900_000_000_000,
            "content": {"kind": "choices", "title": "Which one?", "items": items}, "credits": []}


def status(state: str = "working", platform=None, turn_id: str = TURN_ID) -> dict:
    return {"turnId": turn_id, "generation": 2, "state": state, "surfacePlatform": platform,
            "privacy": "shared_room"}


def places_card(action_id: str = ACTION_ID) -> dict:
    return {
        "actionId": action_id, "turnId": TURN_ID, "generation": 2, "contentDigest": DIGEST,
        "expiresAtMs": 1_900_000_000_000,
        "content": {"kind": "places", "query": "coffee", "items": [
            {"placeId": "p1", "name": "Prolog", "address": "Høkerboderne 16", "sourceUrl": "https://maps.google.com/?cid=1"},
            {"placeId": "p2", "name": "Andersen", "address": "Nørrebrogade 62", "sourceUrl": None},
        ], "attributions": ["Data from Google Maps"]},
        "credits": [[{"kind": "text", "text": "Data from "}, {"kind": "link", "text": "Google Maps", "href": "https://maps.google.com/"}]],
    }


def speech_reply(action_id: str = SPEECH_ID, byte_length: int = 5) -> dict:
    return {"actionId": action_id, "turnId": TURN_ID, "generation": 2, "contentDigest": DIGEST,
            "expiresAtMs": 1_900_000_000_000, "text": "Spoken reply", "format": "audio/mpeg",
            "byteLength": byte_length}


TASK_ID = "2f1c8a90-4d5e-4a6b-8c7d-9e0f1a2b3c4d"
GRANT_ID = "e5aa1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c"
SURFACE_ID = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
APPROVAL_REVISION = 4


def policy_document(hosts=("github.com",), apps=(), roots=(), surface_id: str = SURFACE_ID,
                    approval_revision: int = APPROVAL_REVISION, revision: int = 3,
                    maximum_class: str = "private", **extra) -> bytes:
    """The owner's own permission for this installation, in the runtime's own
    compact serialization and declaration order — the bytes both sides hash."""
    section = {}
    if hosts:
        section["hosts"] = sorted(hosts)
    if apps:
        section["apps"] = [dict(entry) for entry in apps]
    if roots:
        section["roots"] = [dict(entry) for entry in roots]
    document = {"version": 1, "surfaceId": surface_id, "approvalRevision": approval_revision,
                "actions": {"revision": revision, "maximumClass": maximum_class, "open": section}}
    document.update(extra)
    return json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def policy_record(document: bytes, **overrides) -> dict:
    """What the snapshot says about that document: its identity and its length,
    never its bytes."""
    parsed = json.loads(document.decode("utf-8"))
    actions = parsed.get("actions") or {}
    record = {
        "surfaceId": parsed.get("surfaceId"), "approvalRevision": parsed.get("approvalRevision"),
        "actionsRevision": actions.get("revision"), "commandsRevision": None,
        "digest": hashlib.sha256(document).hexdigest(), "byteLength": len(document),
    }
    record.update(overrides)
    return record


def open_task(operation: Optional[dict] = None, action_id: str = TASK_ID, key: str = "d" * 64,
              privacy: str = "private", channel: str = "action.open") -> dict:
    """One `action.open` command, with the digest the runtime would have bound."""
    from cosmos_linux.actions import content_digest
    operation = operation if operation is not None else {
        "kind": "open", "locator": {"scheme": "https", "url": "https://github.com/owner/repo/pull/412"},
        "label": "PR 412",
    }
    return {"actionId": action_id, "turnId": TURN_ID, "generation": 3, "channel": channel,
            "contentDigest": content_digest(operation) or DIGEST, "idempotencyKey": key,
            "operation": operation, "expiresAtMs": 1_900_000_000_000, "reportByMs": 1_900_000_010_000,
            "privacy": privacy}


def confirmation(attestation: str = "foreground_tap", expires_at_ms: int = 1_900_000_030_000,
                 digest: Optional[str] = None) -> dict:
    """One ceremony whose digest binds its own words, the way the runtime mints it."""
    from cosmos_linux.actions import confirmation_digest
    description = {"kind": "device_action", "verb": "open", "subject": "state.rs", "deviceKind": "linux",
                   "effect": "opens that document on this computer", "class": "private"}
    return {"grantId": GRANT_ID, "actionId": TASK_ID, "turnId": TURN_ID, "generation": 3,
            "description": description,
            "descriptionDigest": digest if digest is not None else confirmation_digest(description),
            "risk": "moderate", "attestation": attestation, "privacy": "private",
            "expiresAtMs": expires_at_ms}


def revoked(reason: str = "cancelled", action_id: str = TASK_ID) -> dict:
    return {"actionId": action_id, "reason": reason}


def admission(turn_id: str = TURN_ID) -> dict:
    return {"turnId": turn_id, "generation": 2, "duplicate": False}


class FakeIdentity:
    enrollment_id = uuid.UUID(ENROLLMENT_ID)

    def public_key_sec1(self) -> bytes:
        return PUBLIC_KEY_SEC1

    def sign_sha256(self, message: bytes) -> bytes:
        return b"\x30\x06\x02\x01\x01\x02\x01\x01"


class FakeJournal:
    def __init__(self) -> None:
        self.data: Optional[bytes] = None

    def read(self) -> Optional[bytes]:
        return self.data

    def write_atomically(self, journal: bytes) -> None:
        self.data = bytes(journal)


class FakeSurface:
    """Records commands and hands out queued snapshots like the C worker would."""

    instances: list = []
    features = Features(targets=True, context=True, actions=True)

    def __init__(self, config: bytes, platform) -> None:
        self.config = json.loads(config.decode("utf-8"))
        self.platform = platform
        self.commands: list = []
        self.queue: deque = deque()
        self.audio = b""
        # The owner's policy document the worker published, if one is held.
        self.policy: Optional[bytes] = None
        self.destroyed = False
        self.callback_failure: Optional[str] = None
        self.refuse: dict = {}
        FakeSurface.instances.append(self)

    def emit(self, value: dict) -> None:
        self.queue.append(encode(value))

    def take_callback_failure(self) -> Optional[str]:
        failure, self.callback_failure = self.callback_failure, None
        return failure

    def _command(self, name: str, *arguments) -> int:
        self.commands.append((name, *arguments) if arguments else name)
        return self.refuse.get(name, OK)

    def connect(self) -> int:
        return self._command("connect")

    def send_text(self, text: str) -> int:
        return self._command("send_text", text)

    def send_text_to(self, text: str, target) -> int:
        if not self.features.targets:
            return UNAVAILABLE
        return self._command("send_text_to", text, target)

    def send_text_with_context(self, text: str, app: str, context: str, target) -> int:
        if not self.features.context:
            return UNAVAILABLE
        return self._command("send_text_with_context", text, app, context, target)

    def retry_pending(self) -> int:
        return self._command("retry_pending")

    def cancel(self) -> int:
        return self._command("cancel")

    def set_visible(self, visible: bool) -> int:
        return self._command("set_visible", visible)

    def acknowledge(self) -> int:
        return self._command("acknowledge")

    def acknowledge_speech(self) -> int:
        return self._command("acknowledge_speech")

    def acknowledge_task(self) -> int:
        if not self.features.actions:
            return UNAVAILABLE
        return self._command("acknowledge_task")

    def report(self, action_id: str, report: bytes) -> int:
        if not self.features.actions:
            return UNAVAILABLE
        return self._command("report", json.loads(bytes(report).decode("utf-8")), action_id)

    def grant(self, granted: bool, attestation) -> int:
        if not self.features.actions:
            return UNAVAILABLE
        return self._command("grant", granted, attestation)

    def disconnect(self) -> int:
        return self._command("disconnect")

    def poll(self) -> Optional[bytes]:
        if self.destroyed:
            raise NativeError(-3, "poll")
        return self.queue.popleft() if self.queue else None

    def speech_audio(self, expected_length: int) -> bytes:
        if len(self.audio) != expected_length:
            raise NativeError(1, "speech_audio")
        return self.audio

    def device_policy(self, expected_length: int) -> Optional[bytes]:
        if not self.features.actions or self.policy is None:
            return None
        if len(self.policy) != expected_length:
            raise NativeError(2, "device_policy")
        return self.policy

    def destroy(self) -> int:
        self.destroyed = True
        return OK


class FakeScheduler:
    def __init__(self) -> None:
        self.now = 1000.0
        self.timers: list = []
        self._next = 0

    def call_later(self, delay: float, callback: Callable[[], None]) -> object:
        self._next += 1
        handle = (self.now + delay, self._next, callback)
        self.timers.append(handle)
        return handle

    def cancel(self, handle: object) -> None:
        self.timers = [timer for timer in self.timers if timer is not handle]

    def monotonic(self) -> float:
        return self.now

    def pending_delays(self) -> list:
        return [round(due - self.now, 3) for due, _, _ in sorted(self.timers)]

    def advance(self, seconds: float) -> None:
        self.now += seconds
        while True:
            due = [timer for timer in self.timers if timer[0] <= self.now]
            if not due:
                return
            for timer in sorted(due):
                self.timers.remove(timer)
                timer[2]()


class FakePlayer:
    def __init__(self) -> None:
        self.played: list = []
        self.stopped = 0
        self._finish: Optional[Callable[[bool], None]] = None
        self.reject = False

    def play(self, reply, audio: bytes, on_finished: Callable[[bool], None]) -> bool:
        if self.reject:
            return False
        self.played.append((reply, audio))
        self._finish = on_finished
        return True

    def finish(self, completed: bool) -> None:
        callback, self._finish = self._finish, None
        if callback is not None:
            callback(completed)

    def stop(self) -> None:
        self.stopped += 1
        self._finish = None


class FakeLauncher:
    """A launcher that starts nothing and reports exactly what a test says it saw."""

    def __init__(self) -> None:
        self.started: list = []
        self.stopped = 0
        self._result = None
        self._busy = False

    @property
    def busy(self) -> bool:
        return self._busy

    def start(self, launch) -> None:
        self.started.append(launch)
        self._busy = True

    def observe(self, observation) -> None:
        self._result = observation
        self._busy = False

    def poll(self):
        result, self._result = self._result, None
        return result

    def stop(self) -> None:
        self.stopped += 1
        if self._busy:
            from cosmos_linux.actions import STOPPED, Observation
            self._result = Observation(STOPPED)
            self._busy = False
