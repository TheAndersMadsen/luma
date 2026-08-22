#!/usr/bin/env python3
"""Run Docker Compose with one digest-checked, descriptor-held image override."""

from __future__ import annotations

import argparse
import base64
import binascii
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys


SHA256 = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_OBJECT_ID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
SAFE_JSON_INTEGER = 9_007_199_254_740_991
REMOTE_ROOT = "/home/anders/ai-pin-revival"
EXPECTED_DOCKER_HOST = "unix:///var/run/docker.sock"
EXPECTED_DOCKER_CONFIG = f"{REMOTE_ROOT}/private/docker-cli-empty"
MAX_OVERRIDE = 2 * 1024 * 1024
MAX_RECEIPT = 8 * 1024 * 1024
MAX_BUNDLE = 32 * 1024 * 1024 * 1024
MAX_MANIFEST = 16 * 1024 * 1024
COMPOSE_PATHS = ("compose.yaml", "platform/compose/production.yaml")
PRODUCTION_AUTHORITY_PATH = "platform/deploy/production-compose-authority.json"
EXPECTED_SERVICES = frozenset({
    "account", "ai-bus", "center", "connectivity", "contacts", "edge",
    "feature-flags", "grafana", "keycloak", "notable-events", "postgres",
    "prometheus", "provisioning", "searxng", "spotify-adapter",
})
EXPECTED_CANDIDATE_FILES = frozenset({
    "candidate.json", "compose-model.json", "image-receipt.json", "images.tar",
    "production-state.json", "release.json", "release.manifest.json",
    "release.tar.gz", "source-commit.txt", "source-receipt.json",
    "source-snapshot.tar", "toolchain-receipt.json", "verify-release.py",
})
SERVICE_ROLES = {
    "account": "cosmos", "ai-bus": "cosmos", "center": "center",
    "connectivity": "cosmos", "contacts": "cosmos", "edge": "envoy",
    "feature-flags": "cosmos", "grafana": "grafana", "keycloak": "keycloak",
    "notable-events": "cosmos", "postgres": "postgres",
    "prometheus": "prometheus", "provisioning": "cosmos", "searxng": "searxng",
    "spotify-adapter": "spotify-adapter",
}
THIRD_PARTY_REFERENCES = {
    "keycloak": "quay.io/keycloak/keycloak:26.0@sha256:09a381c715ab0b111835b70f2905955274843a219c6f27efb348e4d9f4086858",
    "searxng": "searxng/searxng@sha256:f4c8e59de166ed71f6380c0847c312ca51f0d41996e31d0559163b6b09ecde52",
    "envoy": "envoyproxy/envoy:v1.31-latest@sha256:caa5b411be1633b90023592a34a7e010c933d6e60206c758f631485e53006865",
    "postgres": "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777",
    "prometheus": "prom/prometheus:v2.54.1@sha256:f6639335d34a77d9d9db382b92eeb7fc00934be8eae81dbc03b31cfe90411a94",
    "grafana": "grafana/grafana:11.2.0@sha256:408afb9726de5122b00a2576763a8a57a3c86d5b0eff5305bc994ceb3eb96c3f",
    "backup-helper": "node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b",
}
THIRD_PARTY_BUNDLE_REFERENCES = {
    "keycloak": "quay.io/keycloak/keycloak:26.0",
    "searxng": "searxng/searxng:latest",
    "envoy": "envoyproxy/envoy:v1.31-latest",
    "postgres": "postgres:16-alpine",
    "prometheus": "prom/prometheus:v2.54.1",
    "grafana": "grafana/grafana:11.2.0",
    "backup-helper": "node:22.18.0-alpine3.22",
}
BACKUP_HELPER_REFERENCE = THIRD_PARTY_REFERENCES["backup-helper"]
RECEIPT_KEYS = frozenset({"bundle", "images", "platform", "schema", "schemaVersion", "targetPlatform"})
IMAGE_KEYS = frozenset({
    "bundleReference", "component", "firstParty", "imageId", "labels",
    "platform", "reference", "registry", "sourceDigest",
})
FIRST_PARTY_LABEL_KEYS = frozenset({
    "dk.andersmadsen.ai-pin-revival.component",
    "dk.andersmadsen.ai-pin-revival.product",
    "dk.andersmadsen.ai-pin-revival.release",
    "dk.andersmadsen.ai-pin-revival.source-commit",
    "dk.andersmadsen.ai-pin-revival.source-tree",
    "org.opencontainers.image.revision",
})
OCI_INDEX_MEDIA_TYPES = frozenset({
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
})
OCI_MANIFEST_MEDIA_TYPES = frozenset({
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
})
OCI_CONFIG_MEDIA_TYPES = frozenset({
    "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.container.image.v1+json",
})
REQUIRED_SEALS = (
    getattr(fcntl, "F_SEAL_SEAL", 0x0001) |
    getattr(fcntl, "F_SEAL_SHRINK", 0x0002) |
    getattr(fcntl, "F_SEAL_GROW", 0x0004) |
    getattr(fcntl, "F_SEAL_WRITE", 0x0008)
)


def refuse(message: str) -> "NoReturn":
    raise SystemExit(f"held Compose refusal: {message}")


def identity(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_nlink, value.st_uid, value.st_gid,
            stat.S_IMODE(value.st_mode))


def directory_identity(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_nlink, value.st_uid,
            value.st_gid, stat.S_IMODE(value.st_mode))


class StrictJsonError(ValueError):
    """Raised before a JSON object with ambiguous semantics can be returned."""


def _validate_canonical_value(value: object) -> None:
    if value is None or type(value) in (str, bool):
        return
    if type(value) is int:
        if abs(value) > SAFE_JSON_INTEGER:
            raise StrictJsonError("JSON integer exceeds the canonical safe range")
        return
    if type(value) is list:
        for child in value:
            _validate_canonical_value(child)
        return
    if type(value) is dict:
        for key, child in value.items():
            if not key or re.search(r"[\x00-\x1f\x7f]", key):
                raise StrictJsonError("canonical JSON object key is invalid")
            _validate_canonical_value(child)
        return
    raise StrictJsonError("canonical JSON value type is invalid")


