#!/usr/bin/env python3
"""Capture and seal the one exceptional live Carry rollback authority.

The pre-workflow Carry deployment cannot truthfully acquire hosted build
provenance after the fact.  This module therefore records an observation of
the exact live runtime.  The hosted candidate authenticates only the registrar
code that makes and later checks that observation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import stat
import sys
from typing import Any, BinaryIO, NoReturn


REMOTE_ROOT = "/home/anders/ai-pin-revival"
PROJECT = "ai-pin-revival"
LEGACY_PROJECT = "humane-carry-clone"
AUTHORITY_KIND = "adopted-live-carry-v1"
STORE_BASENAME = AUTHORITY_KIND
EXPECTED_SERVICES = (
    "account",
    "ai-bus",
    "center",
    "connectivity",
    "contacts",
    "edge",
    "feature-flags",
    "grafana",
    "keycloak",
    "notable-events",
    "postgres",
    "prometheus",
    "provisioning",
    "searxng",
    "spotify-adapter",
)
VOLUME_NAMES = (
    "humane-carry-clone_carry-state",
    "humane-carry-clone_carry-pgdata",
    "humane-carry-clone_prometheus-data",
    "humane-carry-clone_grafana-data",
)
LOCAL_MODEL_NETWORK = "humane-carry-clone_carry-local"
ROLLBACK_NETWORK = "carry-net"
CENTER_DATA = "/home/anders/carry-center-data"
CONFIG_PATHS = (
    ("runtime-env", "/home/anders/humane-carry-clone/.env", "file"),
    ("backends-env", "/home/anders/carry-backends.env", "file"),
    ("center-env", "/home/anders/carry-center.env", "file"),
    ("edge", "/home/anders/carry-edge", "directory"),
    ("attestation-pki", "/home/anders/carry-attest", "directory"),
    ("device-user-pki", "/home/anders/carry-duc", "directory"),
    ("keycloak-theme", "/home/anders/keycloak-themes/humane", "directory"),
)
PRIVILEGED_CONFIG_PATHS = {
    "edge": ("/home/anders/carry-edge", 1000, 1001),
    "attestation-pki": ("/home/anders/carry-attest", 65532, 65532),
    "device-user-pki": ("/home/anders/carry-duc", 65532, 65532),
}
SHA256 = re.compile(r"^[0-9a-f]{64}$")
DOCKER_IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_CONFIG_MEMBERS = 10_000
MAX_CONFIG_BYTES = 256 * 1024 * 1024


def refuse(message: str) -> NoReturn:
    raise SystemExit(f"Carry baseline refusal: {message}")


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_digest(value: object) -> str:
    return hashlib.sha256(canonical(value)[:-1]).hexdigest()


def read_bounded(stream: BinaryIO, label: str) -> bytes:
    payload = stream.read(MAX_JSON_BYTES + 1)
    if not payload or len(payload) > MAX_JSON_BYTES:
        refuse(f"{label} is empty or exceeds its bound")
    return payload


def read_json_stream(stream: BinaryIO, label: str) -> Any:
    try:
        return json.loads(read_bounded(stream, label))
    except (UnicodeDecodeError, json.JSONDecodeError):
        refuse(f"{label} is not valid JSON")


def read_canonical_json_stream(stream: BinaryIO, label: str) -> Any:
    payload = read_bounded(stream, label)
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        refuse(f"{label} is not valid JSON")
    if canonical(value) != payload:
        refuse(f"{label} is not canonical JSON")
    return value


def normalized_json(value: object) -> object:
    """Round-trip to reject non-JSON values supplied by imported unit tests."""
    return json.loads(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False))


def file_identity(metadata: os.stat_result) -> dict[str, int]:
    return {
        "device": metadata.st_dev,
        "inode": metadata.st_ino,
        "mode": stat.S_IMODE(metadata.st_mode),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "links": metadata.st_nlink,
        "size": metadata.st_size,
        "mtimeNs": metadata.st_mtime_ns,
        "ctimeNs": metadata.st_ctime_ns,
    }


def inventory_path(path: str, expected_kind: str) -> dict[str, object]:
    absolute = os.path.abspath(path)
    if absolute != path or os.path.realpath(path) != path:
        refuse(f"configuration path is not one canonical non-symlink path: {path}")
    root = os.lstat(path)
    if stat.S_ISLNK(root.st_mode):
        refuse(f"configuration path is a symlink: {path}")
    if expected_kind == "file" and not stat.S_ISREG(root.st_mode):
        refuse(f"configuration file is missing: {path}")
    if expected_kind == "directory" and not stat.S_ISDIR(root.st_mode):
        refuse(f"configuration directory is missing: {path}")
    if root.st_uid != os.getuid() or root.st_gid != os.getgid():
        refuse(f"configuration path is not owned by the deployment account: {path}")
    if stat.S_IMODE(root.st_mode) & 0o022:
        refuse(f"configuration path is group/world writable: {path}")

    entries: list[dict[str, object]] = []
    total_bytes = 0

    def add(current: str, relative: str) -> None:
        nonlocal total_bytes
        metadata = os.lstat(current)
        if stat.S_ISLNK(metadata.st_mode):
            refuse(f"configuration tree contains a symlink: {current}")
        if metadata.st_uid != os.getuid() or metadata.st_gid != os.getgid():
            refuse(f"configuration tree contains an unowned object: {current}")
        if stat.S_IMODE(metadata.st_mode) & 0o022:
            refuse(f"configuration tree contains a writable object: {current}")
        entry: dict[str, object] = {"path": relative, **file_identity(metadata)}
        if stat.S_ISREG(metadata.st_mode):
            total_bytes += metadata.st_size
            if total_bytes > MAX_CONFIG_BYTES:
                refuse("configuration inventory exceeds its byte bound")
            before = file_identity(metadata)
            descriptor = os.open(current, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                opened = os.fstat(descriptor)
                if file_identity(opened) != before:
                    refuse(f"configuration file moved before open: {current}")
                computed = hashlib.sha256()
                offset = 0
                while offset < opened.st_size:
                    block = os.pread(descriptor, min(1024 * 1024, opened.st_size - offset), offset)
                    if not block:
                        refuse(f"configuration file truncated while read: {current}")
                    computed.update(block)
                    offset += len(block)
                if file_identity(os.fstat(descriptor)) != before or file_identity(os.lstat(current)) != before:
                    refuse(f"configuration file changed while read: {current}")
                entry.update({"kind": "file", "sha256": computed.hexdigest()})
            finally:
                os.close(descriptor)
        elif stat.S_ISDIR(metadata.st_mode):
            entry["kind"] = "directory"
        else:
            refuse(f"configuration tree contains a non-file object: {current}")
        entries.append(entry)
        if len(entries) > MAX_CONFIG_MEMBERS:
            refuse("configuration inventory exceeds its member bound")

    add(path, ".")
    if stat.S_ISDIR(root.st_mode):
        for current, directories, files in os.walk(path, topdown=True, followlinks=False):
            directories.sort()
            files.sort()
            for name in directories:
                add(os.path.join(current, name), os.path.relpath(os.path.join(current, name), path))
            for name in files:
                add(os.path.join(current, name), os.path.relpath(os.path.join(current, name), path))
    return {"root": path, "entries": entries}


def validate_privileged_configurations(value: object) -> dict[str, dict[str, object]]:
    if not isinstance(value, dict) or set(value) != set(PRIVILEGED_CONFIG_PATHS):
        refuse("privileged configuration inventory is not exact")
    result: dict[str, dict[str, object]] = {}
    identity_keys = {"device", "inode", "mode", "uid", "gid", "links", "size", "mtimeNs", "ctimeNs"}
    for name, (expected_root, expected_uid, expected_gid) in PRIVILEGED_CONFIG_PATHS.items():
        inventory = value.get(name)
        if not isinstance(inventory, dict) or set(inventory) != {"root", "entries"}:
            refuse(f"privileged configuration inventory is malformed: {name}")
        entries = inventory.get("entries")
        if inventory.get("root") != expected_root or not isinstance(entries, list) or not entries:
            refuse(f"privileged configuration root is invalid: {name}")
        seen: set[str] = set()
        total_bytes = 0
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict) or entry.get("kind") not in {"file", "directory"}:
                refuse(f"privileged configuration entry is malformed: {name}")
            expected_keys = {"path", "kind", *identity_keys}
            if entry["kind"] == "file":
                expected_keys.add("sha256")
            if set(entry) != expected_keys:
                refuse(f"privileged configuration entry schema is not closed: {name}")
            relative = entry.get("path")
            if (not isinstance(relative, str) or not relative or relative in seen or
                    (index == 0) != (relative == ".") or relative.startswith("/") or
                    (relative != "." and any(part in {"", ".", ".."} for part in relative.split("/")))):
                refuse(f"privileged configuration entry path is invalid: {name}")
            seen.add(relative)
            if entry.get("uid") != expected_uid or entry.get("gid") != expected_gid:
                refuse(f"privileged configuration ownership differs from the deployed Carry ABI: {name}")
            if (not all(isinstance(entry.get(key), int) and entry[key] >= 0 for key in identity_keys) or
                    entry["mode"] & 0o022):
                refuse(f"privileged configuration metadata is unsafe: {name}")
            if entry["kind"] == "file":
                if entry["links"] != 1 or not SHA256.fullmatch(str(entry.get("sha256") or "")):
                    refuse(f"privileged configuration file identity is unsafe: {name}")
                total_bytes += entry["size"]
                if total_bytes > MAX_CONFIG_BYTES:
                    refuse("privileged configuration inventory exceeds its byte bound")
        if len(entries) > MAX_CONFIG_MEMBERS:
            refuse("privileged configuration inventory exceeds its member bound")
        if [entry["path"] for entry in entries] != [".", *sorted(seen - {"."})]:
            refuse(f"privileged configuration inventory is not canonically ordered: {name}")
        result[name] = inventory
    return result


def center_data_identity(path: str = CENTER_DATA) -> dict[str, object]:
    metadata = os.lstat(path)
    if (not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or
            os.path.realpath(path) != path or metadata.st_uid != os.getuid() or
            metadata.st_gid != os.getgid() or stat.S_IMODE(metadata.st_mode) & 0o002):
        refuse("Carry Center data root is missing or unsafe")
    return {"path": path, **file_identity(metadata)}


def mount_projection(mount: dict[str, Any]) -> dict[str, object]:
    return {
        key: mount.get(key)
        for key in ("Type", "Name", "Source", "Destination", "Driver", "Mode", "RW", "Propagation")
    }


def endpoint_projection(endpoint: dict[str, Any]) -> dict[str, object]:
    return {
        "networkId": endpoint.get("NetworkID"),
        "endpointId": endpoint.get("EndpointID"),
        "gateway": endpoint.get("Gateway"),
        "ipAddress": endpoint.get("IPAddress"),
        "ipPrefixLen": endpoint.get("IPPrefixLen"),
        "ipv6Gateway": endpoint.get("IPv6Gateway"),
        "globalIPv6Address": endpoint.get("GlobalIPv6Address"),
        "globalIPv6PrefixLen": endpoint.get("GlobalIPv6PrefixLen"),
        "macAddress": endpoint.get("MacAddress"),
        "aliases": sorted(endpoint.get("Aliases") or []),
        "dnsNames": sorted(endpoint.get("DNSNames") or []),
    }


def required_mounts(service: str, paths: dict[str, str]) -> tuple[tuple[str, str, str, bool], ...]:
    state = paths["stateVolume"]
    if service == "postgres":
        return (("/var/lib/postgresql/data", "volume", paths["pgVolume"], True),)
    if service == "prometheus":
        return (("/prometheus", "volume", paths["prometheusVolume"], True),)
    if service == "grafana":
        return (("/var/lib/grafana", "volume", paths["grafanaVolume"], True),)
    if service == "center":
        return (("/data", "bind", paths["centerData"], True),)
    if service == "ai-bus":
        return (
            ("/var/lib/carry", "volume", state, True),
            ("/etc/carry-attest/ca.crt", "bind", "/home/anders/carry-attest/ca.crt", False),
            ("/etc/carry-attest/ca.key", "bind", "/home/anders/carry-attest/ca.key", False),
        )
    if service == "provisioning":
        return (
            ("/var/lib/carry", "volume", state, True),
            ("/etc/carry-duc/duc-ca.crt", "bind", "/home/anders/carry-duc/duc-ca.crt", False),
            ("/etc/carry-duc/duc-ca.key", "bind", "/home/anders/carry-duc/duc-ca.key", False),
        )
    if service == "edge":
        return (
            ("/etc/carry-edge/certs/server.crt", "bind", "/home/anders/carry-edge/certs/server.crt", False),
            ("/etc/carry-edge/certs/server.key", "bind", "/home/anders/carry-edge/certs/server.key", False),
            ("/etc/carry-edge/certs/api-client-ca.crt", "bind", "/home/anders/carry-edge/certs/api-client-ca.crt", False),
            ("/etc/carry-edge/certs/onboarding-client-ca.crt", "bind", "/home/anders/carry-edge/certs/onboarding-client-ca.crt", False),
        )
    if service in {"connectivity", "account", "contacts", "feature-flags", "notable-events"}:
        return (("/var/lib/carry", "volume", state, True),)
    return ()


def validate_required_mounts(service: str, mounts: list[dict[str, object]], paths: dict[str, str]) -> None:
    for destination, kind, source, writable in required_mounts(service, paths):
        matches = [item for item in mounts if item.get("Destination") == destination]
        if len(matches) != 1 or matches[0].get("Type") != kind or matches[0].get("RW") is not writable:
            refuse(f"legacy {service} does not have its exact reviewed mount at {destination}")
        actual = matches[0].get("Name" if kind == "volume" else "Source")
        if actual != source:
            refuse(f"legacy {service} uses the wrong durable source at {destination}")


def container_projection(container: dict[str, Any], expected_state: str,
                         paths: dict[str, str]) -> dict[str, object]:
    labels = (container.get("Config") or {}).get("Labels") or {}
    service = labels.get("com.docker.compose.service")
    if labels.get("com.docker.compose.project") != LEGACY_PROJECT or service not in EXPECTED_SERVICES:
        refuse("container is outside the exact legacy project/service inventory")
    identifier = container.get("Id")
    image_id = container.get("Image")
    image_reference = (container.get("Config") or {}).get("Image")
    name = str(container.get("Name") or "").removeprefix("/")
    if (not SHA256.fullmatch(str(identifier or "")) or not DOCKER_IMAGE_ID.fullmatch(str(image_id or "")) or
            not isinstance(image_reference, str) or not image_reference or not name):
        refuse(f"legacy {service} has incomplete container/image identity")
    state = container.get("State") or {}
    health = (state.get("Health") or {}).get("Status")
    if expected_state == "active":
        if state.get("Running") is not True or state.get("Status") != "running" or (health is not None and health != "healthy"):
            refuse(f"legacy {service} is not running and healthy")
    elif expected_state == "stopped":
        if state.get("Running") is not False or state.get("Status") != "exited":
            refuse(f"legacy {service} is not one retained stopped container")
    else:
        refuse("unsupported observation state")
    mounts = sorted((mount_projection(item) for item in container.get("Mounts") or []),
                    key=lambda item: (str(item.get("Destination")), str(item.get("Source")), str(item.get("Name"))))
    validate_required_mounts(service, mounts, paths)
    networks = {
        name: endpoint_projection(value)
        for name, value in sorted(((container.get("NetworkSettings") or {}).get("Networks") or {}).items())
    }
    if service == "ai-bus" and paths["localModelNetwork"] not in networks:
        refuse("legacy ai-bus is not attached to the exact retained Carry local-model network")
    return {
        "service": service,
        "containerId": identifier,
        "name": name,
        "imageId": image_id,
        "imageReference": image_reference,
        "labelsSha256": canonical_digest(labels),
        "configSha256": canonical_digest(container.get("Config") or {}),
        "hostConfigSha256": canonical_digest(container.get("HostConfig") or {}),
        "runtime": {"running": state.get("Running"), "status": state.get("Status"), "health": health},
        "mounts": mounts,
        "networks": networks,
    }


def volume_projection(volume: dict[str, Any]) -> dict[str, object]:
    return {
        key: normalized_json(volume.get(key))
        for key in ("Name", "Driver", "Mountpoint", "Scope", "Labels", "Options")
    }


def network_projection(network: dict[str, Any]) -> dict[str, object]:
    # Container endpoint identity is captured per service.  Omitting only the
    # redundant Containers/UsageData maps keeps the network resource projection
    # identical while the retained containers transition from running to exited.
    return {
        key: normalized_json(network.get(key))
        for key in ("Name", "Id", "Created", "Scope", "Driver", "EnableIPv6", "IPAM",
                    "Internal", "Attachable", "Ingress", "ConfigFrom", "ConfigOnly", "Options", "Labels", "Peers")
    }


def build_observation(containers: list[dict[str, Any]], volumes: list[dict[str, Any]],
                      networks: list[dict[str, Any]], expected_state: str,
                      semantic_sha256: str | None, *,
                      config_paths: tuple[tuple[str, str, str], ...] = CONFIG_PATHS,
                      center_data_path: str = CENTER_DATA,
                      resource_paths: dict[str, str] | None = None,
                      privileged_configurations: dict[str, dict[str, object]] | None = None) -> dict[str, object]:
    paths = resource_paths or {
        "stateVolume": VOLUME_NAMES[0],
        "pgVolume": VOLUME_NAMES[1],
        "prometheusVolume": VOLUME_NAMES[2],
        "grafanaVolume": VOLUME_NAMES[3],
        "localModelNetwork": LOCAL_MODEL_NETWORK,
        "centerData": center_data_path,
    }
    if not isinstance(containers, list) or len(containers) != len(EXPECTED_SERVICES):
        refuse("legacy project does not contain the exact required service count")
    projected = [container_projection(item, expected_state, paths) for item in containers]
    services = [str(item["service"]) for item in projected]
    if sorted(services) != list(EXPECTED_SERVICES) or len(set(services)) != len(EXPECTED_SERVICES):
        refuse("legacy project does not contain exactly one container for every required service")
    projected.sort(key=lambda item: str(item["service"]))

    if not isinstance(volumes, list) or len(volumes) != len(VOLUME_NAMES):
        refuse("durable volume inspection is incomplete")
    volume_map = {item.get("Name"): item for item in volumes if isinstance(item, dict)}
    if set(volume_map) != set(VOLUME_NAMES):
        refuse("durable volume identity differs from the exact Carry contract")
    projected_volumes = [volume_projection(volume_map[name]) for name in VOLUME_NAMES]

    if not isinstance(networks, list) or len(networks) != 2:
        refuse("Carry network inspection is incomplete")
    network_map = {item.get("Name"): item for item in networks if isinstance(item, dict)}
    if set(network_map) != {LOCAL_MODEL_NETWORK, ROLLBACK_NETWORK}:
        refuse("network identity differs from the exact Carry contract")
    projected_networks = [network_projection(network_map[name]) for name in (LOCAL_MODEL_NETWORK, ROLLBACK_NETWORK)]

    if expected_state == "active" and not SHA256.fullmatch(semantic_sha256 or ""):
        refuse("active Carry observation lacks semantic evidence")
    if expected_state == "stopped" and semantic_sha256 is not None:
        refuse("stopped Carry observation cannot claim live semantic evidence")
    privileged = (validate_privileged_configurations(privileged_configurations)
                  if privileged_configurations is not None else {})
    configs = []
    for name, path, kind in config_paths:
        if name in privileged:
            if path != PRIVILEGED_CONFIG_PATHS[name][0] or kind != "directory":
                refuse(f"privileged configuration path contract differs: {name}")
            configs.append({"name": name, **privileged[name]})
        else:
            configs.append({"name": name, **inventory_path(path, kind)})
    return {
        "schema": "revival.live-carry-observation",
        "version": 1,
        "project": LEGACY_PROJECT,
        "state": expected_state,
        "services": projected,
        "volumes": projected_volumes,
        "networks": projected_networks,
        "configurations": configs,
        "centerData": center_data_identity(center_data_path),
        "semanticSha256": semantic_sha256,
    }


def immutable_observation(value: dict[str, Any]) -> dict[str, object]:
    copied = json.loads(json.dumps(value))
    copied.pop("state", None)
    copied.pop("semanticSha256", None)
    for service in copied.get("services", []):
        service.pop("runtime", None)
    return copied


def validate_observation(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "schema", "version", "project", "state", "services", "volumes", "networks",
        "configurations", "centerData", "semanticSha256",
    }:
        refuse("Carry observation schema is not closed")
    if value.get("schema") != "revival.live-carry-observation" or value.get("version") != 1 or value.get("project") != LEGACY_PROJECT:
        refuse("Carry observation identity is invalid")
    if value.get("state") not in ("active", "stopped") or not isinstance(value.get("services"), list):
        refuse("Carry observation state or service inventory is invalid")
    services = [item.get("service") for item in value["services"] if isinstance(item, dict)]
    if services != list(EXPECTED_SERVICES):
        refuse("Carry observation service inventory is not exact and sorted")
    if value["state"] == "active" and not SHA256.fullmatch(str(value.get("semanticSha256") or "")):
        refuse("active Carry observation semantic evidence is invalid")
    if value["state"] == "stopped" and value.get("semanticSha256") is not None:
        refuse("stopped Carry observation has impossible semantic evidence")
    return value


def make_record(observation: dict[str, Any], candidate_id: str, release_id: str,
                authority_sha256: str) -> dict[str, object]:
    validate_observation(observation)
    if observation["state"] != "active":
        refuse("only a live active Carry runtime can be registered")
    if not all(SHA256.fullmatch(value) for value in (candidate_id, release_id, authority_sha256)):
        refuse("registrar authority identities are invalid")
    return {
        "schema": "revival.adopted-live-carry-authority",
        "version": 1,
        "authorityKind": AUTHORITY_KIND,
        "eligibility": "immediate-first-cutover-predecessor-only",
        "runtimeProvenance": "observed-live-runtime-not-provider-built",
        "registrar": {
            "candidateId": candidate_id,
            "releaseId": release_id,
            "deploymentAuthoritySha256": authority_sha256,
            "providerEvidence": "point-of-use-reverified-registrar-code-only",
        },
        "observation": observation,
    }


def validate_record(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "schema", "version", "authorityKind", "eligibility", "runtimeProvenance", "registrar", "observation",
    }:
        refuse("adopted Carry authority schema is not closed")
    if (value.get("schema") != "revival.adopted-live-carry-authority" or value.get("version") != 1 or
            value.get("authorityKind") != AUTHORITY_KIND or
            value.get("eligibility") != "immediate-first-cutover-predecessor-only" or
            value.get("runtimeProvenance") != "observed-live-runtime-not-provider-built"):
        refuse("adopted Carry authority scope is invalid")
    registrar = value.get("registrar")
    if not isinstance(registrar, dict) or set(registrar) != {
        "candidateId", "releaseId", "deploymentAuthoritySha256", "providerEvidence",
    }:
        refuse("adopted Carry registrar schema is invalid")
    if registrar.get("providerEvidence") != "point-of-use-reverified-registrar-code-only":
        refuse("old Carry images were assigned false provider provenance")
    if not all(SHA256.fullmatch(str(registrar.get(name) or "")) for name in
                   ("candidateId", "releaseId", "deploymentAuthoritySha256")):
        refuse("adopted Carry registrar identities are invalid")
    validate_observation(value.get("observation"))
    if value["observation"]["state"] != "active":
        refuse("adopted Carry record is not an active-runtime observation")
    return value


def safe_file_bytes(path: str, mode: int, maximum: int = MAX_JSON_BYTES) -> bytes:
    before = os.lstat(path)
    if (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or before.st_nlink != 1 or
            before.st_uid != os.getuid() or before.st_gid != os.getgid() or
            stat.S_IMODE(before.st_mode) != mode or before.st_size <= 0 or before.st_size > maximum):
        refuse(f"private authority file is unsafe: {path}")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if file_identity(opened) != file_identity(before):
            refuse(f"private authority file moved before open: {path}")
        payload = bytearray()
        while len(payload) < opened.st_size:
            block = os.pread(descriptor, min(1024 * 1024, opened.st_size - len(payload)), len(payload))
            if not block:
                refuse(f"private authority file truncated while read: {path}")
            payload.extend(block)
        if file_identity(os.fstat(descriptor)) != file_identity(opened) or file_identity(os.lstat(path)) != file_identity(opened):
            refuse(f"private authority file changed while read: {path}")
        return bytes(payload)
    finally:
        os.close(descriptor)


def safe_directory(path: str, *, create: bool) -> None:
    if create:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
    metadata = os.lstat(path)
    if (not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or
            metadata.st_uid != os.getuid() or metadata.st_gid != os.getgid() or
            stat.S_IMODE(metadata.st_mode) != 0o700 or os.path.realpath(path) != path):
        refuse(f"private authority directory is unsafe: {path}")


def record_paths(root: str, baseline_id: str) -> tuple[str, str, str]:
    if root != REMOTE_ROOT or not SHA256.fullmatch(baseline_id):
        refuse("adopted Carry store root or identity is invalid")
    store = os.path.join(root, STORE_BASENAME)
    return store, os.path.join(store, f"{baseline_id}.json"), os.path.join(store, "active")


def read_record(root: str, baseline_id: str, *, require_active: bool = True) -> dict[str, Any]:
    store, record_path, active_path = record_paths(root, baseline_id)
    safe_directory(store, create=False)
    payload = safe_file_bytes(record_path, 0o400)
    if digest(payload) != baseline_id:
        refuse("adopted Carry authority content address does not match its bytes")
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        refuse("adopted Carry authority is not JSON")
    if canonical(value) != payload:
        refuse("adopted Carry authority is not canonical JSON")
    value = validate_record(value)
    if require_active:
        pointer = safe_file_bytes(active_path, 0o400, 128)
        if pointer != f"{baseline_id}\n".encode():
            refuse("active adopted Carry authority pointer disagrees")
    return value


def write_once(path: str, payload: bytes, mode: int) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_output(path: str, payload: bytes) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    parent_meta = os.lstat(parent)
    if (not stat.S_ISDIR(parent_meta.st_mode) or stat.S_ISLNK(parent_meta.st_mode) or
            parent_meta.st_uid != os.getuid() or parent_meta.st_gid != os.getgid() or
            stat.S_IMODE(parent_meta.st_mode) & 0o022):
        refuse("observation output parent is unsafe")
    write_once(path, payload, 0o600)


def register_record(root: str, record: dict[str, Any]) -> str:
    if root != REMOTE_ROOT:
        refuse("adopted Carry record may only be written to the protected production root")
    root_meta = os.lstat(root)
    if (not stat.S_ISDIR(root_meta.st_mode) or stat.S_ISLNK(root_meta.st_mode) or
            root_meta.st_uid != os.getuid() or root_meta.st_gid != os.getgid() or
            stat.S_IMODE(root_meta.st_mode) != 0o700 or os.path.realpath(root) != root):
        refuse("protected production root is unsafe")
    payload = canonical(validate_record(record))
    baseline_id = digest(payload)
    store, record_path, active_path = record_paths(root, baseline_id)
    safe_directory(store, create=True)
    if os.path.lexists(active_path):
        existing_id = safe_file_bytes(active_path, 0o400, 128).decode().strip()
        existing = read_record(root, existing_id)
        if canonical(existing) != payload:
            refuse("a different adopted Carry authority is already active")
        return existing_id
    if os.path.lexists(record_path):
        if safe_file_bytes(record_path, 0o400) != payload:
            refuse("adopted Carry content-addressed record bytes disagree")
    else:
        write_once(record_path, payload, 0o400)
    temporary = os.path.join(store, f".active.{os.getpid()}.{secrets.token_hex(8)}")
    try:
        write_once(temporary, f"{baseline_id}\n".encode(), 0o400)
        # link(2) is the no-replace publication primitive here. rename(2)
        # would silently overwrite an authority another process published
        # between the existence check and this linearization point.
        os.link(temporary, active_path, follow_symlinks=False)
        os.unlink(temporary)
        directory = os.open(store, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    read_record(root, baseline_id)
    return baseline_id


def verify_live(record: dict[str, Any], current: dict[str, Any], expected_state: str,
                candidate_id: str | None, release_id: str | None,
                authority_sha256: str | None) -> None:
    validate_record(record)
    validate_observation(current)
    registrar = record["registrar"]
    for supplied, name in ((candidate_id, "candidateId"), (release_id, "releaseId"),
                           (authority_sha256, "deploymentAuthoritySha256")):
        if supplied is not None and registrar[name] != supplied:
            refuse(f"forward candidate does not match adopted Carry registrar {name}")
    if current["state"] != expected_state:
        refuse("current Carry runtime was captured in the wrong state")
    recorded = record["observation"]
    if expected_state == "active":
        if canonical(recorded) != canonical(current):
            refuse("live Carry runtime changed since adopted baseline registration")
    elif expected_state == "stopped":
        if canonical(immutable_observation(recorded)) != canonical(immutable_observation(current)):
            refuse("stopped Carry predecessor identity changed since registration")
    else:
        refuse("unsupported adopted Carry verification state")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    subcommands = result.add_subparsers(dest="command", required=True)
    capture = subcommands.add_parser("capture")
    capture.add_argument("--state", choices=("active", "stopped"), required=True)
    capture.add_argument("--containers-fd", type=int, required=True)
    capture.add_argument("--volumes-fd", type=int, required=True)
    capture.add_argument("--networks-fd", type=int, required=True)
    capture.add_argument("--privileged-config-fd", type=int, required=True)
    capture.add_argument("--semantic")
    capture.add_argument("--output", required=True)
    register = subcommands.add_parser("register")
    register.add_argument("--root", required=True)
    register.add_argument("--observation", required=True)
    register.add_argument("--candidate-id", required=True)
    register.add_argument("--release-id", required=True)
    register.add_argument("--deployment-authority-sha256", required=True)
    verify = subcommands.add_parser("verify")
    verify.add_argument("--root", required=True)
    verify.add_argument("--baseline-id", required=True)
    verify.add_argument("--current", required=True)
    verify.add_argument("--state", choices=("active", "stopped"), required=True)
    verify.add_argument("--candidate-id")
    verify.add_argument("--release-id")
    verify.add_argument("--deployment-authority-sha256")
    inspect = subcommands.add_parser("inspect")
    inspect.add_argument("--root", required=True)
    inspect.add_argument("--baseline-id", required=True)
    active = subcommands.add_parser("active-id")
    active.add_argument("--root", required=True)
    return result


def json_file(path: str, label: str, *, canonical_required: bool = True) -> dict[str, Any]:
    payload = safe_file_bytes(path, 0o600)
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        refuse(f"{label} is not JSON")
    if canonical_required and payload != canonical(value):
        refuse(f"{label} is not canonical JSON")
    if not isinstance(value, dict):
        refuse(f"{label} is not one JSON object")
    return value


def main() -> None:
    args = parser().parse_args()
    if args.command == "capture":
        containers = read_json_stream(os.fdopen(args.containers_fd, "rb", closefd=False), "container inspection")
        volumes = read_json_stream(os.fdopen(args.volumes_fd, "rb", closefd=False), "volume inspection")
        networks = read_json_stream(os.fdopen(args.networks_fd, "rb", closefd=False), "network inspection")
        privileged = read_canonical_json_stream(
            os.fdopen(args.privileged_config_fd, "rb", closefd=False),
            "privileged configuration inspection",
        )
        semantic_sha256 = None
        if args.state == "active":
            if not args.semantic:
                refuse("active capture requires semantic evidence")
            semantic_sha256 = digest(safe_file_bytes(args.semantic, 0o600, 1024 * 1024))
        elif args.semantic:
            refuse("stopped capture cannot accept semantic evidence")
        observation = build_observation(
            containers, volumes, networks, args.state, semantic_sha256,
            privileged_configurations=privileged,
        )
        write_output(args.output, canonical(observation))
    elif args.command == "register":
        observation = validate_observation(json_file(args.observation, "Carry observation"))
        record = make_record(observation, args.candidate_id, args.release_id, args.deployment_authority_sha256)
        print(register_record(args.root, record))
    elif args.command == "verify":
        record = read_record(args.root, args.baseline_id)
        current = validate_observation(json_file(args.current, "current Carry observation"))
        verify_live(record, current, args.state, args.candidate_id, args.release_id,
                    args.deployment_authority_sha256)
        print(args.baseline_id)
    elif args.command == "inspect":
        value = read_record(args.root, args.baseline_id)
        print(canonical(value).decode(), end="")
    elif args.command == "active-id":
        if args.root != REMOTE_ROOT:
            refuse("adopted Carry store root is invalid")
        store = os.path.join(args.root, STORE_BASENAME)
        safe_directory(store, create=False)
        active_path = os.path.join(store, "active")
        baseline_id = safe_file_bytes(active_path, 0o400, 128).decode().strip()
        if not SHA256.fullmatch(baseline_id):
            refuse("active adopted Carry authority identity is invalid")
        read_record(args.root, baseline_id)
        print(baseline_id)
    else:
        refuse("unsupported command")


if __name__ == "__main__":
    main()
