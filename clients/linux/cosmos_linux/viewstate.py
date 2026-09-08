"""Pure view-state mapping: wire facts in, the words on screen out.

Nothing here touches Qt or the native client, so every line the owner reads
is checked by a unit test. The controller stores the results in its State; the
QML reads them through the backend snapshot.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

from . import strings as S
from .events import PLATFORM, Confirmation, TurnStatus

# The destinations the shared library accepts. This computer is not one of
# them: a request that names the device it came from earns nothing in the
# runtime's ranking, so the picker offers the other screens and, first, no
# destination at all.
TARGETS = ("macos", "android", "android_tv")


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
    if status.state == "confirming":
        if here:
            return Line(S.WAITING_FOR_YOU, S.CONFIRM_HERE)
        return Line(S.WAITING_FOR_DEVICE, S.WAITING_FOR.format(device=device_name(status.surface_platform)))
    if status.state == "acting":
        if here:
            return Line(S.WORKING, S.ACTING_HERE)
        if status.surface_platform is None:
            return Line(S.WORKING)
        return Line(S.WORKING, S.ACTING_ON.format(device=device_name(status.surface_platform)))
    if status.state == "done":
        return Line(S.COMPLETED) if here else Line(
            S.COMPLETED, S.DONE_ON.format(device=device_name(status.surface_platform)))
    if status.state == "refused":
        # The origin learns that it did not happen, never why or where.
        return Line(S.NOT_DONE, S.NOT_DONE_ELSEWHERE)
    if status.state == "nowhere":
        return Line(S.CANNOT_CONFIRM, S.CANNOT_CONFIRM_DETAIL)
    return previous


# -- device actions ---------------------------------------------------------
# The phases a task passes through on this computer. `WORKING` means a launch
# is under way and claims nothing; every terminal phase is what was observed.
TASK_WORKING = "working"
TASK_DONE = "done"
TASK_REFUSED = "refused"
TASK_FAILED = "failed"
TASK_UNKNOWN = "unknown"
TASK_STOPPED = "stopped"

REFUSALS = {
    "no_handler": (S.REFUSAL_NO_HANDLER, S.REFUSAL_NO_HANDLER_REMEDY),
    "not_permitted": (S.REFUSAL_NOT_PERMITTED, S.REFUSAL_NOT_PERMITTED_REMEDY),
    "unresolvable": (S.REFUSAL_UNRESOLVABLE, S.REFUSAL_UNRESOLVABLE_REMEDY),
    "version_changed": (S.REFUSAL_VERSION_CHANGED, S.REFUSAL_VERSION_CHANGED_REMEDY),
}
UNSUPPORTED = {
    "route": S.UNSUPPORTED_ROUTE,
    "play": S.UNSUPPORTED_PLAY,
}


@dataclass(frozen=True)
class TaskView:
    """What this computer is doing, or did, about one command. ``elapsed`` is
    whole seconds from one clock: it ticks while the task runs and freezes when
    it ends, so the card never invents time."""

    action_id: str
    label: str
    phase: str
    elapsed: int = 0
    reason: Optional[str] = None
    unsupported: Optional[str] = None
    kind: str = "open"
    exit_code: Optional[int] = None

    @property
    def running(self) -> bool:
        return self.phase == TASK_WORKING


@dataclass(frozen=True)
class TaskCard:
    """The words on the card: the state word, one sentence, how long it has
    been going, and whether Cancel task applies."""

    title: str
    detail: str
    remedy: str = ""
    elapsed: str = ""
    cancellable: bool = False
    tone: str = "idle"


def elapsed_text(seconds: float) -> str:
    """m:ss from one clock, so the card never invents time."""
    total = max(0, int(seconds))
    if total < 3600:
        return f"{total // 60}:{total % 60:02d}"
    return f"{total // 3600}:{(total // 60) % 60:02d}:{total % 60:02d}"


def refusal_line(reason: Optional[str], unsupported: Optional[str] = None) -> tuple:
    """One sentence on what happened and one on what to do."""
    if unsupported is not None:
        return UNSUPPORTED.get(unsupported, S.UNSUPPORTED_OTHER), S.UNSUPPORTED_REMEDY
    return REFUSALS.get(reason or "", (S.REFUSAL_NOT_PERMITTED, S.REFUSAL_NOT_PERMITTED_REMEDY))


def task_card(task: Optional[TaskView]) -> Optional[TaskCard]:
    """The task card, or nothing at all when no command is in play."""
    if task is None:
        return None
    label = task.label
    duration = elapsed_text(task.elapsed)
    if task.kind == "run":
        if task.phase == TASK_WORKING:
            return TaskCard(S.WORKING, f"Running {label}", elapsed=duration, cancellable=True, tone="working")
        if task.phase == TASK_DONE:
            return TaskCard(S.COMPLETED, f"{label} finished with exit code {task.exit_code}.", elapsed=duration, tone="done")
        if task.phase == TASK_UNKNOWN:
            return TaskCard(S.CANNOT_CONFIRM, "The task outcome is unknown. It was not run again.", elapsed=duration, tone="error")
        if task.phase == TASK_FAILED:
            return TaskCard(S.NOT_DONE, "The task ended without a normal exit.", elapsed=duration, tone="error")
        if task.phase == TASK_REFUSED:
            detail = {"no_attestation": "This task has no current local confirmation.",
                      "entry_changed": "The approved task changed. Nothing was run.",
                      "no_handler": "The approved executable or folder is unavailable."}.get(task.reason, "This task is not permitted here.")
            return TaskCard(S.NOT_DONE, detail, "Review this computer's tasks in Center, then ask again.", tone="error")
    if task.phase == TASK_WORKING:
        return TaskCard(S.WORKING, S.TASK_OPENING.format(label=label), elapsed=duration,
                        cancellable=True, tone="working")
    if task.phase == TASK_DONE:
        detail = S.TASK_OPENED.format(label=label) if label else S.TASK_OPENED_PLAIN
        return TaskCard(S.COMPLETED, detail, elapsed=duration, tone="done")
    if task.phase == TASK_UNKNOWN:
        detail = S.TASK_UNKNOWN.format(label=label) if label else S.TASK_UNKNOWN_PLAIN
        return TaskCard(S.CANNOT_CONFIRM, detail, elapsed=duration, tone="error")
    if task.phase == TASK_STOPPED:
        return TaskCard(S.NOT_DONE, S.TASK_STOPPED, S.TASK_STOPPED_REMEDY, elapsed=duration, tone="error")
    if task.phase == TASK_FAILED:
        return TaskCard(S.NOT_DONE, S.TASK_FAILED, S.TASK_FAILED_REMEDY, elapsed=duration, tone="error")
    happened, remedy = refusal_line(task.reason, task.unsupported)
    return TaskCard(S.NOT_DONE, happened, remedy, tone="error")


def _sentence(value: str) -> str:
    """The runtime's own words, framed as the sentence they are. Nothing is
    reworded: only the first letter and the full stop are this client's."""
    text = value[:1].upper() + value[1:] if value else value
    return text if text.endswith((".", "?", "!")) else text + "."