def canonical(value: object) -> bytes:
    _validate_canonical_value(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode()


def _strict_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise StrictJsonError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _strict_integer(value: str) -> int:
    result = int(value)
    if abs(result) > SAFE_JSON_INTEGER:
        raise StrictJsonError("JSON integer exceeds the canonical safe range")
    return result


def _reject_non_integer(_value: str) -> "NoReturn":
    raise StrictJsonError("canonical JSON permits only safe integers")


def parse_json_bytes(payload: bytes, label: str, *, canonical_bytes: bool) -> object:
    """Decode unique JSON semantics; canonicalize only candidate-owned bytes."""
    try:
        text = payload.decode("utf-8")
        value = json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_int=_strict_integer,
            parse_float=_reject_non_integer,
            parse_constant=_reject_non_integer,
        )
        if canonical_bytes and payload != canonical(value) + b"\n":
            refuse(f"{label} is not recursively canonical JSON")
        return value
    except SystemExit:
        raise
    except (UnicodeDecodeError, UnicodeEncodeError, json.JSONDecodeError,
            StrictJsonError, TypeError, ValueError):
        refuse(f"{label} is invalid or ambiguous JSON")


def parse_canonical_json(payload: bytes, label: str) -> object:
    return parse_json_bytes(payload, label, canonical_bytes=True)


def exact_object(value: object, keys: frozenset[str] | set[str]) -> bool:
    return type(value) is dict and set(value) == set(keys)


def safe_integer(value: object, *, minimum: int = 0,
                 maximum: int = SAFE_JSON_INTEGER) -> bool:
    return type(value) is int and minimum <= value <= maximum


def inherited_descriptor(value: str, *, directory: bool = False) -> int:
    if not re.fullmatch(r"[0-9]+", value):
        refuse("inherited candidate authority descriptor is invalid")
    descriptor = os.dup(int(value)); metadata = os.fstat(descriptor)
    if directory:
        if (not stat.S_ISDIR(metadata.st_mode) or
                (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) !=
                (os.getuid(), os.getgid(), 0o700)):
            os.close(descriptor); refuse("inherited candidate directory is unsafe")
    elif not stat.S_ISREG(metadata.st_mode):
        os.close(descriptor); refuse("inherited candidate file is unsafe")
    return descriptor


def open_candidate_file(candidate: int, name: str,
                        maximum: int) -> tuple[int, os.stat_result]:
    before = os.stat(name, dir_fd=candidate, follow_symlinks=False)
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
            before.st_size > maximum or
            (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) !=
            (os.getuid(), os.getgid(), 0o600)):
        refuse("candidate Compose input metadata is unsafe")
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=candidate)
    opened = os.fstat(descriptor)
    if identity(opened) != identity(before):
        os.close(descriptor); refuse("candidate Compose input moved before open")
    return descriptor, opened


def open_directory(path: str) -> int:
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        refuse("override parent is not canonical and absolute")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.split("/")[1:]:
            if not component or component in (".", ".."):
                refuse("override parent has an unsafe component")
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor); descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor); raise


def read_all(descriptor: int, metadata: os.stat_result) -> bytes:
    data = bytearray(); offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("override was truncated")
        data.extend(block); offset += len(block)
    if identity(os.fstat(descriptor)) != identity(metadata):
        refuse("override changed while reading")
    return bytes(data)


def hash_fd(descriptor: int, metadata: os.stat_result) -> str:
    return hashlib.sha256(read_all(descriptor, metadata)).hexdigest()


def open_owned_file(path: str, maximum: int, modes: tuple[int, ...]) -> tuple[int, os.stat_result]:
    parent = open_directory(os.path.dirname(path))
    try:
        name = os.path.basename(path)
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                (before.st_uid, before.st_gid) != (os.getuid(), os.getgid()) or
                stat.S_IMODE(before.st_mode) not in modes or before.st_size > maximum):
            refuse("held Compose input metadata is unsafe")
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        opened = os.fstat(descriptor)
        if identity(opened) != identity(before):
            os.close(descriptor); refuse("held Compose input moved before open")
        return descriptor, opened
    finally:
        os.close(parent)


def open_release_file(root: int, relative: str, entry: dict) -> tuple[int, os.stat_result]:
    descriptor = os.dup(root)
    try:
        parts = relative.split("/")
        for component in parts[:-1]:
            before = os.stat(component, dir_fd=descriptor, follow_symlinks=False)
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            opened = os.fstat(child)
            if (identity(opened) != identity(before) or not stat.S_ISDIR(opened.st_mode) or
                    (opened.st_uid, opened.st_gid) != (os.getuid(), os.getgid()) or
                    stat.S_IMODE(opened.st_mode) not in (0o700, 0o755)):
                os.close(child); refuse("release Compose ancestor is unsafe")
            os.close(descriptor); descriptor = child
        before = os.stat(parts[-1], dir_fd=descriptor, follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_size) !=
                (os.getuid(), os.getgid(), int(entry["mode"], 8), entry["size"])):
            refuse("release Compose file metadata differs from manifest")
        result = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
        opened = os.fstat(result)
        if identity(opened) != identity(before) or hash_fd(result, opened) != entry["sha256"]:
            os.close(result); refuse("release Compose file differs from manifest")
        return result, opened
    finally:
        os.close(descriptor)


