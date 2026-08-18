#!/usr/bin/env python3
"""Fail-closed state helper for the public Center edge and Keycloak client."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path, PurePosixPath


SCHEMA = 1
CANONICAL_ORIGIN = "https://center.andersmadsen.dk"
LEGACY_ORIGIN = "https://cosmos.andersmadsen.dk"
AVAILABLE = "/etc/nginx/sites-available/ai-pin-revival-center"
ENABLED = "/etc/nginx/sites-enabled/ai-pin-revival-center"
# The public :443 owner. It lives in Nginx's `stream` context, not `http`: the
# Pin authenticates to Envoy with a client certificate and Envoy must remain the
# only TLS peer, so this listener reads the SNI and copies bytes.  Center's own
# TLS listener moved to LOCAL_TLS_PORT, which the stream feeds for every SNI that
# is not a clone gateway.
STREAM_ENABLED = "/etc/nginx/streams-enabled/ai-pin-revival-device-edge.conf"
LOCAL_TLS_PORT = "8444"
LOCAL_TLS_BACKEND = f"127.0.0.1:{LOCAL_TLS_PORT}"
# Envoy's published mTLS edge (compose maps 127.0.0.1:18443 -> the container's
# 8443).  Keep in step with REVIVAL_EDGE_PORT in platform/compose/production.yaml.
DEVICE_EDGE_BACKEND = "127.0.0.1:18443"
CLOUDFLARED_CONFIG = "/home/anders/.cloudflared/config.yml"
TOKENS = {
    "REVIVAL_CENTER_PORT": 1,
    "REVIVAL_KEYCLOAK_PORT": 1,
    "REVIVAL_PUBLIC_TLS_CERTIFICATE": 2,
    "REVIVAL_PUBLIC_TLS_PRIVATE_KEY": 2,
    "REVIVAL_LOCAL_TLS_PORT": 2,
}
STREAM_TOKENS = {
    "REVIVAL_DEVICE_EDGE_BACKEND": 1,
    "REVIVAL_LOCAL_TLS_BACKEND": 1,
}


def die(message: str) -> "NoReturn":
    raise SystemExit(message)


def read_json(path: Path, maximum: int = 2 * 1024 * 1024) -> object:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        die(f"unsafe JSON input: {path}")
    if metadata.st_size <= 0 or metadata.st_size > maximum:
        die(f"JSON input has an unsafe size: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        die(f"invalid JSON input {path}: {error}")


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_regular(path: Path, value: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists() or temporary.is_symlink():
            temporary.unlink()


def assert_safe_logical_path(value: str, parent: str | None = None) -> None:
    if not value.startswith("/") or not re.fullmatch(r"/[A-Za-z0-9_./+@-]+", value):
        die(f"unsafe absolute path: {value}")
    if "//" in value or "/../" in f"{value}/" or "/./" in f"{value}/":
        die(f"non-canonical path: {value}")
    if parent and not value.startswith(parent.rstrip("/") + "/"):
        die(f"path leaves {parent}: {value}")


def rooted(logical: str, root: Path | None) -> Path:
    assert_safe_logical_path(logical)
    if root is None:
        return Path(logical)
    resolved_root = root.resolve()
    # Keep the final object unresolved so lstat can distinguish a symlink from
    # its target.  ``assert_safe_logical_path`` has already excluded dot and
    # parent components, which makes this lexical join containment-safe.
    components = PurePosixPath(logical).parts[1:]
    if not components:
        die("test filesystem path cannot name its root")
    return resolved_root.joinpath(*components)


def discovery_document(path: Path) -> dict[str, object]:
    document = read_json(path)
    if not isinstance(document, dict) or set(document) != {
        "schemaVersion", "kind", "legacyEnabledPath", "certificatePath", "privateKeyPath"
    }:
        die("public edge discovery schema mismatch")
    if document["schemaVersion"] != SCHEMA or document["kind"] != "center-public-edge":
        die("public edge discovery version mismatch")
    for key in ("legacyEnabledPath", "certificatePath", "privateKeyPath"):
        if not isinstance(document[key], str):
            die(f"public edge discovery {key} is invalid")
    assert_safe_logical_path(str(document["legacyEnabledPath"]), "/etc/nginx/sites-enabled")
    assert_safe_logical_path(str(document["certificatePath"]))
    assert_safe_logical_path(str(document["privateKeyPath"]))
    return document


# A directive starts at a line start or straight after `{` or `;`, so a one-line
# `server { listen 443; }` counts exactly like an indented one — this gate is
# worthless if a socket owner can hide behind formatting. Whole-line comments are
# removed first: the stock Ubuntu vhost keeps a commented-out
# `listen 443 ssl default_server;` that must never be counted.
LISTEN_DIRECTIVE = re.compile(r"(?m)(?:^|[{;])[ \t]*listen[ \t]+([^;#{}\n]+);")


def without_comment_lines(body: str) -> str:
    return "\n".join("" if line.lstrip().startswith("#") else line for line in body.splitlines())


def expanded_sections(path: Path) -> dict[str, str]:
    """Split `nginx -T` output into {configuration file: body}."""
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_size > 8 * 1024 * 1024:
        die("nginx expanded configuration input is unsafe")
    sections: dict[str, list[str]] = {}
    current: str | None = None
    marker = re.compile(r"^# configuration file (/[^:]+):\s*$")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = marker.match(line)
        if match:
            current = match.group(1)
            sections.setdefault(current, [])
        elif current is not None:
            sections[current].append(line)
    return {filename: "\n".join(lines) for filename, lines in sections.items()}


def listen_endpoint(directive: str, origin: str) -> tuple[str, int]:
    """Resolve one `listen` directive to the (address, port) it binds.

    Fail closed rather than guess.  This function decides whether two files are
    about to claim the same socket, and an endpoint measured wrongly is worse
    than a deploy that stops and names the directive it could not read.
    """
    parameters = directive.split()
    token = parameters[0]
    if token.startswith("unix:"):
        return ("unix", 0)
    bracketed = re.fullmatch(r"\[([0-9A-Fa-f:.]+)\]:(\d{1,5})", token)
    if bracketed:
        return (bracketed.group(1), int(bracketed.group(2)))
    if re.fullmatch(r"\d{1,5}", token):
        return ("*", int(token))
    pair = re.fullmatch(r"([0-9A-Za-z_.*-]+):(\d{1,5})", token)
    if pair:
        return (pair.group(1), int(pair.group(2)))
    # `listen <address>;` with no port means 80 in Nginx.  Accept that, because
    # it is common and can never be a :443 owner, but refuse the same shape with
    # `ssl`, where assuming a port would be exactly the guess this must not make.
    if re.fullmatch(r"[0-9A-Za-z_.*-]+", token) and "ssl" not in parameters[1:]:
        return (token, 80)
    die(f"unreadable listen directive in {origin}: listen {directive.strip()}")


def is_public_endpoint(address: str) -> bool:
    if address in ("*", "0.0.0.0", "::", "unix"):
        return address != "unix"
    if address == "localhost":
        return False
    try:
        return not ipaddress.ip_address(address).is_loopback
    except ValueError:
        return True


def public_443_bindings(body: str, origin: str) -> list[str]:
    bindings = []
    for match in LISTEN_DIRECTIVE.finditer(without_comment_lines(body)):
        address, port = listen_endpoint(match.group(1), origin)
        if port == 443 and is_public_endpoint(address):
            bindings.append(match.group(1).strip())
    return bindings


def nginx_assert_443_owner(args: argparse.Namespace) -> None:
    """Require exactly one file in the expanded configuration to bind public :443.

    `nginx -t` does not detect this.  An `http` server on 0.0.0.0:443 and a
    `stream` server on :443 test clean and the master then fails to bind at
    reload, taking every vhost on the host down with it — that is what happened
    the last time this port was rearranged.  `nginx -T` reads the configuration
    from disk without applying it, so running this between `nginx -t` and the
    reload turns a total-ingress outage into a failed deploy step with the live
    process still serving its previous configuration.

    Two owners is the collision.  Zero owners is the other half of the same bug:
    the vhost moved to its loopback port and nothing took over the public bind,
    so :443 silently stops answering.  Both are refused here.
    """
    sections = expanded_sections(Path(args.input))
    owners = {
        filename: bindings
        for filename, body in sections.items()
        if (bindings := public_443_bindings(body, filename))
    }
    if not owners:
        die(
            "no file in the expanded Nginx configuration binds the public :443; "
            "the device edge stream and Center's TLS listener cannot both be absent"
        )
    if len(owners) > 1:
        detail = "; ".join(f"{name}: {', '.join(bindings)}" for name, bindings in sorted(owners.items()))
        die(
            "the public :443 has more than one owner in the expanded Nginx "
            f"configuration and the master will fail to bind at reload -> {detail}. "
            "A vhost that needs TLS must listen on the loopback port the device "
            "edge stream forwards to, not on :443."
        )
    owner = next(iter(owners))
    if STREAM_ENABLED in sections and owner != STREAM_ENABLED:
        die(f"the device edge stream is installed but {owner} owns the public :443")
    if owner == STREAM_ENABLED and not re.search(r"(?m)^[ \t]*ssl_preread[ \t]+on;", sections[owner]):
        die(
            "the device edge stream owns the public :443 without ssl_preread, so "
            "it cannot route by SNI and mTLS would not survive the hop"
        )
    print(f"public :443 owner: {owner} ({', '.join(owners[owner])})")


def discover_nginx(args: argparse.Namespace) -> None:
    source = Path(args.input)
    sections = expanded_sections(source)
    candidates: list[tuple[str, str, str]] = []
    for filename, body in sections.items():
        if not filename.startswith("/etc/nginx/sites-enabled/"):
            continue
        names = [
            token
            for directive in re.findall(r"(?m)^\s*server_name\s+([^;]+);", body)
            for token in directive.split()
        ]
        if "cosmos.andersmadsen.dk" not in names:
            continue
        certificates = set(re.findall(r"(?m)^\s*ssl_certificate\s+([^;\s]+)\s*;", body))
        private_keys = set(re.findall(r"(?m)^\s*ssl_certificate_key\s+([^;\s]+)\s*;", body))
        if len(certificates) != 1 or len(private_keys) != 1:
            die(f"Cosmos TLS vhost does not expose one certificate pair: {filename}")
        candidates.append((filename, certificates.pop(), private_keys.pop()))
    unique = sorted(set(candidates))
    if len(unique) != 1:
        die(f"expected one enabled Cosmos TLS vhost, found {len(unique)}")
    enabled, certificate, private_key = unique[0]
    document = {
        "schemaVersion": SCHEMA,
        "kind": "center-public-edge",
        "legacyEnabledPath": enabled,
        "certificatePath": certificate,
        "privateKeyPath": private_key,
    }
    output = Path(args.output)
    atomic_regular(output, canonical_json(document))
    discovery_document(output)


def object_record(path: Path, logical: str, snapshot: Path | None = None) -> dict[str, object]:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return {"path": logical, "type": "absent"}
    common: dict[str, object] = {
        "path": logical,
        "mode": stat.S_IMODE(metadata.st_mode),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
    }
    if stat.S_ISREG(metadata.st_mode):
        common.update({"type": "regular", "size": metadata.st_size, "sha256": sha256_file(path)})
        if snapshot is not None:
            shutil.copyfile(path, snapshot, follow_symlinks=False)
            os.chmod(snapshot, stat.S_IMODE(metadata.st_mode), follow_symlinks=False)
            os.chown(snapshot, metadata.st_uid, metadata.st_gid, follow_symlinks=False)
    elif stat.S_ISLNK(metadata.st_mode):
        target = os.readlink(path)
        common.update({"type": "symlink", "target": target})
        if snapshot is not None:
            os.symlink(target, snapshot)
            os.lchown(snapshot, metadata.st_uid, metadata.st_gid)
    else:
        die(f"unsupported Nginx object: {logical}")
    return common


def compare_object(record: dict[str, object], root: Path | None, snapshot: Path | None = None) -> bool:
    logical = str(record["path"])
    path = snapshot if snapshot is not None else rooted(logical, root)
    actual = object_record(path, logical)
    if snapshot is not None:
        # Saved record-directory copies have their ownership deliberately
        # normalized to the deployment-record owner (domain_evidence_owner);
        # the recorded uid/gid describe the live object for restore and are
        # not an identity property of the preserved copy.
        drop = ("uid", "gid")
        return {k: v for k, v in actual.items() if k not in drop} == {
            k: v for k, v in record.items() if k not in drop
        }
    return actual == record


def nginx_directory(record: Path) -> Path:
    return record / "domain-cutover" / "nginx"


def nginx_snapshot_document(record: Path) -> dict[str, object]:
    path = nginx_directory(record) / "SNAPSHOT.json"
    document = read_json(path)
    if not isinstance(document, dict) or set(document) != {"schemaVersion", "kind", "objects"}:
        die("Center Nginx snapshot schema mismatch")
    if document["schemaVersion"] != SCHEMA or document["kind"] != "center-nginx-before":
        die("Center Nginx snapshot version mismatch")
    objects = document["objects"]
    # A record written before the device edge existed carries three objects and a
    # record written since carries four.  Both shapes stay readable on purpose:
    # deploy.sh and rollback.sh restore the PREVIOUS deployment's record with the
    # CURRENT release's helper, so rejecting the older shape here would close the
    # recovery route out of this very change.  stream_managed() below is the one
    # place that branches on which shape a record has.
    if not isinstance(objects, dict) or set(objects) not in (
        {"canonicalAvailable", "canonicalEnabled", "legacyEnabled"},
        {"canonicalAvailable", "canonicalEnabled", "legacyEnabled", "deviceStream"},
    ):
        die("Center Nginx snapshot object set mismatch")
    expected_paths = {
        "canonicalAvailable": AVAILABLE,
        "canonicalEnabled": ENABLED,
        "deviceStream": STREAM_ENABLED,
    }
    for label, item in objects.items():
        if not isinstance(item, dict):
            die(f"invalid Center Nginx snapshot object: {label}")
        kind = item.get("type")
        if label == "legacyEnabled":
            logical = item.get("path")
            if not isinstance(logical, str):
                die("invalid Center Nginx legacy snapshot path")
            assert_safe_logical_path(logical, "/etc/nginx/sites-enabled")
            if kind == "same-as-canonical":
                if item != {"path": ENABLED, "type": "same-as-canonical"}:
                    die("invalid Center Nginx aliased legacy snapshot")
                continue
        else:
            if item.get("path") != expected_paths[label] or kind == "same-as-canonical":
                die(f"invalid Center Nginx snapshot path: {label}")
        if kind == "absent":
            if set(item) != {"path", "type"}:
                die(f"invalid absent Center Nginx snapshot object: {label}")
            continue
        common = {"path", "type", "mode", "uid", "gid"}
        if kind == "regular":
            if set(item) != common | {"size", "sha256"}:
                die(f"invalid regular Center Nginx snapshot object: {label}")
            if type(item["size"]) is not int or item["size"] < 0 \
                    or not re.fullmatch(r"[0-9a-f]{64}", str(item["sha256"])):
                die(f"invalid regular Center Nginx snapshot identity: {label}")
        elif kind == "symlink":
            if set(item) != common | {"target"} or not isinstance(item["target"], str) \
                    or not item["target"] or "\x00" in item["target"]:
                die(f"invalid symlink Center Nginx snapshot object: {label}")
        else:
            die(f"invalid Center Nginx snapshot object: {label}")
        for field in ("mode", "uid", "gid"):
            if type(item[field]) is not int or int(item[field]) < 0:
                die(f"invalid Center Nginx snapshot metadata: {label}.{field}")
    return document


def nginx_snapshot(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    directory = nginx_directory(record)
    if directory.exists():
        nginx_verify_snapshot(record, Path(args.filesystem_root).resolve() if args.filesystem_root else None)
        return
    discovery = discovery_document(Path(args.discovery))
    root = Path(args.filesystem_root).resolve() if args.filesystem_root else None
    directory.parent.mkdir(parents=True, exist_ok=True)
    staging: Path | None = Path(tempfile.mkdtemp(prefix=".nginx-before-", dir=directory.parent))
    try:
        os.chmod(staging, 0o700)
        specs = {
            "canonicalAvailable": AVAILABLE,
            "canonicalEnabled": ENABLED,
            "deviceStream": STREAM_ENABLED,
        }
        objects: dict[str, object] = {}
        for label, logical in specs.items():
            objects[label] = object_record(rooted(logical, root), logical, staging / f"{label}.before")
        legacy = str(discovery["legacyEnabledPath"])
        if legacy == ENABLED:
            objects["legacyEnabled"] = {"path": legacy, "type": "same-as-canonical"}
        else:
            objects["legacyEnabled"] = object_record(
                rooted(legacy, root), legacy, staging / "legacyEnabled.before"
            )
        atomic_regular(staging / "SNAPSHOT.json", canonical_json({
            "schemaVersion": SCHEMA,
            "kind": "center-nginx-before",
            "objects": objects,
        }), 0o400)
        os.replace(staging, directory)
        staging = None
    finally:
        if staging is not None and staging.exists():
            shutil.rmtree(staging)
    nginx_verify_snapshot(record, root)


def nginx_verify_snapshot(record: Path, root: Path | None) -> None:
    directory = nginx_directory(record)
    document = nginx_snapshot_document(record)
    for label, item in document["objects"].items():
        assert isinstance(item, dict)
        if item["type"] in {"absent", "same-as-canonical"}:
            continue
        snapshot = directory / f"{label}.before"
        if not compare_object(item, root, snapshot):
            die(f"Center Nginx snapshot identity mismatch: {label}")


def stream_managed(record: Path) -> bool:
    """Whether this record's transaction owns the public :443 stream file.

    False for a record captured before the device edge existed.  Such a record's
    desired state is the old topology — Center's vhost on the public :443 — which
    cannot coexist with the stream file, so installing or restoring one removes
    the stream rather than leaving two owners of the same socket behind.
    """
    objects = nginx_snapshot_document(record)["objects"]
    assert isinstance(objects, dict)
    return "deviceStream" in objects


def read_template(path: Path, label: str) -> str:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_size > 256 * 1024:
        die(f"{label} template is unsafe")
    return path.read_text(encoding="utf-8")


def render_tokens(body: str, tokens: dict[str, int], replacements: dict[str, str], label: str) -> str:
    for token, expected_count in tokens.items():
        marker = f"@@{token}@@"
        if body.count(marker) != expected_count:
            die(f"{label} template token count differs: {token}")
        body = body.replace(marker, replacements[token])
    if re.search(r"@@[A-Z0-9_]+@@", body) or "${" in body:
        die(f"{label} template retained an unresolved token")
    return body


def nginx_render(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    discovery = discovery_document(Path(args.discovery))
    nginx_verify_snapshot(record, Path(args.filesystem_root).resolve() if args.filesystem_root else None)
    if not stream_managed(record):
        die("this deployment record predates the device edge and cannot be re-rendered")
    if not re.fullmatch(r"[1-9][0-9]{1,4}", args.center_port) or int(args.center_port) > 65535:
        die("invalid Center loopback port")
    if not re.fullmatch(r"[1-9][0-9]{1,4}", args.keycloak_port) or int(args.keycloak_port) > 65535:
        die("invalid Keycloak loopback port")
    rendered = render_tokens(
        read_template(Path(args.template), "Center Nginx"),
        TOKENS,
        {
            "REVIVAL_CENTER_PORT": args.center_port,
            "REVIVAL_KEYCLOAK_PORT": args.keycloak_port,
            "REVIVAL_PUBLIC_TLS_CERTIFICATE": str(discovery["certificatePath"]),
            "REVIVAL_PUBLIC_TLS_PRIVATE_KEY": str(discovery["privateKeyPath"]),
            "REVIVAL_LOCAL_TLS_PORT": LOCAL_TLS_PORT,
        },
        "Center Nginx",
    )
    if "cosmos.andersmadsen.dk" not in rendered or CANONICAL_ORIGIN not in rendered:
        die("Center Nginx template lost its canonical or legacy origin")
    # Checked here as well as against the expanded configuration later, because
    # this is the one moment the two halves are rendered together: a vhost that
    # still claims the public :443 makes the stream file unloadable, and the
    # cheapest place to say so is before either has been written anywhere.
    if bindings := public_443_bindings(rendered, "the rendered Center vhost"):
        die(
            "the rendered Center vhost still binds the public :443 "
            f"({', '.join(bindings)}); it must listen on {LOCAL_TLS_BACKEND}, "
            "which the device edge stream forwards every non-clone SNI to"
        )
    if f"127.0.0.1:{LOCAL_TLS_PORT}" not in rendered:
        die("the rendered Center vhost has no loopback TLS listener for the device edge stream")
    stream_rendered = render_tokens(
        read_template(Path(args.stream_template), "device edge stream"),
        STREAM_TOKENS,
        {
            "REVIVAL_DEVICE_EDGE_BACKEND": DEVICE_EDGE_BACKEND,
            "REVIVAL_LOCAL_TLS_BACKEND": LOCAL_TLS_BACKEND,
        },
        "device edge stream",
    )
    if not public_443_bindings(stream_rendered, "the rendered device edge stream"):
        die("the rendered device edge stream does not bind the public :443")
    if not re.search(r"(?m)^[ \t]*ssl_preread[ \t]+on;", stream_rendered):
        die("the rendered device edge stream would terminate TLS instead of prereading its SNI")
    if re.search(r"(?m)^[ \t]*ssl_certificate", stream_rendered):
        die("the rendered device edge stream carries a certificate, which would end mTLS at Nginx")
    directory = nginx_directory(record)
    output = directory / "rendered.conf"
    stream_output = directory / "stream.conf"
    atomic_regular(output, rendered.encode(), 0o600)
    atomic_regular(stream_output, stream_rendered.encode(), 0o600)
    manifest = {
        "schemaVersion": SCHEMA,
        "kind": "center-nginx-desired",
        "renderedSha256": sha256_file(output),
        "streamRenderedSha256": sha256_file(stream_output),
        "streamEnabledPath": STREAM_ENABLED,
        "discoverySha256": sha256_file(Path(args.discovery)),
        "legacyEnabledPath": discovery["legacyEnabledPath"],
        "certificatePath": discovery["certificatePath"],
        "privateKeyPath": discovery["privateKeyPath"],
        "centerPort": int(args.center_port),
        "keycloakPort": int(args.keycloak_port),
    }
    atomic_regular(directory / "DESIRED.json", canonical_json(manifest), 0o400)


def nginx_desired_document(record: Path) -> dict[str, object]:
    directory = nginx_directory(record)
    document = read_json(directory / "DESIRED.json")
    required = {
        "schemaVersion", "kind", "renderedSha256", "discoverySha256", "legacyEnabledPath",
        "certificatePath", "privateKeyPath", "centerPort", "keycloakPort",
    }
    stream_keys = {"streamRenderedSha256", "streamEnabledPath"}
    # Same reason as the snapshot's object set: a record written before the
    # device edge existed has no stream fields and must stay restorable.
    managed = stream_managed(record)
    if not isinstance(document, dict) or set(document) != (required | stream_keys if managed else required):
        die("Center Nginx desired schema mismatch")
    if document["schemaVersion"] != SCHEMA or document["kind"] != "center-nginx-desired":
        die("Center Nginx desired version mismatch")
    if not re.fullmatch(r"[0-9a-f]{64}", str(document["renderedSha256"])):
        die("Center Nginx desired digest is invalid")
    if sha256_file(directory / "rendered.conf") != document["renderedSha256"]:
        die("Center Nginx rendered configuration drift")
    if managed:
        if not re.fullmatch(r"[0-9a-f]{64}", str(document["streamRenderedSha256"])):
            die("device edge stream desired digest is invalid")
        if sha256_file(directory / "stream.conf") != document["streamRenderedSha256"]:
            die("device edge stream rendered configuration drift")
        if document["streamEnabledPath"] != STREAM_ENABLED:
            die("device edge stream desired path mismatch")
    assert_safe_logical_path(str(document["legacyEnabledPath"]), "/etc/nginx/sites-enabled")
    return document


def install_regular(
    source: Path,
    destination: Path,
    mode: int = 0o644,
    owner: tuple[int, int] = (0, 0),
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    value = source.read_bytes()
    atomic_regular(destination, value, mode)
    os.chown(destination, owner[0], owner[1])


def replace_symlink(destination: Path, target: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.name}.incoming-{os.getpid()}"
    if temporary.exists() or temporary.is_symlink():
        temporary.unlink()
    os.symlink(target, temporary)
    os.replace(temporary, destination)


def nginx_transaction_states(
    record: Path,
    root: Path | None,
) -> tuple[
    dict[str, dict[str, object]],
    list[dict[str, dict[str, object]]],
    list[dict[str, dict[str, object]]],
]:
    """Return live state plus every exact restart-safe install/restore prefix."""
    directory = nginx_directory(record)
    desired = nginx_desired_document(record)
    objects = nginx_snapshot_document(record)["objects"]
    assert isinstance(objects, dict)
    owner = (os.geteuid(), os.getegid()) if root is not None else (0, 0)
    rendered = directory / "rendered.conf"
    metadata = rendered.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        die("Center Nginx rendered configuration is unsafe")

    desired_available: dict[str, object] = {
        "path": AVAILABLE,
        "mode": 0o644,
        "uid": owner[0],
        "gid": owner[1],
        "type": "regular",
        "size": metadata.st_size,
        "sha256": desired["renderedSha256"],
    }
    desired_enabled: dict[str, object] = {
        "path": ENABLED,
        "mode": 0o777,
        "uid": owner[0],
        "gid": owner[1],
        "type": "symlink",
        "target": AVAILABLE,
    }
    before_available = objects["canonicalAvailable"]
    before_enabled = objects["canonicalEnabled"]
    before_legacy = objects["legacyEnabled"]
    assert isinstance(before_available, dict) and isinstance(before_enabled, dict) \
        and isinstance(before_legacy, dict)
    legacy_alias = before_legacy["type"] == "same-as-canonical"

    actual: dict[str, dict[str, object]] = {
        "canonicalAvailable": object_record(rooted(AVAILABLE, root), AVAILABLE),
        "canonicalEnabled": object_record(rooted(ENABLED, root), ENABLED),
    }
    # POSIX leaves symlink permission bits implementation-defined (Linux reports
    # 0777 while macOS commonly reports the process-umask result). They are not
    # mutable access-control state. Bind the exact target and ownership while
    # normalizing only this non-semantic desired-link field to the live platform.
    actual_enabled = actual["canonicalEnabled"]
    if actual_enabled.get("type") == "symlink" \
            and actual_enabled.get("target") == AVAILABLE:
        desired_enabled["mode"] = actual_enabled["mode"]
    if not legacy_alias:
        legacy_path = str(before_legacy["path"])
        actual["legacyEnabled"] = object_record(rooted(legacy_path, root), legacy_path)

    managed = "deviceStream" in objects
    desired_stream: dict[str, object] | None = None
    before_stream: dict[str, object] | None = None
    if managed:
        before_stream = objects["deviceStream"]
        assert isinstance(before_stream, dict)
        stream_rendered = directory / "stream.conf"
        stream_metadata = stream_rendered.lstat()
        if not stat.S_ISREG(stream_metadata.st_mode) or stat.S_ISLNK(stream_metadata.st_mode):
            die("device edge stream rendered configuration is unsafe")
        desired_stream = {
            "path": STREAM_ENABLED,
            "mode": 0o644,
            "uid": owner[0],
            "gid": owner[1],
            "type": "regular",
            "size": stream_metadata.st_size,
            "sha256": desired["streamRenderedSha256"],
        }
        actual["deviceStream"] = object_record(rooted(STREAM_ENABLED, root), STREAM_ENABLED)

    # The stream file is written LAST and removed FIRST, and that order is the
    # safety property of this whole change, not a detail. Nginx binds the public
    # :443 exactly once: while the Center vhost still claims it, adding the stream
    # makes the master fail to bind and takes every vhost on the host down. So no
    # crash-observable prefix may hold both. Writing the stream after the vhost has
    # moved to its loopback port means a crash leaves either the old topology or a
    # :443 that is temporarily unbound — degraded, reloadable, never a bind failure.
    install_phases: list[dict[str, dict[str, object]]] = []
    for available, enabled, remove_legacy, install_stream in (
        (before_available, before_enabled, False, False),
        (desired_available, before_enabled, False, False),
        (desired_available, desired_enabled, False, False),
        (desired_available, desired_enabled, True, False),
        (desired_available, desired_enabled, True, True),
    ):
        if install_stream and not managed:
            continue
        phase = {
            "canonicalAvailable": available,
            "canonicalEnabled": enabled,
        }
        if not legacy_alias:
            phase["legacyEnabled"] = (
                {"path": str(before_legacy["path"]), "type": "absent"}
                if remove_legacy else before_legacy
            )
        if managed:
            assert desired_stream is not None and before_stream is not None
            phase["deviceStream"] = desired_stream if install_stream else before_stream
        install_phases.append(phase)

    # Restore removes the stream owner first, disables the new enabled owner,
    # restores its available file, and restores a distinct legacy owner last.
    # These reverse prefixes are not valid forward-install prefixes but must
    # remain restart-convergent.
    restore_phases: list[dict[str, dict[str, object]]] = [install_phases[-1]]
    for available, enabled, legacy_restored, keep_stream in (
        (desired_available, desired_enabled, False, False),
        (desired_available, before_enabled, False, False),
        (before_available, before_enabled, False, False),
        (before_available, before_enabled, True, False),
    ):
        phase = {
            "canonicalAvailable": available,
            "canonicalEnabled": enabled,
        }
        if not legacy_alias:
            phase["legacyEnabled"] = (
                before_legacy if legacy_restored else {
                    "path": str(before_legacy["path"]),
                    "type": "absent",
                }
            )
        if managed:
            assert desired_stream is not None and before_stream is not None
            phase["deviceStream"] = desired_stream if keep_stream else before_stream
        restore_phases.append(phase)
    if not managed:
        # The first reverse prefix is the completed install for a legacy record,
        # which install_phases already contributed; drop the duplicate so the
        # phase lists stay the exact sets they were before the stream existed.
        restore_phases = [restore_phases[0]] + restore_phases[2:]
    return actual, install_phases, restore_phases


def nginx_install_phase(record: Path, root: Path | None) -> int:
    """Return the exact resumable install phase or reject live preimage drift.

    The transaction has four ordered writes: available file, enabled link,
    removal of a distinct legacy enabled owner, then the public :443 stream file.
    A restart may observe any exact prefix of those writes. No other mixture is
    safe to overwrite because it may be an operator or configuration manager
    change after the snapshot.
    """
    actual, phases, _ = nginx_transaction_states(record, root)
    matches = [index for index, phase in enumerate(phases) if actual == phase]
    if not matches:
        die(
            "live Center Nginx state differs from both its captured preimage "
            "and every exact resumable install phase"
        )
    return max(matches)


def nginx_assert_restorable(record: Path, root: Path | None) -> None:
    actual, install_phases, restore_phases = nginx_transaction_states(record, root)
    if not any(actual == phase for phase in install_phases + restore_phases):
        die(
            "live Center Nginx state differs from every captured, desired, "
            "and exact resumable transaction phase"
        )


def drop_unmanaged_stream(root: Path | None) -> None:
    """Remove the public :443 stream owner for a record that predates it.

    A record captured before the device edge wants Center's vhost back on the
    public :443.  The stream file cannot be left beside it — two owners of one
    socket is a bind failure at reload, i.e. every vhost on the host — and the
    old record has no entry describing it, so the phase machine cannot see it.
    Removing it here is what keeps rolling back across this change survivable.
    """
    path = rooted(STREAM_ENABLED, root)
    if path.exists() or path.is_symlink():
        path.unlink()


def nginx_install_files(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    root = Path(args.filesystem_root).resolve() if args.filesystem_root else None
    nginx_verify_snapshot(record, root)
    desired = nginx_desired_document(record)
    managed = stream_managed(record)
    owner = (os.geteuid(), os.getegid()) if root is not None else (0, 0)
    # Establish that the live state is a phase of THIS record's transaction before
    # touching anything. Dropping the stream first would surrender the public :443
    # and only then discover that the state is not one this record may overwrite.
    phase = nginx_install_phase(record, root)
    if not managed:
        drop_unmanaged_stream(root)
    if phase < 1:
        install_regular(nginx_directory(record) / "rendered.conf", rooted(AVAILABLE, root), owner=owner)
        phase = nginx_install_phase(record, root)
    if phase < 2:
        replace_symlink(rooted(ENABLED, root), AVAILABLE)
        phase = nginx_install_phase(record, root)
    legacy = str(desired["legacyEnabledPath"])
    if phase < 3 and legacy != ENABLED:
        path = rooted(legacy, root)
        if path.exists() or path.is_symlink():
            path.unlink()
        phase = nginx_install_phase(record, root)
    # Last, and only once the vhost above no longer claims the public :443.
    if managed and phase < 4:
        install_regular(nginx_directory(record) / "stream.conf", rooted(STREAM_ENABLED, root), owner=owner)
        phase = nginx_install_phase(record, root)
    if phase != (4 if managed else 3):
        die("Center Nginx installation did not reach its exact desired state")


def nginx_verify_desired(record: Path, root: Path | None, require_marker: bool) -> None:
    desired = nginx_desired_document(record)
    managed = stream_managed(record)
    available = rooted(AVAILABLE, root)
    enabled = rooted(ENABLED, root)
    stream = rooted(STREAM_ENABLED, root)
    if not available.is_file() or available.is_symlink() or sha256_file(available) != desired["renderedSha256"]:
        die("live Center Nginx configuration differs from desired")
    if not enabled.is_symlink() or os.readlink(enabled) != AVAILABLE:
        die("live Center Nginx enabled link differs from desired")
    if managed:
        if not stream.is_file() or stream.is_symlink() \
                or sha256_file(stream) != desired["streamRenderedSha256"]:
            die("live device edge stream differs from desired")
    elif stream.exists() or stream.is_symlink():
        # The desired state of a pre-device-edge record is Center's vhost on the
        # public :443, which this file would collide with.
        die("device edge stream is installed beside a deployment record that predates it")
    legacy = str(desired["legacyEnabledPath"])
    if legacy != ENABLED:
        path = rooted(legacy, root)
        if path.exists() or path.is_symlink():
            die("legacy dashboard Nginx vhost is still enabled")
    if nginx_install_phase(record, root) != (4 if managed else 3):
        die("live Center Nginx configuration is not the exact completed transaction state")
    marker = nginx_directory(record) / "INSTALLED.json"
    if require_marker:
        body = read_json(marker)
        if body != {
            "schemaVersion": SCHEMA,
            "kind": "center-nginx-installed",
            "renderedSha256": desired["renderedSha256"],
        }:
            die("Center Nginx installation marker mismatch")


def nginx_mark_installed(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    root = Path(args.filesystem_root).resolve() if args.filesystem_root else None
    nginx_verify_desired(record, root, False)
    desired = nginx_desired_document(record)
    atomic_regular(nginx_directory(record) / "INSTALLED.json", canonical_json({
        "schemaVersion": SCHEMA,
        "kind": "center-nginx-installed",
        "renderedSha256": desired["renderedSha256"],
    }), 0o400)


def restore_object(item: dict[str, object], snapshot: Path | None, root: Path | None) -> None:
    destination = rooted(str(item["path"]), root)
    if destination.exists() or destination.is_symlink():
        if destination.is_dir() and not destination.is_symlink():
            die(f"refusing to replace directory during Nginx restore: {destination}")
        destination.unlink()
    kind = item["type"]
    if kind == "absent":
        return
    if kind == "same-as-canonical":
        return
    if snapshot is None:
        die("Nginx restore snapshot is missing")
    if kind == "regular":
        install_regular(
            snapshot,
            destination,
            int(item["mode"]),
            (int(item["uid"]), int(item["gid"])),
        )
    elif kind == "symlink":
        replace_symlink(destination, str(item["target"]))
        os.lchown(destination, int(item["uid"]), int(item["gid"]))
    else:
        die("unsupported Nginx restore object")


def nginx_restore_files(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    root = Path(args.filesystem_root).resolve() if args.filesystem_root else None
    nginx_verify_snapshot(record, root)
    nginx_assert_restorable(record, root)
    if not stream_managed(record):
        # Give up the public :443 before restoring a vhost that wants it back —
        # but only after the live state has been accepted as restorable, so a
        # refusal never leaves the port with no owner at all.
        drop_unmanaged_stream(root)
    directory = nginx_directory(record)
    objects = nginx_snapshot_document(record)["objects"]
    assert isinstance(objects, dict)
    # Release the public :443 first, disable the new routing next, and restore the
    # old enabled owner last. The stream leads because whatever the vhost reverts
    # to may claim :443 again, and the two must never hold it at the same time.
    for label in ("deviceStream", "canonicalEnabled", "canonicalAvailable", "legacyEnabled"):
        if label not in objects:
            continue
        item = objects[label]
        assert isinstance(item, dict)
        snapshot = None if item["type"] in {"absent", "same-as-canonical"} else directory / f"{label}.before"
        restore_object(item, snapshot, root)
        nginx_assert_restorable(record, root)


def nginx_verify_before(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    root = Path(args.filesystem_root).resolve() if args.filesystem_root else None
    nginx_verify_snapshot(record, root)
    directory = nginx_directory(record)
    objects = nginx_snapshot_document(record)["objects"]
    assert isinstance(objects, dict)
    for label, item in objects.items():
        assert isinstance(item, dict)
        if item["type"] == "same-as-canonical":
            continue
        if not compare_object(item, root):
            die(f"restored Center Nginx state differs: {label}")
    if "deviceStream" not in objects:
        # A pre-device-edge preimage is only truly restored once the stream owner
        # is gone; leaving it would verify green against a configuration Nginx
        # cannot load.
        stream = rooted(STREAM_ENABLED, root)
        if stream.exists() or stream.is_symlink():
            die("restored Center Nginx state differs: deviceStream is present in a preimage that predates it")


def read_regular_bytes(path: Path, maximum: int = 1024 * 1024) -> tuple[bytes, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        die(f"unsafe regular file {path}: {error}")
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0 or metadata.st_size > maximum:
            die(f"unsafe regular file identity: {path}")
        chunks: list[bytes] = []
        total = 0
        while chunk := os.read(descriptor, min(65536, maximum + 1 - total)):
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum:
                die(f"unsafe regular file size: {path}")
        value = b"".join(chunks)
        if len(value) != metadata.st_size:
            die(f"regular file changed while being read: {path}")
        return value, metadata
    finally:
        os.close(descriptor)


def yaml_scalar(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    if value.startswith("'"):
        if len(value) < 2 or not value.endswith("'"):
            die("ambiguous single-quoted Cloudflared scalar")
        return value[1:-1].replace("''", "'")
    if value.startswith('"'):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError as error:
            die(f"ambiguous double-quoted Cloudflared scalar: {error}")
        if not isinstance(decoded, str):
            die("non-string Cloudflared scalar")
        return decoded
    value = value.split(" #", 1)[0].rstrip()
    if value.startswith(("&", "*", "!", "|", ">")):
        die("indirect or multiline Cloudflared scalar is not supported")
    return value


def cloudflared_ingress(
    value: bytes,
    expected: str,
) -> tuple[int, str, str]:
    try:
        text = value.decode("utf-8")
    except UnicodeDecodeError as error:
        die(f"Cloudflared configuration is not UTF-8: {error}")
    if "\x00" in text or "\r" in text or "\t" in text:
        die("Cloudflared configuration contains unsafe control or indentation bytes")
    lines = text.splitlines(keepends=True)
    ingress = [
        index for index, line in enumerate(lines)
        if re.fullmatch(r"ingress:\s*(?:#.*)?\n?", line)
    ]
    if len(ingress) != 1:
        die(f"expected one top-level Cloudflared ingress mapping, found {len(ingress)}")
    start = ingress[0] + 1
    entry_indent: str | None = None
    item_lines: list[int] = []
    end = len(lines)
    for index in range(start, len(lines)):
        line = lines[index]
        body = line[:-1] if line.endswith("\n") else line
        stripped = body.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indentation = len(body) - len(body.lstrip(" "))
        match = re.match(r"^( *)- +(.*)$", body)
        if match:
            if entry_indent is None:
                entry_indent = match.group(1)
            elif len(match.group(1)) > len(entry_indent):
                continue
            elif match.group(1) != entry_indent:
                die("Cloudflared ingress rules use ambiguous list indentation")
            item_lines.append(index)
            continue
        if entry_indent is None:
            die("Cloudflared ingress mapping does not begin with a rule list")
        if indentation <= len(entry_indent):
            end = index
            break
    if entry_indent is None or not item_lines:
        die("Cloudflared ingress mapping has no rules")

    rules: list[dict[str, str]] = []
    for position, item_line in enumerate(item_lines):
        block_end = item_lines[position + 1] if position + 1 < len(item_lines) else end
        fields: dict[str, str] = {}
        for index in range(item_line, block_end):
            body = lines[index][:-1] if lines[index].endswith("\n") else lines[index]
            stripped = body.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if index == item_line:
                content = re.match(r"^( *)- +(.*)$", body)
                assert content is not None
                candidate = content.group(2)
            else:
                indentation = len(body) - len(body.lstrip(" "))
                if indentation != len(entry_indent) + 2:
                    continue
                candidate = body[indentation:]
            field = re.match(r"^([A-Za-z][A-Za-z0-9_-]*):(?: +(.*))?$", candidate)
            if field is None:
                continue
            key = field.group(1)
            if key in fields:
                die(f"duplicate Cloudflared ingress field: {key}")
            fields[key] = yaml_scalar(field.group(2) or "")
        rules.append(fields)

    catchalls = [
        index for index, rule in enumerate(rules)
        if set(rule) == {"service"} and rule["service"] == "http_status:404"
    ]
    if len(catchalls) != 1:
        die(f"expected one exact Cloudflared catch-all, found {len(catchalls)}")
    catchall = catchalls[0]
    if catchall != len(rules) - 1:
        die("Cloudflared catch-all is not the final ingress rule")
    center = [
        index for index, rule in enumerate(rules)
        if rule.get("hostname", "").lower().rstrip(".") == "center.andersmadsen.dk"
    ]
    wildcard_center = [
        rule.get("hostname", "").lower().rstrip(".")
        for rule in rules
        if rule.get("hostname", "").lower().rstrip(".") == "*"
        or (
            rule.get("hostname", "").lower().rstrip(".").startswith("*.")
            and "center.andersmadsen.dk".endswith(
                rule.get("hostname", "").lower().rstrip(".")[1:]
            )
        )
    ]
    if wildcard_center:
        die("Cloudflared config contains a wildcard conflicting with Center")
    route = "catchall"
    if center:
        route = "center"
    if expected in {"preimage", "desired"}:
        if len(center) > 1:
            die("Cloudflared config contains duplicate Center rules")
        if center and (
            center[0] != catchall - 1
            or set(rules[center[0]]) != {"hostname", "service"}
            or rules[center[0]].get("service") != "http://localhost:80"
        ):
            die("Cloudflared config contains a conflicting Center rule")
    if expected == "desired":
        if len(center) != 1:
            die(f"expected one Cloudflared Center rule, found {len(center)}")
    elif expected != "preimage":
        die("invalid Cloudflared configuration state")
    catchall_offset = sum(len(line.encode("utf-8")) for line in lines[:item_lines[catchall]])
    return catchall_offset, entry_indent, route


def cloudflared_render(before: bytes) -> tuple[bytes, str]:
    offset, indentation, before_route = cloudflared_ingress(before, "preimage")
    if before_route == "center":
        return before, before_route
    stanza = (
        f"{indentation}- hostname: center.andersmadsen.dk\n"
        f"{indentation}  service: http://localhost:80\n"
    ).encode()
    desired = before[:offset] + stanza + before[offset:]
    cloudflared_ingress(desired, "desired")
    return desired, before_route


def cloudflared_directory(record: Path) -> Path:
    return record / "domain-cutover" / "cloudflared"


def cloudflared_file_state(value: bytes, metadata: os.stat_result) -> dict[str, object]:
    return {
        "size": len(value),
        "sha256": sha256_bytes(value),
        "mode": stat.S_IMODE(metadata.st_mode),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
    }


def cloudflared_journal(record: Path) -> dict[str, object]:
    directory = cloudflared_directory(record)
    document = read_json(directory / "JOURNAL.json")
    if not isinstance(document, dict) or set(document) != {
        "schemaVersion", "kind", "configPath", "beforeRoute", "before", "desired",
    }:
        die("Cloudflared transaction journal schema mismatch")
    if document["schemaVersion"] != SCHEMA or document["kind"] != "center-cloudflared-ingress" \
            or document["configPath"] != CLOUDFLARED_CONFIG:
        die("Cloudflared transaction journal identity mismatch")
    for name in ("before", "desired"):
        identity = document[name]
        if not isinstance(identity, dict) or set(identity) != {"size", "sha256", "mode", "uid", "gid"}:
            die(f"Cloudflared {name} identity schema mismatch")
        if type(identity["size"]) is not int or not 0 < int(identity["size"]) <= 1024 * 1024 \
                or not re.fullmatch(r"[0-9a-f]{64}", str(identity["sha256"])):
            die(f"Cloudflared {name} byte identity is invalid")
        for field in ("mode", "uid", "gid"):
            if type(identity[field]) is not int or int(identity[field]) < 0:
                die(f"Cloudflared {name} metadata is invalid")
        stored, _ = read_regular_bytes(directory / f"{name}.yml")
        if len(stored) != identity["size"] or sha256_bytes(stored) != identity["sha256"]:
            die(f"Cloudflared {name} evidence drift")
        _, _, route = cloudflared_ingress(stored, "preimage" if name == "before" else "desired")
        if name == "before" and route != document["beforeRoute"]:
            die("Cloudflared preimage route binding drift")
    if document["beforeRoute"] not in {"catchall", "center"}:
        die("Cloudflared preimage route is invalid")
    before = document["before"]
    desired = document["desired"]
    assert isinstance(before, dict) and isinstance(desired, dict)
    for field in ("mode", "uid", "gid"):
        if before[field] != desired[field]:
            die("Cloudflared desired metadata does not preserve its preimage")
    return document


def cloudflared_live_states(record: Path, root: Path | None) -> set[str]:
    journal = cloudflared_journal(record)
    value, metadata = read_regular_bytes(rooted(CLOUDFLARED_CONFIG, root))
    actual = cloudflared_file_state(value, metadata)
    matches = {name for name in ("before", "desired") if actual == journal[name]}
    if not matches:
        die("live Cloudflared config matches neither exact transaction state")
    if "desired" in matches:
        cloudflared_ingress(value, "desired")
    else:
        cloudflared_ingress(value, "preimage")
    return matches


def cloudflared_prepare(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    root = Path(args.filesystem_root).resolve() if args.filesystem_root else None
    directory = cloudflared_directory(record)
    if directory.exists() or directory.is_symlink():
        if directory.is_symlink() or not directory.is_dir():
            die("Cloudflared evidence directory is unsafe")
        cloudflared_live_states(record, root)
        return
    config = rooted(CLOUDFLARED_CONFIG, root)
    before, metadata = read_regular_bytes(config)
    desired, before_route = cloudflared_render(before)
    before_identity = cloudflared_file_state(before, metadata)
    desired_identity = dict(before_identity)
    desired_identity.update({"size": len(desired), "sha256": sha256_bytes(desired)})
    journal = {
        "schemaVersion": SCHEMA,
        "kind": "center-cloudflared-ingress",
        "configPath": CLOUDFLARED_CONFIG,
        "beforeRoute": before_route,
        "before": before_identity,
        "desired": desired_identity,
    }
    directory.parent.mkdir(parents=True, exist_ok=True)
    staging: Path | None = Path(tempfile.mkdtemp(prefix=".cloudflared-", dir=directory.parent))
    try:
        os.chmod(staging, 0o700)
        atomic_regular(staging / "before.yml", before)
        atomic_regular(staging / "desired.yml", desired)
        atomic_regular(staging / "JOURNAL.json", canonical_json(journal), 0o400)
        os.replace(staging, directory)
        staging = None
    finally:
        if staging is not None and staging.exists():
            shutil.rmtree(staging)
    if "before" not in cloudflared_live_states(record, root):
        die("Cloudflared preimage changed while its transaction was prepared")


def cloudflared_write_state(record: Path, root: Path | None, target: str) -> None:
    if target not in {"before", "desired"}:
        die("invalid Cloudflared write state")
    live = cloudflared_live_states(record, root)
    if target in live:
        return
    source, _ = read_regular_bytes(cloudflared_directory(record) / f"{target}.yml")
    journal = cloudflared_journal(record)
    identity = journal[target]
    assert isinstance(identity, dict)
    if len(source) != identity["size"] or sha256_bytes(source) != identity["sha256"]:
        die(f"Cloudflared {target} write source drift")
    destination = rooted(CLOUDFLARED_CONFIG, root)
    atomic_regular(destination, source, int(identity["mode"]))
    os.chown(destination, int(identity["uid"]), int(identity["gid"]))
    descriptor = os.open(destination, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    if target not in cloudflared_live_states(record, root):
        die(f"Cloudflared config did not reach exact {target} state")


def cloudflared_install(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    root = Path(args.filesystem_root).resolve() if args.filesystem_root else None
    cloudflared_write_state(record, root, "desired")


def cloudflared_restore(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    root = Path(args.filesystem_root).resolve() if args.filesystem_root else None
    cloudflared_write_state(record, root, "before")


def cloudflared_verify(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    root = Path(args.filesystem_root).resolve() if args.filesystem_root else None
    if args.state not in {"before", "desired"} \
            or args.state not in cloudflared_live_states(record, root):
        die(f"live Cloudflared config differs from exact {args.state} state")
    if args.require_marker:
        marker_name = "INSTALLED.json" if args.state == "desired" else "RESTORED.json"
        marker = read_json(cloudflared_directory(record) / marker_name)
        journal = cloudflared_journal(record)
        expected = {
            "schemaVersion": SCHEMA,
            "kind": "center-cloudflared-marker",
            "state": args.state,
            "stateSha256": journal[args.state]["sha256"],
        }
        if marker != expected:
            die("Cloudflared transaction marker mismatch")


def cloudflared_mark(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    root = Path(args.filesystem_root).resolve() if args.filesystem_root else None
    if args.state not in {"before", "desired"} \
            or args.state not in cloudflared_live_states(record, root):
        die("cannot mark a Cloudflared state that is not live")
    journal = cloudflared_journal(record)
    marker_name = "INSTALLED.json" if args.state == "desired" else "RESTORED.json"
    atomic_regular(cloudflared_directory(record) / marker_name, canonical_json({
        "schemaVersion": SCHEMA,
        "kind": "center-cloudflared-marker",
        "state": args.state,
        "stateSha256": journal[args.state]["sha256"],
    }), 0o400)


def cloudflared_before_route(args: argparse.Namespace) -> None:
    journal = cloudflared_journal(Path(args.record).resolve())
    print(journal["beforeRoute"])


def cloudflared_inspect(args: argparse.Namespace) -> None:
    root = Path(args.filesystem_root).resolve() if args.filesystem_root else None
    value, _ = read_regular_bytes(rooted(CLOUDFLARED_CONFIG, root))
    _, _, route = cloudflared_ingress(value, "preimage")
    print(route)


def sanitize_client(document: object) -> dict[str, object]:
    if not isinstance(document, dict) or not isinstance(document.get("id"), str):
        die("Keycloak client representation is invalid")
    cleaned = dict(document)
    for key in ("secret", "registrationAccessToken"):
        cleaned.pop(key, None)
    return cleaned


def desired_client(before: dict[str, object]) -> dict[str, object]:
    desired = dict(before)
    attributes = dict(desired.get("attributes") or {})
    attributes["pkce.code.challenge.method"] = "S256"
    attributes["post.logout.redirect.uris"] = f"{CANONICAL_ORIGIN}/login"
    desired.update({
        "clientId": "center",
        "name": "Ai Pin Revival Center",
        "description": "The wearer-facing Center dashboard.",
        "enabled": True,
        "protocol": "openid-connect",
        "publicClient": False,
        "standardFlowEnabled": True,
        "implicitFlowEnabled": False,
        "serviceAccountsEnabled": False,
        "rootUrl": CANONICAL_ORIGIN,
        "baseUrl": CANONICAL_ORIGIN,
        "adminUrl": CANONICAL_ORIGIN,
        "redirectUris": [f"{CANONICAL_ORIGIN}/api/auth/callback/humane"],
        "webOrigins": [CANONICAL_ORIGIN],
        "attributes": attributes,
    })
    return desired


def assert_desired_client(document: dict[str, object]) -> None:
    attributes = document.get("attributes")
    if not isinstance(attributes, dict):
        die("Keycloak client attributes are invalid")
    exact = {
        "clientId": "center",
        "enabled": True,
        "protocol": "openid-connect",
        "publicClient": False,
        "standardFlowEnabled": True,
        "implicitFlowEnabled": False,
        "serviceAccountsEnabled": False,
        "rootUrl": CANONICAL_ORIGIN,
        "baseUrl": CANONICAL_ORIGIN,
        "adminUrl": CANONICAL_ORIGIN,
        "redirectUris": [f"{CANONICAL_ORIGIN}/api/auth/callback/humane"],
        "webOrigins": [CANONICAL_ORIGIN],
    }
    for key, expected in exact.items():
        if document.get(key) != expected:
            die(f"Keycloak desired client differs at {key}")
    if attributes.get("pkce.code.challenge.method") != "S256":
        die("Keycloak desired client does not require PKCE S256")
    if attributes.get("post.logout.redirect.uris") != f"{CANONICAL_ORIGIN}/login":
        die("Keycloak desired client has an unsafe logout origin")
    origin_fields = [
        str(document.get("rootUrl", "")), str(document.get("baseUrl", "")),
        str(document.get("adminUrl", "")), *map(str, document.get("redirectUris") or []),
        *map(str, document.get("webOrigins") or []),
        str(attributes.get("post.logout.redirect.uris", "")),
    ]
    if any("*" in value or value == "+" or LEGACY_ORIGIN in value for value in origin_fields):
        die("Keycloak desired client retained a wildcard or legacy origin")


def client_prepare(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    directory = record / "domain-cutover" / "keycloak"
    backup = Path(args.backup_manifest).resolve()
    backup_document = read_json(backup, 16 * 1024 * 1024)
    if not isinstance(backup_document, dict) or backup_document.get("schemaVersion") != 1:
        die("backup manifest cannot bind the Keycloak migration")
    before = sanitize_client(read_json(Path(args.before)))
    if before.get("clientId") != "center":
        die("Keycloak migration selected the wrong client")
    desired = desired_client(before)
    assert_desired_client(desired)
    before_bytes = canonical_json(before)
    desired_bytes = canonical_json(desired)
    journal = {
        "schemaVersion": SCHEMA,
        "kind": "center-keycloak-client",
        "clientId": "center",
        "clientUuid": before["id"],
        "backupManifest": str(backup),
        "backupManifestSha256": sha256_file(backup),
        "beforeSha256": sha256_bytes(before_bytes),
        "desiredSha256": sha256_bytes(desired_bytes),
    }
    if directory.exists():
        existing = read_json(directory / "JOURNAL.json")
        if existing != journal or (directory / "before.json").read_bytes() != before_bytes \
                or (directory / "desired.json").read_bytes() != desired_bytes:
            die("Keycloak migration journal conflicts with the requested state")
        return
    directory.parent.mkdir(parents=True, exist_ok=True)
    staging: Path | None = Path(tempfile.mkdtemp(prefix=".keycloak-client-", dir=directory.parent))
    try:
        os.chmod(staging, 0o700)
        atomic_regular(staging / "before.json", before_bytes)
        atomic_regular(staging / "desired.json", desired_bytes)
        atomic_regular(staging / "JOURNAL.json", canonical_json(journal), 0o400)
        os.replace(staging, directory)
        staging = None
    finally:
        if staging is not None and staging.exists():
            shutil.rmtree(staging)


def client_journal(record: Path) -> dict[str, object]:
    directory = record / "domain-cutover" / "keycloak"
    journal = read_json(directory / "JOURNAL.json")
    required = {
        "schemaVersion", "kind", "clientId", "clientUuid", "backupManifest",
        "backupManifestSha256", "beforeSha256", "desiredSha256",
    }
    if not isinstance(journal, dict) or set(journal) != required:
        die("Keycloak migration journal schema mismatch")
    if journal["schemaVersion"] != SCHEMA or journal["kind"] != "center-keycloak-client":
        die("Keycloak migration journal version mismatch")
    backup = Path(str(journal["backupManifest"]))
    if sha256_file(backup) != journal["backupManifestSha256"]:
        die("Keycloak migration backup binding drift")
    for name in ("before", "desired"):
        path = directory / f"{name}.json"
        if sha256_file(path) != journal[f"{name}Sha256"]:
            die(f"Keycloak migration {name} state drift")
    desired = sanitize_client(read_json(directory / "desired.json"))
    assert_desired_client(desired)
    return journal


def client_sanitize(args: argparse.Namespace) -> None:
    atomic_regular(Path(args.output), canonical_json(sanitize_client(read_json(Path(args.input)))))


def client_verify(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    journal = client_journal(record)
    if args.which not in {"before", "desired"}:
        die("invalid Keycloak comparison state")
    actual = canonical_json(sanitize_client(read_json(Path(args.actual))))
    if sha256_bytes(actual) != journal[f"{args.which}Sha256"]:
        die(f"live Keycloak client differs from {args.which} state")


def client_mark(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    journal = client_journal(record)
    if args.state not in {"applied", "restored"}:
        die("invalid Keycloak migration marker state")
    atomic_regular(record / "domain-cutover" / "keycloak" / f"{args.state.upper()}.json", canonical_json({
        "schemaVersion": SCHEMA,
        "kind": "center-keycloak-client-marker",
        "state": args.state,
        "clientUuid": journal["clientUuid"],
        "stateSha256": journal[f"{'desired' if args.state == 'applied' else 'before'}Sha256"],
    }), 0o400)


def client_check_marker(args: argparse.Namespace) -> None:
    record = Path(args.record).resolve()
    journal = client_journal(record)
    if args.state not in {"applied", "restored"}:
        die("invalid Keycloak migration marker state")
    marker = read_json(record / "domain-cutover" / "keycloak" / f"{args.state.upper()}.json")
    expected = {
        "schemaVersion": SCHEMA,
        "kind": "center-keycloak-client-marker",
        "state": args.state,
        "clientUuid": journal["clientUuid"],
        "stateSha256": journal[f"{'desired' if args.state == 'applied' else 'before'}Sha256"],
    }
    if marker != expected:
        die("Keycloak migration marker mismatch")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    discover = commands.add_parser("discover-nginx")
    discover.add_argument("--input", required=True); discover.add_argument("--output", required=True)
    discover.set_defaults(handler=discover_nginx)
    check = commands.add_parser("check-discovery")
    check.add_argument("--input", required=True); check.set_defaults(handler=lambda a: discovery_document(Path(a.input)))
    owner443 = commands.add_parser("nginx-assert-443-owner")
    owner443.add_argument("--input", required=True); owner443.set_defaults(handler=nginx_assert_443_owner)
    for name, handler in (("nginx-snapshot", nginx_snapshot), ("nginx-install-files", nginx_install_files),
                          ("nginx-restore-files", nginx_restore_files), ("nginx-verify-before", nginx_verify_before)):
        command = commands.add_parser(name); command.add_argument("--record", required=True)
        command.add_argument("--filesystem-root"); command.set_defaults(handler=handler)
        if name == "nginx-snapshot": command.add_argument("--discovery", required=True)
    render = commands.add_parser("nginx-render")
    render.add_argument("--record", required=True); render.add_argument("--template", required=True)
    render.add_argument("--stream-template", required=True)
    render.add_argument("--discovery", required=True); render.add_argument("--center-port", required=True)
    render.add_argument("--keycloak-port", required=True); render.add_argument("--filesystem-root")
    render.set_defaults(handler=nginx_render)
    verify = commands.add_parser("nginx-verify-desired")
    verify.add_argument("--record", required=True); verify.add_argument("--filesystem-root")
    verify.add_argument("--require-marker", action="store_true")
    verify.set_defaults(handler=lambda a: nginx_verify_desired(
        Path(a.record).resolve(), Path(a.filesystem_root).resolve() if a.filesystem_root else None, a.require_marker
    ))
    marker = commands.add_parser("nginx-mark-installed")
    marker.add_argument("--record", required=True); marker.add_argument("--filesystem-root")
    marker.set_defaults(handler=nginx_mark_installed)
    for name, handler in (
        ("cloudflared-prepare", cloudflared_prepare),
        ("cloudflared-install", cloudflared_install),
        ("cloudflared-restore", cloudflared_restore),
    ):
        command = commands.add_parser(name)
        command.add_argument("--record", required=True)
        command.add_argument("--filesystem-root")
        command.set_defaults(handler=handler)
    verify_cloudflared = commands.add_parser("cloudflared-verify")
    verify_cloudflared.add_argument("--record", required=True)
    verify_cloudflared.add_argument("--filesystem-root")
    verify_cloudflared.add_argument("--state", required=True)
    verify_cloudflared.add_argument("--require-marker", action="store_true")
    verify_cloudflared.set_defaults(handler=cloudflared_verify)
    mark_cloudflared = commands.add_parser("cloudflared-mark")
    mark_cloudflared.add_argument("--record", required=True)
    mark_cloudflared.add_argument("--filesystem-root")
    mark_cloudflared.add_argument("--state", required=True)
    mark_cloudflared.set_defaults(handler=cloudflared_mark)
    route_cloudflared = commands.add_parser("cloudflared-before-route")
    route_cloudflared.add_argument("--record", required=True)
    route_cloudflared.set_defaults(handler=cloudflared_before_route)
    inspect_cloudflared = commands.add_parser("cloudflared-inspect")
    inspect_cloudflared.add_argument("--filesystem-root")
    inspect_cloudflared.set_defaults(handler=cloudflared_inspect)
    sanitize = commands.add_parser("client-sanitize")
    sanitize.add_argument("--input", required=True); sanitize.add_argument("--output", required=True)
    sanitize.set_defaults(handler=client_sanitize)
    prepare = commands.add_parser("client-prepare")
    prepare.add_argument("--before", required=True); prepare.add_argument("--record", required=True)
    prepare.add_argument("--backup-manifest", required=True); prepare.set_defaults(handler=client_prepare)
    verify_client = commands.add_parser("client-verify")
    verify_client.add_argument("--record", required=True); verify_client.add_argument("--which", required=True)
    verify_client.add_argument("--actual", required=True); verify_client.set_defaults(handler=client_verify)
    mark_client = commands.add_parser("client-mark")
    mark_client.add_argument("--record", required=True); mark_client.add_argument("--state", required=True)
    mark_client.set_defaults(handler=client_mark)
    check_client = commands.add_parser("client-check-marker")
    check_client.add_argument("--record", required=True); check_client.add_argument("--state", required=True)
    check_client.set_defaults(handler=client_check_marker)
    return root


def main() -> None:
    args = parser().parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