@dataclass(frozen=True)
class Ceremony:
    """The owner's own words for the effect, two equal choices and a clock."""

    question: str
    effect: str
    note: str
    countdown: str
    seconds: int
    can_confirm: bool
    cannot_reason: str = ""


CONFIRM = "confirm"
DISMISS = "dismiss"
IGNORE = ""


def ceremony_key(name: str, can_confirm: bool) -> str:
    """What one key does to a ceremony, and nothing else does anything.

    Enter is the deliberate yes; Escape dismisses the panel and answers
    nothing at all, so the request runs out and denies by default. Every other
    key is ignored: a permission for a device that can act is never resolved by
    a stray keypress.
    """
    if name == "return":
        return CONFIRM if can_confirm else IGNORE
    if name == "escape":
        return DISMISS
    return IGNORE


def ceremony(confirmation: Optional[Confirmation], seconds: int = 0) -> Optional[Ceremony]:
    """The ceremony as this computer may honestly present it. Where the request
    needs evidence this desktop cannot produce, confirming is not offered at
    all — a keypress here would be a claim about a person."""
    if confirmation is None:
        return None
    description = confirmation.description
    remaining = max(0, int(seconds))
    can_confirm = confirmation.attestation == "foreground_tap"
    note = S.CONFIRM_CLASS_PRIVATE if description.privacy_class in ("near_user", "private") else ""
    return Ceremony(
        question=S.CONFIRM_QUESTION.format(verb=description.verb.capitalize(), subject=description.subject),
        effect=_sentence(description.effect),
        note=note,
        countdown=S.CONFIRM_COUNTDOWN.format(seconds=remaining),
        seconds=int(remaining),
        can_confirm=can_confirm,
        cannot_reason="" if can_confirm else S.CONFIRM_CANNOT,
    )


@dataclass(frozen=True)
class Destination:
    target: Optional[str]  # None names no destination: Cosmos chooses the screen
    name: str
    online: bool = True

    @property
    def chip(self) -> str:
        """What the chip says. Nothing at all while no destination is named."""
        return "" if self.target is None else S.DESTINATION_CHIP.format(name=self.name)


def destinations(members: Optional[Sequence[dict]] = None, platform: str = PLATFORM) -> tuple:
    """The picker entries, no destination first. Room members from a snapshot win when they
    exist (name, platform, online); otherwise the other kinds of device by friendly name.
    This computer is never an entry, because naming the asking device changes nothing."""
    entries = []
    if members:
        for member in members:
            target = member.get("platform")
            if target not in TARGETS or target == platform:
                continue
            name = str(member.get("name") or S.DESTINATION_NAMES.get(target, target))
            entries.append(Destination(target, name, bool(member.get("online", True))))
    if not entries:
        entries = [Destination(target, S.DESTINATION_NAMES[target])
                   for target in TARGETS if target != platform]
    return (Destination(None, S.ANY_DEVICE), *entries)


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