def parse_release_manifest(payload: bytes, expected: str) -> dict[str, dict]:
    manifest = parse_json_bytes(payload, "release manifest", canonical_bytes=False)
    if not isinstance(manifest, dict) or set(manifest) != {
            "schemaVersion", "profile", "releaseId", "entries"}:
        refuse("release manifest schema is invalid")
    body = {"schemaVersion": manifest.get("schemaVersion"), "profile": manifest.get("profile"),
            "entries": manifest.get("entries")}
    canonical = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
    if (manifest.get("schemaVersion") != 1 or manifest.get("profile") != "vps" or
            manifest.get("releaseId") != expected or
            hashlib.sha256(canonical).hexdigest() != expected):
        refuse("release manifest does not reproduce the requested release ID")
    result = {}
    for entry in manifest.get("entries", []):
        name = entry.get("path") if isinstance(entry, dict) else None
        if (not isinstance(entry, dict) or set(entry) != {"path", "sha256", "size", "mode"} or
                not isinstance(name, str) or not name or name.startswith("/") or "\\" in name or
                any(part in ("", ".", "..") for part in name.split("/")) or name in result or
                entry.get("mode") not in ("0644", "0755") or
                not isinstance(entry.get("size"), int) or isinstance(entry.get("size"), bool) or
                entry["size"] < 0 or not SHA256.fullmatch(str(entry.get("sha256")))):
            refuse("release manifest entry is invalid")
        result[name] = entry
    if any(name not in result for name in COMPOSE_PATHS):
        refuse("release manifest omits production Compose authority")
    return result


def docker_environment() -> dict[str, str]:
    selected = {name: value for name, value in os.environ.items()
                if name.upper().startswith("DOCKER_")}
    if selected != {"DOCKER_CONFIG": EXPECTED_DOCKER_CONFIG,
                    "DOCKER_HOST": EXPECTED_DOCKER_HOST}:
        refuse("Docker daemon selection is not the pinned local endpoint")
    config = open_directory(EXPECTED_DOCKER_CONFIG)
    try:
        metadata = os.fstat(config)
        if ((metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) !=
                (os.getuid(), os.getgid(), 0o700) or os.listdir(config)):
            refuse("pinned Docker configuration directory is not empty and private")
    finally:
        os.close(config)
    return {
        "DOCKER_CONFIG": EXPECTED_DOCKER_CONFIG,
        "DOCKER_HOST": EXPECTED_DOCKER_HOST,
        "HOME": "/nonexistent",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/bin:/usr/sbin",
        "TZ": "UTC",
    }


def trusted_docker() -> str:
    path = "/usr/bin/docker"
    parent = os.stat("/usr/bin", follow_symlinks=False)
    before = os.stat(path, follow_symlinks=False)
    if (not stat.S_ISDIR(parent.st_mode) or (parent.st_uid, parent.st_gid) != (0, 0) or
            stat.S_IMODE(parent.st_mode) & 0o022 or not stat.S_ISREG(before.st_mode) or
            (before.st_uid, before.st_gid) != (0, 0) or
            stat.S_IMODE(before.st_mode) & 0o022 or not stat.S_IMODE(before.st_mode) & 0o111):
        refuse("reviewed Docker executable authority is unsafe")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        if identity(os.fstat(descriptor)) != identity(before):
            refuse("reviewed Docker executable moved before open")
    finally:
        os.close(descriptor)
    return path


def docker_output(docker: str, arguments: list[str], environment: dict[str, str]) -> str:
    result = subprocess.run([docker, *arguments], check=False, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=environment)
    if result.returncode != 0:
        refuse("Docker rejected an immutable image authority check")
    return result.stdout.strip()


def insert_override(command: list[str], override: str) -> list[str]:
    if command[:2] != ["docker", "compose"]:
        refuse("wrapped command is not Docker Compose")
    value_options = {"--project-name", "-p", "--env-file", "--file", "-f",
                     "--profile", "--project-directory", "--parallel", "--progress"}
    flag_options = {"--ansi", "--compatibility", "--dry-run"}
    index = 2
    while index < len(command):
        argument = command[index]
        if argument in value_options:
            if index + 1 >= len(command):
                refuse("Compose option is missing its value")
            index += 2; continue
        if any(argument.startswith(f"{option}=") for option in value_options):
            index += 1; continue
        if argument in flag_options or any(argument.startswith(f"{option}=") for option in flag_options):
            index += 1; continue
        break
    if index >= len(command) or command[index].startswith("-"):
        refuse("Compose subcommand could not be identified")
    subcommand = command[index]
    if subcommand == "up":
        trailing = command[index + 1:]
        pull_never = "--pull=never" in trailing or any(
            trailing[position:position + 2] == ["--pull", "never"]
            for position in range(len(trailing) - 1)
        )
        if not pull_never:
            refuse("Compose up is not offline-pinned")
        if "--no-build" not in trailing:
            refuse("Compose up can build mutable images")
    return [*command[:index], "--file", override, *command[index:]]


def compose_config_command(command: list[str]) -> list[str]:
    """Replace the requested consumer with an exact effective-model render."""
    if command[:2] != ["docker", "compose"]:
        refuse("effective-model command is not Docker Compose")
    value_options = {"--project-name", "-p", "--env-file", "--file", "-f",
                     "--profile", "--project-directory", "--parallel", "--progress"}
    flag_options = {"--ansi", "--compatibility", "--dry-run"}
    index = 2
    while index < len(command):
        argument = command[index]
        if argument in value_options:
            if index + 1 >= len(command):
                refuse("Compose option is missing its value")
            index += 2; continue
        if any(argument.startswith(f"{option}=") for option in value_options):
            index += 1; continue
        if argument in flag_options or any(argument.startswith(f"{option}=") for option in flag_options):
            index += 1; continue
        break
    if index >= len(command) or command[index].startswith("-"):
        refuse("Compose subcommand could not be identified")
    return [*command[:index], "config", "--format", "json"]


