"""This installation's own copy of the owner's device-action policy.

Cosmos may tell this computer to open something. It is not the authority on
whether that is allowed here: the owner wrote a policy for this installation,
and a host, application or root that is not in *this* file is refused whatever
the runtime said. That is the whole point of keeping a second copy — a
compromised or confused orchestrator cannot widen what this desktop will open.

The file lives beside the journal in the client's data directory
(``device-actions.json``). It is missing by default, and a missing file means
"open nothing", never "open anything". Nothing here shells out, imports Qt or
touches the network; every rule is a pure function with a unit test.
"""
from __future__ import annotations

import json
import os
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlsplit

POLICY_FILE = "device-actions.json"
MAX_FILE_BYTES = 8192
MAX_HOSTS = 16
MAX_APPS = 8
MAX_ROOTS = 4
MAX_OPENERS = 8
MAX_PATH_BYTES = 256
MAX_ARGV = 12
MAX_ARGUMENT_BYTES = 256
MAX_SUFFIXES = 8
MAX_URL_BYTES = 2048
MAX_RELATIVE_BYTES = 512
MAX_ROOT_ID_BYTES = 32
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


class InvalidPolicy(ValueError):
    """A policy file this client will not act on. It is refused whole."""


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
    """One application the owner allowed, and the desktop entry that opens it."""

    id: str
    label: str
    desktop: Optional[str] = None


@dataclass(frozen=True)
class Root:
    """One directory the owner allowed, named by the id both installations share."""

    id: str
    label: str
    path: str


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
class Policy:
    """What this installation may be asked to open. Empty by default."""

    hosts: frozenset = frozenset()
    apps: tuple = ()
    roots: tuple = ()
    openers: tuple = ()
    loaded: bool = False
    # Set when a file existed but this client would not act on it.
    error: Optional[str] = None

    @property
    def empty(self) -> bool:
        return not self.hosts and not self.apps and not self.roots

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

    def opener_for(self, relative: str) -> Optional[Opener]:
        for opener in self.openers:
            if opener.matches(relative):
                return opener
        return None


EMPTY_POLICY = Policy()


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


def parse(document: object) -> Policy:
    """The owner's file as this client will act on it, or nothing at all."""
    if not isinstance(document, dict) or document.get("version") != 1:
        raise InvalidPolicy("the policy file must be a version 1 object")
    section = document.get("open", {})
    if not isinstance(section, dict):
        raise InvalidPolicy("'open' must be an object")
    if set(document) - {"version", "open"} or set(section) - {"hosts", "apps", "roots", "openers"}:
        raise InvalidPolicy("the policy file carries fields this client does not understand")
    hosts = section.get("hosts", [])
    apps = section.get("apps", [])
    roots = section.get("roots", [])
    openers = section.get("openers", [])
    for value, limit, label in ((hosts, MAX_HOSTS, "hosts"), (apps, MAX_APPS, "apps"),
                                (roots, MAX_ROOTS, "roots"), (openers, MAX_OPENERS, "openers")):
        if not isinstance(value, list) or len(value) > limit:
            raise InvalidPolicy(f"'{label}' must be a list of at most {limit} entries")
    for host in hosts:
        if not valid_host(host):
            raise InvalidPolicy("a host must be a bare lowercase name like 'github.com'")
    parsed_apps = []
    for entry in apps:
        if not isinstance(entry, dict) or set(entry) - {"id", "label", "desktop"}:
            raise InvalidPolicy("an application entry is {id, label, desktop}")
        if not valid_app_id(entry.get("id")):
            raise InvalidPolicy("an application id is not valid")
        desktop = entry.get("desktop")
        if desktop is not None and not valid_desktop_id(desktop):
            raise InvalidPolicy("a desktop entry id looks like 'dev.zed.Zed.desktop'")
        parsed_apps.append(App(entry["id"], _plain(entry.get("label"), 120), desktop))
    parsed_roots = []
    for entry in roots:
        if not isinstance(entry, dict) or set(entry) - {"id", "label", "path"}:
            raise InvalidPolicy("a root entry is {id, label, path}")
        if not valid_root_id(entry.get("id")):
            raise InvalidPolicy("a root id is lowercase letters, digits and dashes")
        path = _plain(entry.get("path"), MAX_PATH_BYTES)
        if not path.startswith("/") or path != os.path.normpath(path):
            raise InvalidPolicy("a root path must be absolute and already normalised")
        parsed_roots.append(Root(entry["id"], _plain(entry.get("label"), 120), path))
    if len({entry.id for entry in parsed_roots}) != len(parsed_roots):
        raise InvalidPolicy("root ids must be unique")
    if len({entry.id for entry in parsed_apps}) != len(parsed_apps):
        raise InvalidPolicy("application ids must be unique")
    parsed_openers = []
    for entry in openers:
        if not isinstance(entry, dict) or set(entry) - {"suffixes", "argv"}:
            raise InvalidPolicy("an opener entry is {suffixes, argv}")
        parsed_openers.append(Opener(_suffixes(entry.get("suffixes")), _argv(entry.get("argv"))))
    return Policy(frozenset(hosts), tuple(parsed_apps), tuple(parsed_roots), tuple(parsed_openers), loaded=True)


def load(path: Path) -> Policy:
    """Read the owner's file. A missing file allows nothing; an unreadable or
    unacceptable one allows nothing and says so."""
    try:
        raw = Path(path).read_bytes()
    except FileNotFoundError:
        return EMPTY_POLICY
    except OSError as error:
        return Policy(error=str(error.strerror or "unreadable"))
    if len(raw) > MAX_FILE_BYTES:
        return Policy(error="the policy file is larger than this client reads")
    try:
        return parse(json.loads(raw.decode("utf-8")))
    except (UnicodeDecodeError, ValueError) as error:
        return Policy(error=str(error))


def policy_path(data_dir: Path) -> Path:
    return Path(data_dir) / POLICY_FILE


@dataclass(frozen=True)
class Resolved:
    """A path under a declared root, proven to be inside it after every symlink
    was followed. ``reason`` names the refusal when there is no path."""

    path: Optional[str] = None
    root: Optional[Root] = None
    reason: Optional[str] = None


def resolve_under_root(policy: Policy, root_id: str, relative: str,
                       realpath: Callable[[str], str] = os.path.realpath,
                       is_file: Callable[[str], bool] = os.path.isfile) -> Resolved:
    """Join a runtime-minted relative path to the owner's own root and prove
    containment *after* resolving symlinks. A link that points out of the root
    is an escape and is refused; so is a root this installation never declared.
    """
    if not valid_root_id(root_id):
        return Resolved(reason="unresolvable")
    root = policy.root(root_id)
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
    """The file the owner writes, shown in the app when nothing is allowed yet."""
    return json.dumps({
        "version": 1,
        "open": {
            "hosts": ["github.com"],
            "apps": [{"id": "dev.zed.Zed", "label": "Zed", "desktop": "dev.zed.Zed.desktop"}],
            "roots": [{"id": "repo", "label": "Projects", "path": "/home/you/GitHub"}],
            "openers": [
                {"suffixes": [".rs", ".py", ".md", ".txt"], "argv": ["code", "-g", "{path}:{line}"]},
                {"suffixes": [".pdf"], "argv": ["zathura", "-P", "{page}", "{path}"]},
            ],
        },
    }, indent=2)
