"""The owner's permission, delivered by Cosmos, and what stays on this desktop.

Two different things meet in this module, and keeping them apart is the point.

**The permission comes from Cosmos.** The owner writes it once in Center, and
the runtime delivers that exact document to the installation it belongs to over
the connection it already holds, naming the surface and the approval revision
the connection was opened at. This client parses it, re-checks every bound the
runtime applied when the owner saved it, and refuses the whole document
otherwise. It is a copy, never an authority: a host, application or folder that
is not in it is refused whatever the runtime said, and while this installation
holds no copy it carries nothing out at all. It is never written to disk — it
is a cache of one revision, and a stale file is exactly the problem it
replaces.

**How this desktop opens a file stays here.** Which program opens a ``.pdf`` at
page 12, and which freedesktop entry starts an application, are facts about this
machine; Cosmos has no business holding them. They live in ``openers.json``
beside the journal, they are missing by default, and they grant nothing on
their own: only an application the delivered policy names is ever started, and
with no openers file this computer opens a document with the desktop's own
handler.

Nothing here shells out, imports Qt or touches the network; every rule is a
pure function with a unit test.
"""
from __future__ import annotations

import hashlib
import json
import os
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlsplit

from .native import MAX_POLICY_BYTES

# -- the local file ----------------------------------------------------------
OPENERS_FILE = "openers.json"
MAX_FILE_BYTES = 8192
MAX_OPENERS = 8
MAX_APPLICATIONS = 8
MAX_ARGV = 12
MAX_ARGUMENT_BYTES = 256
MAX_SUFFIXES = 8
# The placeholders an opener template may carry. Each is replaced with one
# value the runtime minted and this module re-validated; there is no shell and
# no other substitution.
PATH_TOKEN = "{path}"
LINE_TOKEN = "{line}"
PAGE_TOKEN = "{page}"
TOKENS = (PATH_TOKEN, LINE_TOKEN, PAGE_TOKEN)
# An opener runs an application, never an interpreter that would turn the rest
# of the line back into a command. There is no shell in this client.
SHELLS = frozenset({"sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "env", "xargs",
                    "python", "python3", "perl", "ruby", "node", "eval", "nohup", "setsid", "flatpak-spawn"})

# -- the delivered document --------------------------------------------------
# Byte-for-byte the bounds the runtime applies when the owner saves the policy.
MAX_HOSTS = 16
MAX_APPS = 8
MAX_ROOTS = 4
MAX_LABEL_BYTES = 120
MAX_PATH_BYTES = 256
MAX_ROOT_ID_BYTES = 32
MAX_RELATIVE_BYTES = 512
MAX_URL_BYTES = 2048
MAX_REVISION = 9_007_199_254_740_991
# The privacy ladder, lowest first. ``maximumClass`` is a ceiling the owner
# already spent; this copy can never raise it.
CLASSES = ("public", "shared_room", "near_user", "private")
# Navigation and playback are not implemented on this desktop.
UNDECLARED_SECTIONS = ("route", "play")


class InvalidPolicy(ValueError):
    """A document or file this client will not act on. It is refused whole."""


def _control(value: str) -> bool:
    return any(unicodedata.category(character) == "Cc" for character in value)