def bind_release_compose_files(command: list[str], release: str,
                               descriptors: dict[str, int]) -> list[str]:
    expected = {f"{release}/{relative}": f"/proc/{os.getpid()}/fd/{descriptors[relative]}"
                for relative in COMPOSE_PATHS}
    seen: set[str] = set(); result: list[str] = []; index = 0
    while index < len(command):
        argument = command[index]
        if argument in ("--file", "-f"):
            if index + 1 >= len(command) or command[index + 1] not in expected:
                refuse("Compose uses an unreviewed release file")
            path = command[index + 1]
            if path in seen:
                refuse("Compose release file is duplicated")
            seen.add(path); result.extend((argument, expected[path])); index += 2; continue
        matched = False
        for option in ("--file=", "-f="):
            if argument.startswith(option):
                path = argument[len(option):]
                if path not in expected or path in seen:
                    refuse("Compose uses an unreviewed or duplicate release file")
                seen.add(path); result.append(f"{option}{expected[path]}"); matched = True; break
        if not matched:
            result.append(argument)
        index += 1
    if seen != set(expected):
        refuse("Compose does not consume the exact reviewed release files")
    return result


def parse_override(payload: bytes) -> dict[str, dict[str, str]]:
    model = parse_canonical_json(payload, "image override")
    services = model.get("services") if isinstance(model, dict) and set(model) == {"services"} else None
    if (not isinstance(services, dict) or set(services) != EXPECTED_SERVICES or
            any(not isinstance(name, str) or not isinstance(service, dict) or
                set(service) != {"image"} or not IMAGE_ID.fullmatch(str(service.get("image")))
                for name, service in services.items())):
        refuse("override does not map every service to an immutable image ID")
    return services


def reviewed_image_authority(
        release_id: str) -> dict[str, tuple[str, str, bool, str | None]]:
    """Return exact reference *and local tag* authority, never receipt fields."""
    if not SHA256.fullmatch(release_id):
        refuse("release ID cannot instantiate reviewed image authority")
    authority: dict[str, tuple[str, str, bool, str | None]] = {
        role: (f"ai-pin-revival/{role}:{release_id}",
               f"ai-pin-revival/{role}:{release_id}", True, role)
        for role in ("cosmos", "center", "spotify-adapter")
    }
    authority.update({
        role: (reference, THIRD_PARTY_BUNDLE_REFERENCES[role], False, None)
        for role, reference in THIRD_PARTY_REFERENCES.items()
    })
    if (set(THIRD_PARTY_REFERENCES) != set(THIRD_PARTY_BUNDLE_REFERENCES) or
            set(authority) != set(SERVICE_ROLES.values()) | {"backup-helper"} or
            len(authority) != 10 or
            len({entry[0] for entry in authority.values()}) != 10 or
            len({entry[1] for entry in authority.values()}) != 10):
        refuse("internal reviewed image authority is not the exact ten-image inventory")
    return authority


def _registry_blob(value: object, label: str) -> tuple[bytes, object]:
    if not exact_object(value, {"bytesBase64", "digest", "mediaType", "size"}):
        refuse(f"{label} descriptor schema is invalid")
    encoded = value["bytesBase64"]
    digest = value["digest"]
    media_type = value["mediaType"]
    size = value["size"]
    if (type(encoded) is not str or len(encoded) > MAX_RECEIPT or
            re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", encoded) is None or
            type(digest) is not str or not IMAGE_ID.fullmatch(digest) or
            type(media_type) is not str or len(media_type) > 160 or
            re.fullmatch(r"application/[a-z0-9.+-]+", media_type) is None or
            not safe_integer(size, minimum=1, maximum=MAX_RECEIPT)):
        refuse(f"{label} descriptor value is invalid")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        refuse(f"{label} base64 is invalid")
    if (base64.b64encode(raw).decode("ascii") != encoded or len(raw) != size or
            f"sha256:{hashlib.sha256(raw).hexdigest()}" != digest):
        refuse(f"{label} raw preimage does not reproduce its descriptor")
    return raw, parse_json_bytes(raw, label, canonical_bytes=False)


def validate_registry_provenance(image: dict[str, object]) -> None:
    registry = image["registry"]
    if not exact_object(registry, {"index", "manifest"}):
        refuse("third-party registry provenance schema is invalid")
    _index_raw, index = _registry_blob(registry["index"], "registry index")
    _manifest_raw, manifest = _registry_blob(registry["manifest"], "registry platform manifest")
    index_record = registry["index"]
    manifest_record = registry["manifest"]
    if (index_record["digest"] != image["sourceDigest"] or
            index_record["mediaType"] not in OCI_INDEX_MEDIA_TYPES or
            type(index) is not dict or index.get("mediaType") != index_record["mediaType"] or
            type(index.get("schemaVersion")) is not int or index["schemaVersion"] != 2 or
            type(index.get("manifests")) is not list):
        refuse("third-party registry index provenance is invalid")
    selected = []
    for descriptor in index["manifests"]:
        platform = descriptor.get("platform") if type(descriptor) is dict else None
        if (type(platform) is dict and platform.get("os") == "linux" and
                platform.get("architecture") == "arm64"):
            selected.append(descriptor)
    if len(selected) != 1:
        refuse("registry index does not select one linux/arm64 manifest")
    child = selected[0]
    platform = child["platform"]
    missing = object()
    variant = platform.get("variant", missing)
    if (child.get("digest") != manifest_record["digest"] or
            child.get("size") != manifest_record["size"] or
            child.get("mediaType") != manifest_record["mediaType"] or
            type(child.get("digest")) is not str or
            not IMAGE_ID.fullmatch(child["digest"]) or
            variant not in (missing, "", "v8")):
        refuse("registry index child does not bind the platform manifest")
    manifest_media_type = manifest.get("mediaType", missing) if type(manifest) is dict else missing
    if (manifest_record["mediaType"] not in OCI_MANIFEST_MEDIA_TYPES or
            type(manifest) is not dict or
            type(manifest.get("schemaVersion")) is not int or
            manifest["schemaVersion"] != 2 or
            manifest_media_type not in (missing, manifest_record["mediaType"]) or
            type(manifest.get("layers")) is not list or not manifest["layers"]):
        refuse("registry platform manifest provenance is invalid")
    config = manifest.get("config")
    if (type(config) is not dict or type(config.get("digest")) is not str or
            not IMAGE_ID.fullmatch(config["digest"]) or
            config["digest"] != image["imageId"] or
            not safe_integer(config.get("size"), minimum=1) or
            config.get("mediaType") not in OCI_CONFIG_MEDIA_TYPES):
        refuse("registry image config descriptor is invalid")
    for layer in manifest["layers"]:
        if (type(layer) is not dict or type(layer.get("digest")) is not str or
                not IMAGE_ID.fullmatch(layer["digest"]) or
                not safe_integer(layer.get("size"), minimum=1) or
                type(layer.get("mediaType")) is not str or
                re.match(r"application/vnd\.(?:oci|docker)\.", layer["mediaType"]) is None):
            refuse("registry layer descriptor is invalid")


