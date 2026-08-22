#!/usr/bin/env python3
"""Load one verified candidate's Docker objects from descriptor-held files.

The caller runs the full filesystem-only JavaScript candidate verifier first.
This helper then closes the path/use gap at the daemon mutation boundary: it
opens every ancestor without following links, recomputes the requested
candidate ID and the receipt/bundle bindings from held descriptors, writes the
runtime evidence and Compose override exclusively, and gives Docker that same
already-open bundle. No candidate-controlled pathname is reopened after the
first daemon mutation.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys


SHA256 = re.compile(r"^[0-9a-f]{64}$")
DOCKER_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_OBJECT_ID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
SAFE_JSON_INTEGER = 9_007_199_254_740_991
MAX_DESCRIPTOR = 2 * 1024 * 1024
MAX_RECEIPT = 8 * 1024 * 1024
MAX_BUNDLE = 32 * 1024 * 1024 * 1024
REMOTE_ROOT = "/home/anders/ai-pin-revival"
EXPECTED_DOCKER_HOST = "unix:///var/run/docker.sock"
EXPECTED_DOCKER_CONFIG = f"{REMOTE_ROOT}/private/docker-cli-empty"
PRODUCTION_AUTHORITY_PATH = "platform/deploy/production-compose-authority.json"
COMPOSE_PATHS = ("compose.yaml", "platform/compose/production.yaml")
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
    raise SystemExit(f"candidate runtime refusal: {message}")


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
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


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
    """Parse once, rejecting duplicate keys and number ambiguity at the decoder.

    Candidate JSON payloads use the producer's recursively sorted compact form
    plus one LF. Registry preimages are authenticated raw HTTP bytes, so their
    whitespace is retained, but their JSON semantics must still be unique.
    """
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


def open_directory(path: str) -> int:
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        refuse("directory path is not canonical and absolute")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.split("/")[1:]:
            if not component or component in (".", ".."):
                refuse("directory path contains an unsafe component")
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def file_identity(metadata: os.stat_result) -> tuple[int, ...]:
    return (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns,
            metadata.st_ctime_ns, metadata.st_nlink, metadata.st_uid, metadata.st_gid,
            stat.S_IMODE(metadata.st_mode))


def directory_identity(metadata: os.stat_result) -> tuple[int, ...]:
    return (metadata.st_dev, metadata.st_ino, metadata.st_nlink,
            metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode))


def inherited_descriptor(value: str, *, directory: bool = False) -> int:
    if not re.fullmatch(r"[0-9]+", value):
        refuse("inherited candidate authority descriptor is invalid")
    descriptor = os.dup(int(value))
    metadata = os.fstat(descriptor)
    if directory:
        if (not stat.S_ISDIR(metadata.st_mode) or
                (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) !=
                (os.getuid(), os.getgid(), 0o700)):
            os.close(descriptor); refuse("inherited candidate directory is unsafe")
    elif not stat.S_ISREG(metadata.st_mode):
        os.close(descriptor); refuse("inherited candidate file is unsafe")
    return descriptor


def open_regular(directory: int, name: str, maximum: int) -> tuple[int, os.stat_result]:
    if not name or "/" in name or name in (".", ".."):
        refuse("candidate filename is unsafe")
    before = os.stat(name, dir_fd=directory, follow_symlinks=False)
    if (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or
            before.st_nlink != 1 or before.st_size > maximum or
            (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) !=
            (os.getuid(), os.getgid(), 0o600)):
        refuse(f"candidate input has unsafe metadata: {name}")
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    opened = os.fstat(descriptor)
    if file_identity(opened) != file_identity(before):
        os.close(descriptor)
        refuse(f"candidate input moved before open: {name}")
    return descriptor, opened


def read_bounded(descriptor: int, metadata: os.stat_result, maximum: int) -> bytes:
    if metadata.st_size > maximum:
        refuse("candidate input exceeds its bound")
    output = bytearray()
    offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("candidate input was truncated")
        output.extend(block); offset += len(block)
    if file_identity(os.fstat(descriptor)) != file_identity(metadata):
        refuse("candidate input moved while reading")
    return bytes(output)


def digest_fd(descriptor: int, metadata: os.stat_result) -> str:
    digest = hashlib.sha256(); offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("candidate bundle was truncated")
        digest.update(block); offset += len(block)
    if file_identity(os.fstat(descriptor)) != file_identity(metadata):
        refuse("candidate bundle moved while hashing")
    return digest.hexdigest()


def write_once(directory: int, name: str, payload: bytes) -> str:
    """Publish immutable evidence once, or accept only an identical prior value.

    Rollback is resumable, so its record may already contain the output from a
    previous attempt.  It is never replaced or truncated: an existing object is
    opened without following links and must be the exact safe regular file this
    invocation would have created.
    """
    def accept_existing() -> bool:
        try:
            descriptor, metadata = open_regular(directory, name, MAX_RECEIPT)
        except FileNotFoundError:
            return False
        try:
            if read_bounded(descriptor, metadata, MAX_RECEIPT) != payload:
                refuse(f"existing runtime evidence conflicts: {name}")
        finally:
            os.close(descriptor)
        return True

    if accept_existing():
        return hashlib.sha256(payload).hexdigest()
    if not hasattr(os, "O_TMPFILE"):
        refuse("anonymous atomic evidence publication is unavailable")
    try:
        descriptor = os.open(".", os.O_WRONLY | os.O_TMPFILE, 0o600, dir_fd=directory)
    except OSError as error:
        refuse(f"anonymous atomic evidence publication failed: {error}")
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
        linkat = getattr(ctypes.CDLL(None, use_errno=True), "linkat", None)
        if linkat is None:
            refuse("linkat is unavailable for atomic evidence publication")
        if linkat(descriptor, b"", directory, os.fsencode(name), 0x1000):
            error = ctypes.get_errno()
            if error != errno.EEXIST:
                raise OSError(error, os.strerror(error))
            if not accept_existing():
                refuse(f"runtime evidence destination disappeared: {name}")
        else:
            os.fsync(directory)
    finally:
        os.close(descriptor)
    return hashlib.sha256(payload).hexdigest()


def docker_environment() -> dict[str, str]:
    docker_variables = {name: value for name, value in os.environ.items()
                        if name.upper().startswith("DOCKER_")}
    if docker_variables != {
        "DOCKER_CONFIG": EXPECTED_DOCKER_CONFIG,
        "DOCKER_HOST": EXPECTED_DOCKER_HOST,
    }:
        refuse("Docker daemon selection is not the pinned local production endpoint")
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


def docker_output(docker: str, arguments: list[str], environment: dict[str, str]) -> str:
    result = subprocess.run([docker, *arguments], check=False, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=environment)
    if result.returncode != 0:
        refuse("Docker rejected a sealed local image operation")
    return result.stdout.strip()


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
        if file_identity(os.fstat(descriptor)) != file_identity(before):
            refuse("reviewed Docker executable moved before open")
    finally:
        os.close(descriptor)
    return path


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
            type(digest) is not str or not DOCKER_ID.fullmatch(digest) or
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
            not DOCKER_ID.fullmatch(child["digest"]) or
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
            not DOCKER_ID.fullmatch(config["digest"]) or
            config["digest"] != image["imageId"] or
            not safe_integer(config.get("size"), minimum=1) or
            config.get("mediaType") not in OCI_CONFIG_MEDIA_TYPES):
        refuse("registry image config descriptor is invalid")
    for layer in manifest["layers"]:
        if (type(layer) is not dict or type(layer.get("digest")) is not str or
                not DOCKER_ID.fullmatch(layer["digest"]) or
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
        if (type(mapping["imageId"]) is not str or not DOCKER_ID.fullmatch(mapping["imageId"]) or
                mapping["reference"] != expected_reference or mapping["role"] != expected_role):
            refuse("Compose service mapping differs from exact reviewed authority")


def validate_image_authority(
        images: object, model: object, release_id: str, source_git: object,
        helper_reference: str = BACKUP_HELPER_REFERENCE) -> tuple[
            dict[str, tuple[str, str, str]], dict[str, dict[str, str]], list[str]]:
    """Pure, pre-daemon validation of every image/model field and mapping."""
    if helper_reference != BACKUP_HELPER_REFERENCE:
        refuse("backup helper reference differs from fixed authenticated authority")
    if (not exact_object(source_git, {"commit", "tree"}) or
            type(source_git["commit"]) is not str or
            type(source_git["tree"]) is not str or
            not GIT_OBJECT_ID.fullmatch(source_git["commit"]) or
            not GIT_OBJECT_ID.fullmatch(source_git["tree"])):
        refuse("candidate Git source binding is invalid")
    if type(images) is not list or len(images) != 10:
        refuse("image receipt is not the exact ten-image inventory")
    reviewed_by_role = reviewed_image_authority(release_id)
    reviewed_by_reference = {
        reference: (role, bundle_reference, first_party, component)
        for role, (reference, bundle_reference, first_party, component)
        in reviewed_by_role.items()
    }
    references: dict[str, tuple[str, str, str]] = {}
    bundle_references: set[str] = set()
    image_ids: set[str] = set()
    previous = ""
    evidence_rows: list[str] = []
    for image in images:
        if not exact_object(image, set(IMAGE_KEYS)):
            refuse("image receipt row schema is not the exact nine-field contract")
        reference = image["reference"]
        bundle_reference = image["bundleReference"]
        image_id = image["imageId"]
        first_party = image["firstParty"]
        expected = reviewed_by_reference.get(reference) if type(reference) is str else None
        if (expected is None or type(bundle_reference) is not str or
                bundle_reference != expected[1] or
                type(image_id) is not str or not DOCKER_ID.fullmatch(image_id) or
                reference <= previous or reference in references or
                bundle_reference in bundle_references or image_id in image_ids or
                type(first_party) is not bool or first_party is not expected[2] or
                image["component"] != expected[3] or image["platform"] != "linux/arm64"):
            refuse("image receipt differs from exact reference/tag/ID/platform authority")
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
                    not DOCKER_ID.fullmatch(image["sourceDigest"])):
                refuse("third-party image null/source provenance is invalid")
            validate_registry_provenance(image)
        # Runtime tagging deliberately consumes the code-reviewed tag, never
        # even a receipt value that happened to compare equal above.
        references[reference] = (reviewed_by_role[role][1], image_id, role)
        bundle_references.add(bundle_reference); image_ids.add(image_id)
        evidence_rows.append(f"{reference}\t{reviewed_by_role[role][1]}\t{image_id}\n")
        previous = reference
    if set(references) != set(reviewed_by_reference) or len(image_ids) != 10:
        refuse("image receipt reference/content-ID set differs from reviewed authority")

    validate_compose_model(model, release_id, reviewed_by_role)
    services: dict[str, dict[str, str]] = {}
    configured_references: set[str] = set()
    configured_image_ids: set[str] = set()
    for name, mapping in model["services"].items():
        reference = mapping["reference"]
        role = mapping["role"]
        model_image_id = mapping["imageId"]
        if (reference not in references or references[reference][2] != role or
                model_image_id != references[reference][1]):
            refuse("Compose service image differs from exact receipt content ID")
        services[name] = {"image": model_image_id}
        configured_references.add(reference); configured_image_ids.add(model_image_id)
    if len(configured_references) != 9 or len(configured_image_ids) != 9:
        refuse("Compose model does not resolve to nine distinct service images")
    helper = references.get(helper_reference)
    if (helper is None or helper[2] != "backup-helper" or helper[1] in configured_image_ids):
        refuse("backup helper descriptor is missing, aliased, or has the wrong role")
    if configured_references | {helper_reference} != set(references):
        refuse("Compose and backup helper do not consume the exact image inventory")
    return references, services, evidence_rows


def validate_image_receipt(
        receipt: object, model: object, release_id: str, source_git: object,
        bundle_digest: str, bundle_size: int,
        helper_reference: str = BACKUP_HELPER_REFERENCE) -> tuple[
            dict[str, tuple[str, str, str]], dict[str, dict[str, str]], list[str]]:
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
        refuse("image receipt top-level/bundle schema is invalid")
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
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--evidence-name", required=True)
    parser.add_argument("--override-name", required=True)
    parser.add_argument("--helper-reference", required=True)
    arguments = parser.parse_args()
    if (not SHA256.fullmatch(arguments.candidate_id) or
            not SHA256.fullmatch(arguments.release_id) or
            not SHA256.fullmatch(arguments.compose_model_sha256) or
            not SHA256.fullmatch(arguments.authority_receipt_sha256)):
        refuse("candidate or release ID is invalid")
    if (arguments.candidate_name != arguments.candidate_id or
            not re.fullmatch(r"[A-Za-z0-9._-]{8,96}", arguments.record_name)):
        refuse("candidate or deployment record name is invalid")
    for name in (arguments.evidence_name, arguments.override_name):
        if os.path.basename(name) != name or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", name):
            refuse("output name is unsafe")
    if (os.path.basename(arguments.authority_receipt_name) != arguments.authority_receipt_name or
            not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", arguments.authority_receipt_name)):
        refuse("authority receipt name is unsafe")

    candidate_parent = inherited_descriptor(arguments.candidate_parent_fd, directory=True)
    candidate = inherited_descriptor(arguments.candidate_fd, directory=True)
    record_parent = inherited_descriptor(arguments.record_parent_fd, directory=True)
    record = inherited_descriptor(arguments.record_fd, directory=True)
    model_fd = inherited_descriptor(arguments.compose_model_fd)
    authority_fd = inherited_descriptor(arguments.authority_receipt_fd)
    descriptors: list[int] = [candidate_parent, candidate, record_parent, record,
                              model_fd, authority_fd]
    try:
        candidate_meta = os.fstat(candidate); record_meta = os.fstat(record)
        if candidate_meta.st_nlink != 2:
            refuse("candidate directory has an unexpected link count")
        if set(os.listdir(candidate)) != EXPECTED_CANDIDATE_FILES:
            refuse("candidate directory does not have the exact fixed inventory")

        descriptor_fd, descriptor_meta = open_regular(candidate, "candidate.json", MAX_DESCRIPTOR)
        model_source_fd, model_source_meta = open_regular(candidate, "compose-model.json", MAX_RECEIPT)
        receipt_fd, receipt_meta = open_regular(candidate, "image-receipt.json", MAX_RECEIPT)
        bundle_fd, bundle_meta = open_regular(candidate, "images.tar", MAX_BUNDLE)
        descriptors.extend((descriptor_fd, model_source_fd, receipt_fd, bundle_fd))
        descriptor_bytes = read_bounded(descriptor_fd, descriptor_meta, MAX_DESCRIPTOR)
        model_meta = os.fstat(model_fd)
        authority_meta = os.fstat(authority_fd)
        model_bytes = read_bounded(model_fd, model_meta, MAX_RECEIPT)
        model_source_bytes = read_bounded(model_source_fd, model_source_meta, MAX_RECEIPT)
        authority_bytes = read_bounded(authority_fd, authority_meta, MAX_RECEIPT)
        receipt_bytes = read_bounded(receipt_fd, receipt_meta, MAX_RECEIPT)
        descriptor = parse_canonical_json(descriptor_bytes, "candidate descriptor")
        model = parse_canonical_json(model_bytes, "Compose model")
        authority = parse_canonical_json(authority_bytes, "candidate Compose authority")
        receipt = parse_canonical_json(receipt_bytes, "Docker image receipt")
        if (model_source_bytes != model_bytes or
                hashlib.sha256(model_bytes).hexdigest() != arguments.compose_model_sha256 or
                hashlib.sha256(authority_bytes).hexdigest() != arguments.authority_receipt_sha256 or
                model_meta.st_nlink != 0 or stat.S_IMODE(model_meta.st_mode) != 0o600 or
                fcntl.fcntl(model_fd, fcntl.F_GET_SEALS) & REQUIRED_SEALS != REQUIRED_SEALS):
            refuse("held Compose model or record receipt differs from sealed authority")
        body = descriptor.get("body") if type(descriptor) is dict else None
        if (not isinstance(body, dict) or
                descriptor.get("schema") != "revival.release-candidate" or
                descriptor.get("schemaVersion") != 4 or
                descriptor.get("candidateId") != arguments.candidate_id or
                hashlib.sha256(canonical(body)).hexdigest() != arguments.candidate_id):
            refuse("candidate descriptor does not reproduce the requested ID")
        if body.get("authority") not in (
                {"origin": "local-operator", "productionUse": "candidate-only"},
                {"origin": "github-hosted-actions", "productionUse": "requires-point-of-use-provider-evidence"}):
            refuse("candidate authority origin is unsupported")
        release_binding = body.get("release")
        if not isinstance(release_binding, dict) or release_binding.get("id") != arguments.release_id:
            refuse("candidate descriptor does not bind the requested release ID")
        source_git = body.get("git")
        if (not exact_object(source_git, {"commit", "tree"}) or
                type(source_git["commit"]) is not str or
                type(source_git["tree"]) is not str or
                not GIT_OBJECT_ID.fullmatch(source_git["commit"]) or
                not GIT_OBJECT_ID.fullmatch(source_git["tree"])):
            refuse("candidate descriptor Git binding is invalid")
        files = {item.get("role"): item for item in body.get("files", []) if isinstance(item, dict)}
        receipt_entry = files.get("docker-image-receipt"); bundle_entry = files.get("docker-image-bundle")
        model_entry = files.get("production-compose-model")
        if (not isinstance(receipt_entry, dict) or not isinstance(bundle_entry, dict) or
                not isinstance(model_entry, dict)):
            refuse("candidate descriptor lacks image bindings")
        if (receipt_entry.get("size") != len(receipt_bytes) or
                receipt_entry.get("sha256") != hashlib.sha256(receipt_bytes).hexdigest()):
            refuse("held image receipt differs from the candidate descriptor")
        bundle_digest = digest_fd(bundle_fd, bundle_meta)
        if (bundle_entry.get("size") != bundle_meta.st_size or
                bundle_entry.get("sha256") != bundle_digest):
            refuse("held image bundle differs from the candidate descriptor")
        if (model_entry.get("size") != len(model_bytes) or
                model_entry.get("sha256") != arguments.compose_model_sha256 or
                body.get("composeModel") != {"digest": arguments.compose_model_sha256,
                                             "role": "production-compose-model"}):
            refuse("held Compose model differs from the candidate descriptor")
        expected_authority = {
            "schema": "revival.candidate-compose-authority",
            "schemaVersion": 1,
            "candidate": {"dev": candidate_meta.st_dev, "id": arguments.candidate_id,
                          "ino": candidate_meta.st_ino},
            "model": {"sha256": arguments.compose_model_sha256,
                      "size": len(model_bytes)},
            "record": {"dev": record_meta.st_dev, "ino": record_meta.st_ino,
                       "name": arguments.record_name},
            "releaseId": arguments.release_id,
        }
        if authority != expected_authority:
            refuse("deployment-record receipt does not bind the exact candidate/model/inode")
        references, services, evidence_rows = validate_image_receipt(
            receipt, model, arguments.release_id, source_git, bundle_digest,
            bundle_meta.st_size, arguments.helper_reference)
        override = canonical({"services": services}) + b"\n"
        evidence = "".join(evidence_rows).encode()
        evidence_digest = write_once(record, arguments.evidence_name, evidence)
        override_digest = write_once(record, arguments.override_name, override)

        def assert_authority() -> None:
            if (directory_identity(os.fstat(candidate)) != directory_identity(candidate_meta) or
                    directory_identity(os.stat(arguments.candidate_name, dir_fd=candidate_parent,
                                               follow_symlinks=False)) != directory_identity(candidate_meta) or
                    set(os.listdir(candidate)) != EXPECTED_CANDIDATE_FILES or
                    directory_identity(os.fstat(record)) != directory_identity(record_meta) or
                    directory_identity(os.stat(arguments.record_name, dir_fd=record_parent,
                                               follow_symlinks=False)) != directory_identity(record_meta)):
                refuse("candidate or deployment-record directory moved before daemon use")
            for descriptor_value, metadata, digest, maximum in (
                    (descriptor_fd, descriptor_meta, hashlib.sha256(descriptor_bytes).hexdigest(), MAX_DESCRIPTOR),
                    (model_source_fd, model_source_meta, arguments.compose_model_sha256, MAX_RECEIPT),
                    (model_fd, model_meta, arguments.compose_model_sha256, MAX_RECEIPT),
                    (authority_fd, authority_meta, arguments.authority_receipt_sha256, MAX_RECEIPT),
                    (receipt_fd, receipt_meta, hashlib.sha256(receipt_bytes).hexdigest(), MAX_RECEIPT)):
                if (file_identity(os.fstat(descriptor_value)) != file_identity(metadata) or
                        hashlib.sha256(read_bounded(descriptor_value, metadata, maximum)).hexdigest() != digest):
                    refuse("held candidate/model/record input moved before daemon use")
            if (file_identity(os.stat("compose-model.json", dir_fd=candidate,
                                     follow_symlinks=False)) != file_identity(model_source_meta) or
                    file_identity(os.stat(arguments.authority_receipt_name, dir_fd=record,
                                         follow_symlinks=False)) != file_identity(authority_meta) or
                    file_identity(os.fstat(bundle_fd)) != file_identity(bundle_meta) or
                    digest_fd(bundle_fd, bundle_meta) != bundle_digest):
                refuse("candidate model or bundle name/content changed before daemon use")

        assert_authority()
        docker_env = docker_environment()
        docker = trusted_docker()
        before_bundle = file_identity(os.fstat(bundle_fd))
        stream = os.fdopen(os.dup(bundle_fd), "rb", closefd=True)
        try:
            result = subprocess.run([docker, "image", "load"], stdin=stream,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=False,
                                    env=docker_env)
        finally:
            stream.close()
        if result.returncode != 0 or file_identity(os.fstat(bundle_fd)) != before_bundle:
            refuse("Docker load failed or the held bundle moved during load")
        assert_authority()
        for reference, (bundle_reference, image_id, _role) in references.items():
            assert_authority()
            if docker_output(docker, ["image", "inspect", "--format", "{{.Id}}", image_id], docker_env) != image_id:
                refuse("loaded image ID differs from the sealed receipt")
            docker_output(docker, ["image", "tag", image_id, bundle_reference], docker_env)
            if docker_output(docker, ["image", "inspect", "--format", "{{.Id}}", bundle_reference], docker_env) != image_id:
                refuse("local bundle reference differs from the sealed image ID")
            assert_authority()
        assert_authority()
        print(json.dumps({
            "ok": True,
            "helperReference": references[arguments.helper_reference][1],
            "evidenceSha256": evidence_digest,
            "overrideSha256": override_digest,
            "composeModelSha256": arguments.compose_model_sha256,
            "authorityReceiptSha256": arguments.authority_receipt_sha256,
        }, sort_keys=True, separators=(",", ":")))
    finally:
        for descriptor in reversed(descriptors):
            try: os.close(descriptor)
            except OSError: pass


if __name__ == "__main__":
    main()