def _plain(value: object, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or _control(value):
        raise InvalidPolicy("a policy string is empty or carries control characters")
    if len(value.encode("utf-8")) > maximum:
        raise InvalidPolicy("a policy string is longer than this client accepts")
    return value


def valid_host(value: object) -> bool:
    """A bare registrable host: lowercase, no scheme, port, userinfo or path."""
    if not isinstance(value, str) or not 1 <= len(value) <= 253 or value != value.lower():
        return False
    if value.startswith(".") or value.endswith(".") or ".." in value:
        return False
    if any(character in value for character in ":/@?#\\ "):
        return False
    labels = value.split(".")
    if len(labels) < 2:
        return False
    return all(
        1 <= len(label) <= 63
        and not label.startswith("-")
        and not label.endswith("-")
        and all(character.isascii() and (character.isalnum() or character == "-") for character in label)
        for label in labels
    )


def valid_app_id(value: object) -> bool:
    """The wire's own application-id shape, re-checked locally."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= 128
        and not value.startswith(".")
        and not value.endswith(".")
        and all(character.isascii() and (character.isalnum() or character in "._-") for character in value)
    )


def valid_desktop_id(value: object) -> bool:
    """A freedesktop entry id this computer can hand to ``gio launch``."""
    return (
        isinstance(value, str)
        and value.endswith(".desktop")
        and 0 < len(value) <= 128
        and "/" not in value
        and not value.startswith(".")
        and all(character.isascii() and (character.isalnum() or character in "._-") for character in value)
    )


def valid_root_id(value: object) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= MAX_ROOT_ID_BYTES
        and all(character.isascii() and (character.islower() or character.isdigit() or character == "-")
                for character in value)
    )


def valid_relative(value: object) -> bool:
    """The wire's own relative-path shape: no escape, no absolute path, no tricks."""
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > MAX_RELATIVE_BYTES:
        return False
    if value.startswith("/") or "\\" in value or _control(value) or "\0" in value:
        return False
    return all(part and part not in (".", "..") for part in value.split("/"))


def valid_https(value: object) -> bool:
    """An https locator a desktop can open without ambiguity."""
    if not isinstance(value, str) or not value or len(value) > MAX_URL_BYTES or "\\" in value:
        return False
    if any(character.isspace() or _control(character) for character in value):
        return False
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        return False
    try:
        if parts.port is not None:
            return False
    except ValueError:
        return False
    return True


def host_of(url: str) -> Optional[str]:
    """The lowercase host of an https locator, or None when it is not one."""
    if not valid_https(url):
        return None
    return urlsplit(url).hostname


@dataclass(frozen=True)
class App:
    """One application the owner allowed. Which desktop entry starts it is this
    machine's own business and is not in this document."""

    id: str
    label: str


@dataclass(frozen=True)
class Root:
    """One directory the owner allowed, named by the id both installations share."""

    id: str
    label: str
    path: str


@dataclass(frozen=True)
class CommandEntry:
    """Fixed owner-authored arguments. Neither a model nor output can amend them."""

    id: str
    label: str
    argv: tuple
    cwd: str
    mutates: bool
    budget_ms: int

    @property
    def argv_digest(self) -> str:
        return _digest(["cosmos.device-command.argv", 1, self.argv, self.cwd])

    @property
    def entry_digest(self) -> str:
        return _digest(["cosmos.device-command.entry", 1, self.id, self.label,
                        self.argv_digest, self.mutates, self.budget_ms])


def _digest(value: list) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Policy:
    """The owner's own permission for this installation, as delivered.

    It exists only while the connection that carried it does. ``surface_id`` and
    ``approval_revision`` are the connection it belongs to; a document naming
    any other is not this installation's permission and was refused before one
    of these was built.
    """

    surface_id: str
    approval_revision: int
    revision: Optional[int] = None
    maximum_class: Optional[str] = None
    hosts: frozenset = frozenset()
    apps: tuple = ()
    roots: tuple = ()
    commands_revision: Optional[int] = None
    commands_class: Optional[str] = None
    offer_output_to_cognition: bool = False
    commands: tuple = ()

    def command(self, identifier: str) -> Optional[CommandEntry]:
        return next((entry for entry in self.commands if entry.id == identifier), None)

    def app(self, identifier: str) -> Optional[App]:
        for entry in self.apps:
            if entry.id == identifier:
                return entry
        return None

    def root(self, identifier: str) -> Optional[Root]:
        for entry in self.roots:
            if entry.id == identifier:
                return entry
        return None

    def allows_host(self, url: str) -> bool:
        """Exact host match only. A subdomain the owner did not write is not allowed."""
        host = host_of(url)
        return host is not None and host in self.hosts

    def allows_class(self, privacy: str, *, run: bool = False) -> bool:
        """The ceiling the owner already spent. A command routed above it is not
        the permission that was given, whatever the runtime said."""
        maximum = self.commands_class if run else self.maximum_class
        return maximum in CLASSES and privacy in CLASSES and CLASSES.index(privacy) <= CLASSES.index(maximum)


def _only(record: dict, allowed: set, label: str) -> None:
    if set(record) - allowed:
        raise InvalidPolicy(f"{label} carries a field this client does not understand")


def _object(value: object, label: str) -> dict:
    if not isinstance(value, dict):
        raise InvalidPolicy(f"{label} is not an object")
    return value


def _revision(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_REVISION:
        raise InvalidPolicy(f"{label} is not a revision")
    return value


def _entries(value: object, limit: int, label: str) -> list:
    if not isinstance(value, list) or len(value) > limit:
        raise InvalidPolicy(f"'{label}' must be a list of at most {limit} entries")
    return value


def parse_policy(raw: bytes, *, surface_id: str, approval_revision: int, digest: str) -> Policy:
    """The delivered document as this client will act on it, or nothing at all.

    It is refused whole — never half-read — when it is not the document the
    snapshot named, when it names another surface or another approval, when it
    carries a section this platform's manifest does not declare, or when it
    breaks one of the bounds the runtime itself applies at policy-write time.
    """
    if not isinstance(raw, (bytes, bytearray)) or not raw or len(raw) > MAX_POLICY_BYTES:
        raise InvalidPolicy("the delivered policy is empty or larger than this client holds")
    if hashlib.sha256(bytes(raw)).hexdigest() != digest:
        raise InvalidPolicy("the delivered policy is not the document the snapshot named")
    try:
        document = json.loads(bytes(raw).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise InvalidPolicy("the delivered policy is not UTF-8 JSON") from error
    document = _object(document, "the delivered policy")
    if type(document.get("version")) is not int or document["version"] != 1:
        raise InvalidPolicy("the delivered policy must be a version 1 object")
    _only(document, {"version", "surfaceId", "approvalRevision", "actions", "commands"}, "the delivered policy")
    if document.get("surfaceId") != surface_id or _revision(document.get("approvalRevision"),
                                                            "approvalRevision") != approval_revision:
        raise InvalidPolicy("the delivered policy names another surface or another approval")
    values = _parse_actions(document["actions"]) if "actions" in document else {}
    if "commands" in document:
        values.update(_parse_commands(document["commands"]))
    if not values:
        raise InvalidPolicy("the delivered policy has no permission")
    return Policy(surface_id=surface_id, approval_revision=approval_revision, **values)


def _parse_actions(value: object) -> dict:
    actions = _object(value, "'actions'")
    for section in UNDECLARED_SECTIONS:
        if section in actions:
            raise InvalidPolicy(f"'{section}' is not on this computer's manifest")
    _only(actions, {"revision", "maximumClass", "open"}, "'actions'")
    revision = _revision(actions.get("revision"), "the actions revision")
    maximum = actions.get("maximumClass")
    if maximum not in CLASSES:
        raise InvalidPolicy("'maximumClass' is not a class this client knows")
    section = _object(actions.get("open"), "'open'")
    _only(section, {"hosts", "apps", "roots"}, "'open'")
    hosts = _entries(section.get("hosts", []), MAX_HOSTS, "hosts")
    for host in hosts:
        if not valid_host(host):
            raise InvalidPolicy("a host must be a bare lowercase name like 'github.com'")
    if any(hosts[index] >= hosts[index + 1] for index in range(len(hosts) - 1)):
        raise InvalidPolicy("hosts arrive sorted and without repeats")
    apps = []
    for entry in _entries(section.get("apps", []), MAX_APPS, "apps"):
        entry = _object(entry, "an application entry")
        _only(entry, {"id", "label"}, "an application entry")
        if not valid_app_id(entry.get("id")):
            raise InvalidPolicy("an application id is not valid")
        apps.append(App(entry["id"], _plain(entry.get("label"), MAX_LABEL_BYTES)))
    roots = []
    for entry in _entries(section.get("roots", []), MAX_ROOTS, "roots"):
        entry = _object(entry, "a folder entry")
        _only(entry, {"id", "label", "path"}, "a folder entry")
        if not valid_root_id(entry.get("id")):
            raise InvalidPolicy("a folder id is lowercase letters, digits and dashes")
        path = _plain(entry.get("path"), MAX_PATH_BYTES)
        if not path.startswith("/") or ".." in path.split("/"):
            raise InvalidPolicy("a folder path must be absolute and carry no '..'")
        roots.append(Root(entry["id"], _plain(entry.get("label"), MAX_LABEL_BYTES), path))
    if len({entry.id for entry in apps}) != len(apps) or len({entry.id for entry in roots}) != len(roots):
        raise InvalidPolicy("application and folder ids are unique")
    if not hosts and not apps and not roots:
        raise InvalidPolicy("a delivered policy allows at least one host, application or folder")
    return dict(revision=revision, maximum_class=maximum, hosts=frozenset(hosts), apps=tuple(apps), roots=tuple(roots))


def _parse_commands(value: object) -> dict:
    section = _object(value, "'commands'")
    _only(section, {"revision", "maximumClass", "offerOutputToCognition", "entries"}, "'commands'")
    revision = _revision(section.get("revision"), "the commands revision")
    maximum = section.get("maximumClass")
    offer = section.get("offerOutputToCognition")
    if maximum not in CLASSES or type(offer) is not bool:
        raise InvalidPolicy("the command permission has an invalid ceiling or output choice")
    commands = []
    for value in _entries(section.get("entries"), 8, "commands"):
        entry = _object(value, "a command entry")
        _only(entry, {"id", "label", "argv", "cwd", "mutates", "budgetMs"}, "a command entry")
        identifier = _plain(entry.get("id"), 48)
        if any(not c.isascii() or not (c.islower() or c.isdigit() or c == "-") for c in identifier):
            raise InvalidPolicy("a command id is lowercase letters, digits and dashes")
        label = _plain(entry.get("label"), MAX_LABEL_BYTES)
        arguments = _entries(entry.get("argv"), MAX_ARGV, "argv")
        if not arguments or any(not isinstance(arg, str) or not arg or _control(arg)
                                or len(arg.encode("utf-8")) > MAX_ARGUMENT_BYTES for arg in arguments):
            raise InvalidPolicy("a command needs one to twelve bounded arguments")
        cwd = _plain(entry.get("cwd"), MAX_PATH_BYTES)
        if not cwd.startswith("/") or ".." in cwd.split("/") or ".." in arguments[0].split("/"):
            raise InvalidPolicy("a command working directory must be absolute and cannot escape")
        if entry.get("mutates") is not False:
            raise InvalidPolicy("this computer cannot authenticate file-changing commands")
        budget = _revision(entry.get("budgetMs"), "the command budget")
        if budget > 900_000:
            raise InvalidPolicy("a command budget exceeds fifteen minutes")
        commands.append(CommandEntry(identifier, label, tuple(arguments), cwd, False, budget))
    if not commands or len({entry.id for entry in commands}) != len(commands):
        raise InvalidPolicy("a command permission needs unique nonempty entries")
    return dict(commands_revision=revision, commands_class=maximum, offer_output_to_cognition=offer,
                commands=tuple(commands))


@dataclass(frozen=True)
class Opener:
    """One owner-authored way to open a file at a place. ``argv`` is fixed: the
    only substitutions are the validated path, line and page."""

    suffixes: tuple
    argv: tuple

    @property
    def program(self) -> str:
        return self.argv[0]

    @property
    def honours_line(self) -> bool:
        return any(LINE_TOKEN in argument for argument in self.argv)

    @property
    def honours_page(self) -> bool:
        return any(PAGE_TOKEN in argument for argument in self.argv)

    def matches(self, relative: str) -> bool:
        name = relative.rsplit("/", 1)[-1].lower()
        return any(name.endswith(suffix) for suffix in self.suffixes)

    def command(self, path: str, line: Optional[int] = None, page: Optional[int] = None) -> tuple:
        """The exact argv to run. Every placeholder is replaced with a value that
        was validated first; nothing else in the template changes."""
        values = {PATH_TOKEN: path, LINE_TOKEN: str(line or 1), PAGE_TOKEN: str(page or 1)}
        built = []
        for argument in self.argv:
            for token, value in values.items():
                argument = argument.replace(token, value)
            built.append(argument)
        return tuple(built)


@dataclass(frozen=True)
class Application:
    """Which freedesktop entry starts an application on this machine. It allows
    nothing: the delivered policy decides whether the application may start."""

    id: str
    desktop: str


@dataclass(frozen=True)
class Openers:
    """This desktop's own execution details, read from ``openers.json``."""

    openers: tuple = ()
    applications: tuple = ()
    loaded: bool = False
    # Set when a file existed but this client would not read it.
    error: Optional[str] = None

    def opener_for(self, relative: str) -> Optional[Opener]:
        for opener in self.openers:
            if opener.matches(relative):
                return opener
        return None

    def desktop_for(self, application_id: str) -> Optional[str]:
        for entry in self.applications:
            if entry.id == application_id:
                return entry.desktop
        return None


NO_OPENERS = Openers()


def _argv(value: object) -> tuple:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_ARGV:
        raise InvalidPolicy("an opener command must be a fixed array of 1 to 12 arguments")
    built = []
    for argument in value:
        built.append(_plain(argument, MAX_ARGUMENT_BYTES))
    program = built[0]
    if "/" in program and not program.startswith("/"):
        raise InvalidPolicy("an opener program is a bare name or an absolute path")
    for token in TOKENS:
        if token in program:
            raise InvalidPolicy("an opener program never carries a placeholder")
    if program.rsplit("/", 1)[-1] in SHELLS:
        raise InvalidPolicy("an opener runs an application, never a shell or an interpreter")
    if not any(PATH_TOKEN in argument for argument in built[1:]):
        raise InvalidPolicy("an opener must place the document with {path}")
    return tuple(built)


def _suffixes(value: object) -> tuple:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_SUFFIXES:
        raise InvalidPolicy("an opener declares one to eight file suffixes")
    built = []
    for suffix in value:
        text = _plain(suffix, 16).lower()
        if not text.startswith(".") or "/" in text:
            raise InvalidPolicy("a suffix looks like '.pdf'")
        built.append(text)
    return tuple(built)


def parse_openers(document: object) -> Openers:
    """The owner's own openers file as this client will act on it, or nothing."""
    document = _object(document, "the openers file")
    if document.get("version") != 1:
        raise InvalidPolicy("the openers file must be a version 1 object")
    _only(document, {"version", "openers", "applications"}, "the openers file")
    openers = []
    for entry in _entries(document.get("openers", []), MAX_OPENERS, "openers"):
        entry = _object(entry, "an opener entry")
        _only(entry, {"suffixes", "argv"}, "an opener entry")
        openers.append(Opener(_suffixes(entry.get("suffixes")), _argv(entry.get("argv"))))
    applications = []
    for entry in _entries(document.get("applications", []), MAX_APPLICATIONS, "applications"):
        entry = _object(entry, "an application entry")
        _only(entry, {"id", "desktop"}, "an application entry")
        if not valid_app_id(entry.get("id")):
            raise InvalidPolicy("an application id is not valid")
        if not valid_desktop_id(entry.get("desktop")):
            raise InvalidPolicy("a desktop entry id looks like 'dev.zed.Zed.desktop'")
        applications.append(Application(entry["id"], entry["desktop"]))
    if len({entry.id for entry in applications}) != len(applications):
        raise InvalidPolicy("application ids are unique")
    return Openers(tuple(openers), tuple(applications), loaded=True)


def load_openers(path: Path) -> Openers:
    """Read this machine's own openers. A missing file is ordinary: documents
    then open with the desktop's handler. An unreadable one says so."""
    try:
        raw = Path(path).read_bytes()
    except FileNotFoundError:
        return NO_OPENERS
    except OSError as error:
        return Openers(error=str(error.strerror or "unreadable"))
    if len(raw) > MAX_FILE_BYTES:
        return Openers(error="the openers file is larger than this client reads")
    try:
        return parse_openers(json.loads(raw.decode("utf-8")))
    except (UnicodeDecodeError, ValueError) as error:
        return Openers(error=str(error))


def openers_path(data_dir: Path) -> Path:
    return Path(data_dir) / OPENERS_FILE


@dataclass(frozen=True)
class Resolved:
    """A path under a declared root, proven to be inside it after every symlink
    was followed. ``reason`` names the refusal when there is no path."""

    path: Optional[str] = None
    root: Optional[Root] = None
    reason: Optional[str] = None


def resolve_under_root(policy: Optional[Policy], root_id: str, relative: str,
                       realpath: Callable[[str], str] = os.path.realpath,
                       is_file: Callable[[str], bool] = os.path.isfile) -> Resolved:
    """Join a runtime-minted relative path to the owner's own root and prove
    containment *after* resolving symlinks. A link that points out of the root
    is an escape and is refused; so is a root this installation was never given.
    """
    if not valid_root_id(root_id):
        return Resolved(reason="unresolvable")
    root = policy.root(root_id) if policy is not None else None
    if root is None:
        return Resolved(reason="not_permitted")
    if not valid_relative(relative):
        return Resolved(reason="unresolvable")
    base = realpath(root.path)
    candidate = realpath(os.path.join(base, relative))
    if candidate != base and not candidate.startswith(base.rstrip("/") + "/"):
        # A symlink inside the root pointed outside it. Refusing is the point.
        return Resolved(reason="unresolvable", root=root)
    if not is_file(candidate):
        return Resolved(reason="unresolvable", root=root)
    return Resolved(path=candidate, root=root)


def example_document() -> str:
    """The openers file, shown in the app. It allows nothing on its own: what
    this computer may open is the permission the owner gives it in Center."""
    return json.dumps({
        "version": 1,
        "openers": [
            {"suffixes": [".rs", ".py", ".md", ".txt"], "argv": ["code", "-g", "{path}:{line}"]},
            {"suffixes": [".pdf"], "argv": ["zathura", "-P", "{page}", "{path}"]},
        ],
        "applications": [{"id": "dev.zed.Zed", "desktop": "dev.zed.Zed.desktop"}],
    }, indent=2)