def validate_compose_model(model: object, release_id: str,
                           reviewed_by_role: dict[str, tuple[str, str, bool, str | None]]) -> None:
    if (not exact_object(model, {
            "authority", "composeFiles", "releaseId", "schema", "schemaVersion", "services"}) or
            model["schema"] != "revival.production-compose-model" or
            type(model["schemaVersion"]) is not int or model["schemaVersion"] != 1 or
            model["releaseId"] != release_id):
        refuse("Compose model top-level schema/release binding is invalid")
    authority = model["authority"]
    if (not exact_object(authority, {"path", "sha256"}) or
            authority["path"] != PRODUCTION_AUTHORITY_PATH or
            type(authority["sha256"]) is not str or
            not SHA256.fullmatch(authority["sha256"])):
        refuse("Compose model authority binding is invalid")
    compose_files = model["composeFiles"]
    if (not exact_object(compose_files, set(COMPOSE_PATHS)) or
            any(type(compose_files[name]) is not str or
                not SHA256.fullmatch(compose_files[name]) for name in COMPOSE_PATHS)):
        refuse("Compose model source-file binding is invalid")
    if not exact_object(model["services"], set(EXPECTED_SERVICES)):
        refuse("Compose model does not contain the exact production service set")
    for name, mapping in model["services"].items():
        if not exact_object(mapping, {"imageId", "reference", "role"}):
            refuse("Compose service mapping schema is invalid")
        expected_role = SERVICE_ROLES[name]
        expected_reference = reviewed_by_role[expected_role][0]
        if (type(mapping["imageId"]) is not str or not IMAGE_ID.fullmatch(mapping["imageId"]) or
                mapping["reference"] != expected_reference or mapping["role"] != expected_role):
            refuse("Compose service mapping differs from exact reviewed authority")


def validate_image_authority(
        images: object, model: object, release_id: str, source_git: object,
        helper_reference: str = BACKUP_HELPER_REFERENCE) -> tuple[
            dict[str, dict[str, str]], dict[str, str]]:
    """Independently validate every image/model field before Compose."""
    if helper_reference != BACKUP_HELPER_REFERENCE:
        refuse("backup helper reference differs from fixed authenticated authority")
    if (not exact_object(source_git, {"commit", "tree"}) or
            type(source_git["commit"]) is not str or
            type(source_git["tree"]) is not str or
            not GIT_OBJECT_ID.fullmatch(source_git["commit"]) or
            not GIT_OBJECT_ID.fullmatch(source_git["tree"])):
        refuse("candidate Git source binding is invalid")
    if type(images) is not list or len(images) != 10:
        refuse("candidate image receipt is not the fixed ten-image inventory")
    reviewed_by_role = reviewed_image_authority(release_id)
    reviewed_by_reference = {
        reference: (role, bundle_reference, first_party, component)
        for role, (reference, bundle_reference, first_party, component)
        in reviewed_by_role.items()
    }
    reference_ids: dict[str, tuple[str, str]] = {}
    bundle_references: set[str] = set()
    image_ids: set[str] = set()
    previous = ""
    for image in images:
        if not exact_object(image, set(IMAGE_KEYS)):
            refuse("candidate image row schema is not the exact nine-field contract")
        reference = image["reference"]
        bundle_reference = image["bundleReference"]
        image_id = image["imageId"]
        first_party = image["firstParty"]
        expected = reviewed_by_reference.get(reference) if type(reference) is str else None
        if (expected is None or type(bundle_reference) is not str or
                bundle_reference != expected[1] or
                type(image_id) is not str or not IMAGE_ID.fullmatch(image_id) or
                reference <= previous or reference in reference_ids or
                bundle_reference in bundle_references or image_id in image_ids or
                type(first_party) is not bool or first_party is not expected[2] or
                image["component"] != expected[3] or image["platform"] != "linux/arm64"):
            refuse("candidate image differs from exact reference/tag/ID/platform authority")
        role = expected[0]
        if first_party:
            labels = image["labels"]
            expected_labels = {
                "dk.andersmadsen.ai-pin-revival.component": expected[3],
                "dk.andersmadsen.ai-pin-revival.product": "Ai Pin Revival",
                "dk.andersmadsen.ai-pin-revival.release": release_id,
                "dk.andersmadsen.ai-pin-revival.source-commit": source_git["commit"],
                "dk.andersmadsen.ai-pin-revival.source-tree": source_git["tree"],
                "org.opencontainers.image.revision": source_git["commit"],
            }
            if (not exact_object(labels, set(FIRST_PARTY_LABEL_KEYS)) or
                    labels != expected_labels or image["sourceDigest"] is not None or
                    image["registry"] is not None):
                refuse("first-party image labels/null provenance are invalid")
        else:
            expected_source_digest = reference.rsplit("@", 1)[1]
            if (image["labels"] is not None or image["component"] is not None or
                    type(image["sourceDigest"]) is not str or
                    image["sourceDigest"] != expected_source_digest or
                    not IMAGE_ID.fullmatch(image["sourceDigest"])):
                refuse("third-party image null/source provenance is invalid")
            validate_registry_provenance(image)
        reference_ids[reference] = (image_id, role)
        bundle_references.add(bundle_reference); image_ids.add(image_id)
        previous = reference
    if set(reference_ids) != set(reviewed_by_reference) or len(image_ids) != 10:
        refuse("candidate image reference/content-ID set differs from reviewed authority")

    validate_compose_model(model, release_id, reviewed_by_role)
    expected_override: dict[str, dict[str, str]] = {}
    expected_references: dict[str, str] = {}
    service_references: set[str] = set()
    service_image_ids: set[str] = set()
    for service, mapping in model["services"].items():
        reference = mapping["reference"]
        role = mapping["role"]
        model_image_id = mapping["imageId"]
        if (reference not in reference_ids or reference_ids[reference][1] != role or
                model_image_id != reference_ids[reference][0]):
            refuse("candidate Compose service differs from exact receipt content ID")
        expected_override[service] = {"image": model_image_id}
        expected_references[service] = reference
        service_references.add(reference); service_image_ids.add(model_image_id)
    if len(service_references) != 9 or len(service_image_ids) != 9:
        refuse("candidate Compose model does not resolve to nine distinct service images")
    helper = reference_ids.get(helper_reference)
    if (helper is None or helper[1] != "backup-helper" or helper[0] in service_image_ids):
        refuse("candidate backup helper descriptor is missing, aliased, or has the wrong role")
    if service_references | {helper_reference} != set(reference_ids):
        refuse("candidate Compose and backup helper do not consume the exact image inventory")
    return expected_override, expected_references


