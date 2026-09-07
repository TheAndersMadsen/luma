"""Pure view-state mapping: wire facts in, the words on screen out.

Nothing here touches Qt or the native client, so every line the owner reads
is checked by a unit test. The controller stores the results in its State; the
QML reads them through the backend snapshot.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

from . import strings as S
from .events import PLATFORM, TurnStatus

# The destinations the shared library accepts, in the order the picker lists them.
TARGETS = ("linux", "macos", "android", "android_tv")


@dataclass(frozen=True)
class Line:
    """A headline from the state vocabulary and a plain sentence under it."""

    title: str = ""
    detail: str = ""

    @property
    def text(self) -> str:
        return " · ".join(part for part in (self.title, self.detail) if part)


EMPTY_LINE = Line()


def device_name(platform: Optional[str]) -> str:
    return S.DEVICE_NAMES.get(platform or "", S.A_DEVICE)


def status_line(status: Optional[TurnStatus], previous: Line, platform: str = PLATFORM) -> Line:
    """The line for the runtime's committed status. ``unknown`` keeps the previous line;
    no status at all clears it."""
    if status is None:
        return EMPTY_LINE
    here = status.surface_platform == platform
    if status.state == "working":
        return Line(S.WORKING)
    if status.state == "waiting":
        if here:
            return Line(S.WAITING_FOR_YOU)
        if status.surface_platform is None:
            return Line(S.WAITING_FOR_DEVICE)
        return Line(S.WAITING_FOR_DEVICE, S.WAITING_FOR.format(device=device_name(status.surface_platform)))
    if status.state == "shown":
        return Line(S.COMPLETED) if here else Line(S.COMPLETED, S.SHOWN_ON.format(device=device_name(status.surface_platform)))
    if status.state == "spoken":
        return Line(S.COMPLETED) if here else Line(S.COMPLETED, S.SPOKEN_ON.format(device=device_name(status.surface_platform)))
    if status.state == "nowhere":
        return Line(S.CANNOT_CONFIRM, S.CANNOT_CONFIRM_DETAIL)
    return previous


@dataclass(frozen=True)
class Destination:
    target: Optional[str]  # None sends without an explicit destination (this screen)
    name: str
    online: bool = True

    @property
    def chip(self) -> str:
        return S.DESTINATION_CHIP.format(name=self.name)


def destinations(members: Optional[Sequence[dict]] = None, platform: str = PLATFORM) -> tuple:
    """The picker entries. Room members from a snapshot win when they exist (name, platform,
    online); otherwise the known kinds of device by friendly name, this screen first."""
    entries = []
    if members:
        for member in members:
            target = member.get("platform")
            if target not in TARGETS:
                continue
            name = str(member.get("name") or S.DESTINATION_NAMES.get(target, target))
            entries.append(Destination(None if target == platform else target,
                                       S.THIS_SCREEN if target == platform else name,
                                       bool(member.get("online", True))))
    if not entries:
        entries = [Destination(None if target == platform else target,
                               S.THIS_SCREEN if target == platform else S.DESTINATION_NAMES[target])
                   for target in TARGETS]
    entries.sort(key=lambda entry: entry.target is not None)
    return tuple(entries)


def destination_for(target: Optional[str], members: Optional[Sequence[dict]] = None) -> Destination:
    for entry in destinations(members):
        if entry.target == target:
            return entry
    return destinations(members)[0]


def context_label(app: str) -> str:
    return S.USING_SELECTION.format(app=app)


def example_prompts(has_screen_context: bool) -> tuple:
    prompts = [S.EXAMPLE_CAFES, S.EXAMPLE_NOTES]
    if has_screen_context:
        prompts.append(S.EXAMPLE_SCREEN)
    return tuple(prompts)


def choice_for_key(key: str, count: int) -> Optional[int]:
    """The zero-based item a digit key picks, or None when it names no item."""
    if len(key) != 1 or not key.isdigit():
        return None
    index = int(key) - 1
    return index if 0 <= index < count else None