def validate_image_receipt(
        receipt: object, model: object, release_id: str, source_git: object,
        bundle_digest: str, bundle_size: int,
        helper_reference: str = BACKUP_HELPER_REFERENCE) -> tuple[
            dict[str, dict[str, str]], dict[str, str]]:
    if (not exact_object(receipt, set(RECEIPT_KEYS)) or
            receipt["schema"] != "revival.docker-image-receipt" or
            type(receipt["schemaVersion"]) is not int or receipt["schemaVersion"] != 4 or
            receipt["platform"] != "linux/amd64" or
            receipt["targetPlatform"] != "linux/arm64" or
            type(bundle_digest) is not str or not SHA256.fullmatch(bundle_digest) or
            not safe_integer(bundle_size, maximum=MAX_BUNDLE) or
            not exact_object(receipt["bundle"], {"sha256", "size"}) or
            receipt["bundle"]["sha256"] != bundle_digest or
            receipt["bundle"]["size"] != bundle_size or
            type(receipt["bundle"]["sha256"]) is not str or
            type(receipt["bundle"]["size"]) is not int):
        refuse("candidate image receipt top-level/bundle schema is invalid")
    return validate_image_authority(
        receipt["images"], model, release_id, source_git, helper_reference)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-parent-fd", required=True)
    parser.add_argument("--candidate-fd", required=True)
    parser.add_argument("--candidate-name", required=True)
    parser.add_argument("--record-parent-fd", required=True)
    parser.add_argument("--record-fd", required=True)
    parser.add_argument("--record-name", required=True)
    parser.add_argument("--compose-model-fd", required=True)
    parser.add_argument("--compose-model-sha256", required=True)
    parser.add_argument("--authority-receipt-fd", required=True)
    parser.add_argument("--authority-receipt-sha256", required=True)
    parser.add_argument("--authority-receipt-name", required=True)
    parser.add_argument("--candidate-id", required=True)
    parser.add_argument("--override-name", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    if arguments.command[:1] == ["--"]:
        arguments.command = arguments.command[1:]
    if (not SHA256.fullmatch(arguments.sha256) or
            not SHA256.fullmatch(arguments.candidate_id) or
            not SHA256.fullmatch(arguments.compose_model_sha256) or
            not SHA256.fullmatch(arguments.authority_receipt_sha256)):
        refuse("candidate Compose digest is invalid")
    if (not SHA256.fullmatch(arguments.release_id) or
            arguments.release != f"{REMOTE_ROOT}/releases/{arguments.release_id}" or
            arguments.manifest != f"{REMOTE_ROOT}/manifests/{arguments.release_id}.json"):
        refuse("release Compose authority is outside the protected stores")
    if (arguments.candidate_name != arguments.candidate_id or
            not re.fullmatch(r"[A-Za-z0-9._-]{8,96}", arguments.record_name) or
            not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", arguments.override_name) or
            not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", arguments.authority_receipt_name)):
        refuse("candidate, record, override, or receipt name is invalid")
    candidate_parent = inherited_descriptor(arguments.candidate_parent_fd, directory=True)
    candidate = inherited_descriptor(arguments.candidate_fd, directory=True)
    record_parent = inherited_descriptor(arguments.record_parent_fd, directory=True)
    record = inherited_descriptor(arguments.record_fd, directory=True)
    model_fd = inherited_descriptor(arguments.compose_model_fd)
    authority_fd = inherited_descriptor(arguments.authority_receipt_fd)
    descriptor = candidate_descriptor_fd = candidate_model_fd = image_receipt_fd = -1
    manifest_fd = -1
    release_root = -1
    compose_files: dict[str, tuple[int, os.stat_result]] = {}
    try:
        candidate_meta = os.fstat(candidate); record_meta = os.fstat(record)
        if candidate_meta.st_nlink != 2 or set(os.listdir(candidate)) != EXPECTED_CANDIDATE_FILES:
            refuse("candidate Compose directory inventory is unsafe")
        candidate_descriptor_fd, candidate_descriptor_meta = open_candidate_file(
            candidate, "candidate.json", MAX_OVERRIDE)
        candidate_model_fd, candidate_model_meta = open_candidate_file(
            candidate, "compose-model.json", MAX_RECEIPT)
        image_receipt_fd, image_receipt_meta = open_candidate_file(
            candidate, "image-receipt.json", MAX_RECEIPT)
        candidate_descriptor_bytes = read_all(candidate_descriptor_fd, candidate_descriptor_meta)
        candidate_model_bytes = read_all(candidate_model_fd, candidate_model_meta)
        image_receipt_bytes = read_all(image_receipt_fd, image_receipt_meta)
        model_meta = os.fstat(model_fd); authority_meta = os.fstat(authority_fd)
        if model_meta.st_size > MAX_RECEIPT or authority_meta.st_size > MAX_RECEIPT:
            refuse("held candidate model/authority exceeds its receipt bound")
        model_bytes = read_all(model_fd, model_meta); authority_bytes = read_all(authority_fd, authority_meta)
        candidate_descriptor = parse_canonical_json(
            candidate_descriptor_bytes, "candidate descriptor")
        model = parse_canonical_json(model_bytes, "Compose model")
        authority = parse_canonical_json(authority_bytes, "candidate Compose authority")
        image_receipt = parse_canonical_json(image_receipt_bytes, "Docker image receipt")
        if (model_bytes != candidate_model_bytes or
                hashlib.sha256(model_bytes).hexdigest() != arguments.compose_model_sha256 or
                hashlib.sha256(authority_bytes).hexdigest() != arguments.authority_receipt_sha256 or
                model_meta.st_nlink != 0 or stat.S_IMODE(model_meta.st_mode) != 0o600 or
                fcntl.fcntl(model_fd, fcntl.F_GET_SEALS) & REQUIRED_SEALS != REQUIRED_SEALS):
            refuse("held candidate Compose model/receipt differs from sealed authority")
        body = candidate_descriptor.get("body") if type(candidate_descriptor) is dict else None
        if (type(candidate_descriptor) is not dict or
                candidate_descriptor.get("schema") != "revival.release-candidate" or
                candidate_descriptor.get("schemaVersion") != 4 or
                candidate_descriptor.get("candidateId") != arguments.candidate_id or
                not isinstance(body, dict) or
                hashlib.sha256(canonical(body)).hexdigest() != arguments.candidate_id or
                not isinstance(body.get("release"), dict) or
                body["release"].get("id") != arguments.release_id):
            refuse("candidate descriptor does not reproduce Compose authority")
        if body.get("authority") not in (
                {"origin": "local-operator", "productionUse": "candidate-only"},
                {"origin": "github-hosted-actions", "productionUse": "requires-point-of-use-provider-evidence"}):
            refuse("candidate authority origin is unsupported")
        source_git = body.get("git")
        if (not exact_object(source_git, {"commit", "tree"}) or
                type(source_git["commit"]) is not str or
                type(source_git["tree"]) is not str or
                not GIT_OBJECT_ID.fullmatch(source_git["commit"]) or
                not GIT_OBJECT_ID.fullmatch(source_git["tree"])):
            refuse("candidate descriptor Git binding is invalid")
        files = {entry.get("role"): entry for entry in body.get("files", [])
                 if isinstance(entry, dict)}
        model_entry = files.get("production-compose-model")
        receipt_entry = files.get("docker-image-receipt")
        bundle_entry = files.get("docker-image-bundle")
        if (not isinstance(model_entry, dict) or not isinstance(receipt_entry, dict) or
                not isinstance(bundle_entry, dict) or
                model_entry.get("sha256") != arguments.compose_model_sha256 or
                model_entry.get("size") != len(model_bytes) or
                body.get("composeModel") != {"digest": arguments.compose_model_sha256,
                                             "role": "production-compose-model"} or
                receipt_entry.get("sha256") != hashlib.sha256(image_receipt_bytes).hexdigest() or
                receipt_entry.get("size") != len(image_receipt_bytes) or
                type(bundle_entry.get("sha256")) is not str or
                not SHA256.fullmatch(bundle_entry["sha256"]) or
                not safe_integer(bundle_entry.get("size")) or
                body.get("images") != {
                    "bundleDigest": bundle_entry["sha256"],
                    "bundleRole": "docker-image-bundle",
                    "receiptDigest": receipt_entry["sha256"],
                    "receiptRole": "docker-image-receipt",
                }):
            refuse("candidate descriptor does not bind model/image receipt bytes")
        expected_authority = {
            "schema": "revival.candidate-compose-authority", "schemaVersion": 1,
            "candidate": {"dev": candidate_meta.st_dev, "id": arguments.candidate_id,
                          "ino": candidate_meta.st_ino},
            "model": {"sha256": arguments.compose_model_sha256, "size": len(model_bytes)},
            "record": {"dev": record_meta.st_dev, "ino": record_meta.st_ino,
                       "name": arguments.record_name},
            "releaseId": arguments.release_id,
        }
        if authority != expected_authority:
            refuse("record receipt does not bind exact candidate/model/record authority")
        expected_override, expected_references = validate_image_receipt(
            image_receipt, model, arguments.release_id, source_git,
            bundle_entry["sha256"], bundle_entry["size"])

        manifest_fd, manifest_meta = open_owned_file(arguments.manifest, MAX_MANIFEST, (0o600,))
        entries = parse_release_manifest(read_all(manifest_fd, manifest_meta), arguments.release_id)
        release_root = open_directory(arguments.release)
        release_root_meta = os.fstat(release_root)
        if (not stat.S_ISDIR(release_root_meta.st_mode) or
                (release_root_meta.st_uid, release_root_meta.st_gid,
                 stat.S_IMODE(release_root_meta.st_mode)) !=
                (os.getuid(), os.getgid(), 0o700)):
            refuse("release root authority is unsafe")
        for relative in COMPOSE_PATHS:
            compose_files[relative] = open_release_file(release_root, relative, entries[relative])
        name = arguments.override_name
        before = os.stat(name, dir_fd=record, follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) !=
                (os.getuid(), os.getgid(), 0o600) or before.st_size > MAX_OVERRIDE):
            refuse("override metadata is unsafe")
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=record)
        opened = os.fstat(descriptor)
        if identity(opened) != identity(before):
            refuse("override moved before open")
        payload = read_all(descriptor, opened)
        if hashlib.sha256(payload).hexdigest() != arguments.sha256:
            refuse("override digest differs from candidate runtime evidence")
        services = parse_override(payload)
        if services != expected_override:
            refuse("override service-to-content-ID mapping differs from candidate model")
        docker = trusted_docker()
        base_command = bind_release_compose_files(
            arguments.command, arguments.release,
            {name: value[0] for name, value in compose_files.items()})
        command = insert_override(base_command, f"/proc/{os.getpid()}/fd/{descriptor}")
        command[0] = docker
        environment = docker_environment()

        def assert_candidate_authority() -> None:
            if (directory_identity(os.fstat(candidate)) != directory_identity(candidate_meta) or
                    directory_identity(os.stat(arguments.candidate_name, dir_fd=candidate_parent,
                                               follow_symlinks=False)) != directory_identity(candidate_meta) or
                    set(os.listdir(candidate)) != EXPECTED_CANDIDATE_FILES or
                    directory_identity(os.fstat(record)) != directory_identity(record_meta) or
                    directory_identity(os.stat(arguments.record_name, dir_fd=record_parent,
                                               follow_symlinks=False)) != directory_identity(record_meta)):
                refuse("candidate or deployment-record directory moved through Compose use")
            for held, metadata, digest in (
                    (candidate_descriptor_fd, candidate_descriptor_meta,
                     hashlib.sha256(candidate_descriptor_bytes).hexdigest()),
                    (candidate_model_fd, candidate_model_meta, arguments.compose_model_sha256),
                    (model_fd, model_meta, arguments.compose_model_sha256),
                    (authority_fd, authority_meta, arguments.authority_receipt_sha256),
                    (image_receipt_fd, image_receipt_meta,
                     hashlib.sha256(image_receipt_bytes).hexdigest())):
                if (identity(os.fstat(held)) != identity(metadata) or
                        hash_fd(held, metadata) != digest):
                    refuse("held candidate model/receipt changed through Compose use")
            if (identity(os.stat("compose-model.json", dir_fd=candidate,
                                follow_symlinks=False)) != identity(candidate_model_meta) or
                    identity(os.stat(arguments.authority_receipt_name, dir_fd=record,
                                     follow_symlinks=False)) != identity(authority_meta) or
                    identity(os.stat(arguments.override_name, dir_fd=record,
                                     follow_symlinks=False)) != identity(opened)):
                refuse("candidate model, authority receipt, or override name changed")

        assert_candidate_authority()
        rendered_command = compose_config_command(base_command)
        rendered_command[0] = docker
        rendered = subprocess.run(rendered_command, check=False, text=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  env=environment,
                                  pass_fds=(manifest_fd, release_root,
                                            *(value[0] for value in compose_files.values())))
        if rendered.returncode != 0:
            refuse("held authentic Compose could not render its effective model")
        effective = parse_json_bytes(
            rendered.stdout.encode("utf-8"), "held authentic Compose model",
            canonical_bytes=False)
        actual_services = effective.get("services") if isinstance(effective, dict) else None
        if (not isinstance(actual_services, dict) or set(actual_services) != EXPECTED_SERVICES or
                any(not isinstance(actual_services[name], dict) or
                    actual_services[name].get("image") != expected_references[name]
                    for name in EXPECTED_SERVICES)):
            refuse("held authentic Compose service references differ from candidate model")
        assert_candidate_authority()
        image_ids = sorted({service["image"] for service in services.values()})
        for image_id in image_ids:
            if docker_output(docker, ["image", "inspect", "--format", "{{.Id}}", image_id], environment) != image_id:
                refuse("Compose image content ID is unavailable before use")
        inherited = (descriptor, manifest_fd, release_root, candidate_parent,
                     candidate, record_parent, record, model_fd, authority_fd,
                     candidate_descriptor_fd, candidate_model_fd, image_receipt_fd,
                     *(value[0] for value in compose_files.values()))
        result = subprocess.run(command, check=False, env=environment, pass_fds=inherited)
        for image_id in image_ids:
            if docker_output(docker, ["image", "inspect", "--format", "{{.Id}}", image_id], environment) != image_id:
                refuse("Compose image content ID changed through use")
        assert_candidate_authority()
        current = os.stat(name, dir_fd=record, follow_symlinks=False)
        if identity(current) != identity(opened) or identity(os.fstat(descriptor)) != identity(opened):
            refuse("override name or descriptor changed through Compose use")
        if hashlib.sha256(read_all(descriptor, opened)).hexdigest() != arguments.sha256:
            refuse("override bytes changed through Compose use")
        if identity(os.fstat(manifest_fd)) != identity(manifest_meta):
            refuse("release manifest changed through Compose use")
        rebound_manifest, rebound_manifest_meta = open_owned_file(
            arguments.manifest, MAX_MANIFEST, (0o600,))
        try:
            if identity(rebound_manifest_meta) != identity(manifest_meta):
                refuse("release manifest name no longer resolves to held object")
        finally:
            os.close(rebound_manifest)
        reopened_root = open_directory(arguments.release)
        try:
            if identity(os.fstat(reopened_root)) != identity(release_root_meta):
                refuse("release root name changed through Compose use")
        finally:
            os.close(reopened_root)
        for relative, (file_descriptor, file_meta) in compose_files.items():
            if (identity(os.fstat(file_descriptor)) != identity(file_meta) or
                    hash_fd(file_descriptor, file_meta) != entries[relative]["sha256"]):
                refuse("release Compose bytes changed through use")
            rebound, rebound_meta = open_release_file(release_root, relative, entries[relative])
            try:
                if identity(rebound_meta) != identity(file_meta):
                    refuse("release Compose name no longer resolves to held object")
            finally:
                os.close(rebound)
        raise SystemExit(result.returncode)
    finally:
        for file_descriptor, _ in compose_files.values():
            try: os.close(file_descriptor)
            except OSError: pass
        if release_root >= 0:
            os.close(release_root)
        if manifest_fd >= 0:
            os.close(manifest_fd)
        if descriptor >= 0:
            os.close(descriptor)
        for held in (image_receipt_fd, candidate_model_fd, candidate_descriptor_fd,
                     authority_fd, model_fd, record, record_parent, candidate,
                     candidate_parent):
            if held >= 0:
                try: os.close(held)
                except OSError: pass


if __name__ == "__main__":
    main()
