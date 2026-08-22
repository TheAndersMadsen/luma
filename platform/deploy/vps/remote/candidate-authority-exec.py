#!/usr/bin/env python3
"""Run a trusted candidate consumer with one sealed Compose-model authority.

The candidate model is opened beneath held, no-follow candidate and record
directories, checked against candidate.json, copied into a write-sealed memfd,
and passed to the consumer only as an inherited descriptor.  A canonical
record receipt binds the candidate/model bytes to the exact deployment-record
inode.  Logical names and every held input are revalidated immediately before
and after the consumer; mutable pathnames are never model authority.
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import re
import stat
import struct
import subprocess
import sys


REMOTE_ROOT = "/home/anders/ai-pin-revival"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
RECORD_NAME = re.compile(r"^[A-Za-z0-9._-]{8,96}$")
OUTPUT_NAME = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
MAX_DESCRIPTOR = 2 * 1024 * 1024
MAX_MODEL = 8 * 1024 * 1024
MAX_RECEIPT = 2 * 1024 * 1024
EXPECTED_CANDIDATE_FILES = frozenset({
    "candidate.json", "compose-model.json", "image-receipt.json", "images.tar",
    "production-state.json", "release.json", "release.manifest.json",
    "release.tar.gz", "source-commit.txt", "source-receipt.json",
    "source-snapshot.tar", "toolchain-receipt.json", "verify-release.py",
})
REQUIRED_SEALS = (
    getattr(fcntl, "F_SEAL_SEAL", 0x0001) |
    getattr(fcntl, "F_SEAL_SHRINK", 0x0002) |
    getattr(fcntl, "F_SEAL_GROW", 0x0004) |
    getattr(fcntl, "F_SEAL_WRITE", 0x0008)
)
IN_MODIFY = 0x00000002
IN_ATTRIB = 0x00000004
IN_CLOSE_WRITE = 0x00000008
IN_MOVED_FROM = 0x00000040
IN_MOVED_TO = 0x00000080
IN_CREATE = 0x00000100
IN_DELETE = 0x00000200
IN_DELETE_SELF = 0x00000400
IN_MOVE_SELF = 0x00000800
IN_UNMOUNT = 0x00002000
IN_Q_OVERFLOW = 0x00004000
WATCH_MASK = (IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_MOVED_FROM |
              IN_MOVED_TO | IN_CREATE | IN_DELETE | IN_DELETE_SELF |
              IN_MOVE_SELF | IN_UNMOUNT | IN_Q_OVERFLOW)


def refuse(message: str) -> "NoReturn":
    raise SystemExit(f"candidate authority execution refusal: {message}")


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode()


def file_identity(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_nlink, value.st_uid, value.st_gid,
            stat.S_IMODE(value.st_mode))


def directory_identity(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_nlink, value.st_uid,
            value.st_gid, stat.S_IMODE(value.st_mode))


def open_absolute(path: str) -> int:
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        refuse("managed path is not canonical and absolute")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.split("/")[1:]:
            if not component or component in (".", ".."):
                refuse("managed path contains an unsafe component")
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor); descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor); raise


def open_named_directory(parent: int, name: str, label: str,
                         *, flat: bool = False) -> tuple[int, os.stat_result]:
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         dir_fd=parent)
    opened = os.fstat(descriptor)
    if (file_identity(opened) != file_identity(before) or
            not stat.S_ISDIR(opened.st_mode) or
            (opened.st_uid, opened.st_gid, stat.S_IMODE(opened.st_mode)) !=
            (os.getuid(), os.getgid(), 0o700) or
            (flat and opened.st_nlink != 2)):
        os.close(descriptor); refuse(f"{label} directory authority is unsafe")
    return descriptor, opened


def open_regular(parent: int, name: str, maximum: int,
                 modes: tuple[int, ...] = (0o600,)) -> tuple[int, os.stat_result]:
    if not OUTPUT_NAME.fullmatch(name):
        refuse("candidate authority filename is unsafe")
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
            before.st_size < 0 or before.st_size > maximum or
            (before.st_uid, before.st_gid) != (os.getuid(), os.getgid()) or
            stat.S_IMODE(before.st_mode) not in modes):
        refuse(f"candidate authority input metadata is unsafe: {name}")
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    opened = os.fstat(descriptor)
    if file_identity(opened) != file_identity(before):
        os.close(descriptor); refuse(f"candidate authority input moved: {name}")
    return descriptor, opened


def read_fd(descriptor: int, metadata: os.stat_result, maximum: int) -> bytes:
    if metadata.st_size > maximum:
        refuse("candidate authority input exceeds its bound")
    output = bytearray(); offset = 0
    while offset < metadata.st_size:
        block = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
        if not block:
            refuse("candidate authority input was truncated")
        output.extend(block); offset += len(block)
    if file_identity(os.fstat(descriptor)) != file_identity(metadata):
        refuse("candidate authority input changed while reading")
    return bytes(output)


def write_once(parent: int, name: str, payload: bytes) -> tuple[int, os.stat_result, str]:
    digest = hashlib.sha256(payload).hexdigest()

    def existing() -> tuple[int, os.stat_result] | None:
        try:
            descriptor, metadata = open_regular(parent, name, MAX_RECEIPT)
        except FileNotFoundError:
            return None
        if read_fd(descriptor, metadata, MAX_RECEIPT) != payload:
            os.close(descriptor); refuse("candidate authority record receipt conflicts")
        return descriptor, metadata

    prior = existing()
    if prior is not None:
        return prior[0], prior[1], digest
    if not hasattr(os, "O_TMPFILE"):
        refuse("atomic candidate authority receipt publication is unavailable")
    descriptor = os.open(".", os.O_WRONLY | os.O_TMPFILE, 0o600, dir_fd=parent)
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
        linkat = getattr(ctypes.CDLL(None, use_errno=True), "linkat", None)
        if linkat is None:
            refuse("linkat is unavailable for candidate authority publication")
        if linkat(descriptor, b"", parent, os.fsencode(name), 0x1000):
            error = ctypes.get_errno()
            if error != errno.EEXIST:
                raise OSError(error, os.strerror(error))
            prior = existing()
            if prior is None:
                refuse("candidate authority receipt disappeared")
            return prior[0], prior[1], digest
        os.fsync(parent)
    finally:
        os.close(descriptor)
    published, metadata = open_regular(parent, name, MAX_RECEIPT)
    if read_fd(published, metadata, MAX_RECEIPT) != payload:
        os.close(published); refuse("published candidate authority receipt changed")
    return published, metadata, digest


def seal_bytes(payload: bytes, expected_digest: str) -> tuple[int, os.stat_result]:
    if (not hasattr(os, "memfd_create") or not hasattr(fcntl, "F_ADD_SEALS") or
            hashlib.sha256(payload).hexdigest() != expected_digest):
        refuse("sealed candidate model authority is unavailable or mismatched")
    descriptor = os.memfd_create(
        "revival-candidate-compose-model",
        getattr(os, "MFD_CLOEXEC", 0x0001) | getattr(os, "MFD_ALLOW_SEALING", 0x0002))
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fchmod(descriptor, 0o600)
        fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS, REQUIRED_SEALS)
        if fcntl.fcntl(descriptor, fcntl.F_GET_SEALS) & REQUIRED_SEALS != REQUIRED_SEALS:
            refuse("candidate model memfd is not write-sealed")
        metadata = os.fstat(descriptor)
        if (metadata.st_size != len(payload) or
                hashlib.sha256(read_fd(descriptor, metadata, MAX_MODEL)).hexdigest() != expected_digest):
            refuse("sealed candidate model differs from candidate authority")
        return descriptor, metadata
    except BaseException:
        os.close(descriptor); raise


def open_trusted_program(path: str) -> tuple[int, os.stat_result]:
    if not re.fullmatch(r"/proc/self/fd/[1-9][0-9]*", path):
        refuse("candidate consumer is not a held descriptor")
    descriptor = os.open(path, os.O_RDONLY)
    metadata = os.fstat(descriptor)
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 0 or
            (metadata.st_uid, metadata.st_gid) != (os.getuid(), os.getgid()) or
            stat.S_IMODE(metadata.st_mode) not in (0o644, 0o755) or
            fcntl.fcntl(descriptor, fcntl.F_GET_SEALS) & REQUIRED_SEALS != REQUIRED_SEALS):
        os.close(descriptor); refuse("candidate consumer is not a trusted sealed program")
    return descriptor, metadata


def authority_checkpoint(_label: str, _candidate: int, _record: int) -> None:
    """Deterministic race-injection seam; production deliberately does nothing."""


class AuthorityMonitor:
    """Detect even swap/restore activity around mutable logical authority names."""

    def __init__(self, descriptors: tuple[int, ...]):
        library = ctypes.CDLL(None, use_errno=True)
        initializer = getattr(library, "inotify_init1", None)
        add_watch = getattr(library, "inotify_add_watch", None)
        if initializer is None or add_watch is None:
            refuse("kernel candidate-authority watches are unavailable")
        self.fd = initializer(os.O_CLOEXEC | os.O_NONBLOCK)
        if self.fd < 0:
            error = ctypes.get_errno(); raise OSError(error, os.strerror(error))
        try:
            for descriptor in descriptors:
                if add_watch(self.fd, os.fsencode(f"/proc/self/fd/{descriptor}"), WATCH_MASK) < 0:
                    error = ctypes.get_errno(); raise OSError(error, os.strerror(error))
        except BaseException:
            self.close(); raise

    def assert_quiet(self) -> None:
        while True:
            try: payload = os.read(self.fd, 1024 * 1024)
            except BlockingIOError: return
            if not payload: return
            offset = 0
            while offset < len(payload):
                _, mask, _, length = struct.unpack_from("iIII", payload, offset)
                if mask:
                    refuse("mutable candidate/model/record name changed during held execution")
                offset += 16 + length

    def close(self) -> None:
        if getattr(self, "fd", -1) >= 0:
            os.close(self.fd); self.fd = -1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--candidate-id", required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--record", required=True)
    parser.add_argument("--receipt-name", required=True)
    parser.add_argument("--expect-receipt-sha256")
    parser.add_argument("--program", required=True)
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    if arguments.arguments[:1] == ["--"]:
        arguments.arguments = arguments.arguments[1:]
    if not SHA256.fullmatch(arguments.candidate_id) or not SHA256.fullmatch(arguments.release_id):
        refuse("candidate or release ID is invalid")
    if (arguments.expect_receipt_sha256 is not None and
            not SHA256.fullmatch(arguments.expect_receipt_sha256)):
        refuse("expected record receipt digest is invalid")
    candidate_name = os.path.basename(arguments.candidate)
    record_name = os.path.basename(arguments.record)
    if (arguments.candidate != f"{REMOTE_ROOT}/release-candidates/{arguments.candidate_id}" or
            candidate_name != arguments.candidate_id or
            os.path.dirname(arguments.record) != f"{REMOTE_ROOT}/deployments" or
            not RECORD_NAME.fullmatch(record_name) or
            not OUTPUT_NAME.fullmatch(arguments.receipt_name) or
            not arguments.receipt_name.endswith("-compose-authority.json")):
        refuse("candidate, record, or receipt is outside the protected authority stores")

    candidate_parent = open_absolute(f"{REMOTE_ROOT}/release-candidates")
    record_parent = open_absolute(f"{REMOTE_ROOT}/deployments")
    candidate = record = descriptor_fd = model_source = model_fd = receipt_fd = program_fd = -1
    monitor: AuthorityMonitor | None = None
    try:
        candidate, candidate_meta = open_named_directory(
            candidate_parent, candidate_name, "candidate", flat=True)
        record, record_meta = open_named_directory(record_parent, record_name, "record")
        if set(os.listdir(candidate)) != EXPECTED_CANDIDATE_FILES:
            refuse("candidate inventory has missing or extra files")
        descriptor_fd, descriptor_meta = open_regular(candidate, "candidate.json", MAX_DESCRIPTOR)
        descriptor_bytes = read_fd(descriptor_fd, descriptor_meta, MAX_DESCRIPTOR)
        try:
            descriptor = json.loads(descriptor_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError):
            refuse("candidate descriptor is invalid JSON")
        if descriptor_bytes != canonical(descriptor) + b"\n":
            refuse("candidate descriptor is not canonical")
        body = descriptor.get("body") if isinstance(descriptor, dict) else None
        if (descriptor.get("schema") != "revival.release-candidate" or
                descriptor.get("schemaVersion") != 4 or
                descriptor.get("candidateId") != arguments.candidate_id or
                not isinstance(body, dict) or
                hashlib.sha256(canonical(body)).hexdigest() != arguments.candidate_id or
                not isinstance(body.get("release"), dict) or
                body["release"].get("id") != arguments.release_id):
            refuse("candidate descriptor does not reproduce the requested authority")
        if body.get("authority") not in (
                {"origin": "local-operator", "productionUse": "candidate-only"},
                {"origin": "github-hosted-actions", "productionUse": "requires-point-of-use-provider-evidence"}):
            refuse("candidate authority origin is unsupported")
        files = {entry.get("role"): entry for entry in body.get("files", [])
                 if isinstance(entry, dict)}
        model_entry = files.get("production-compose-model")
        model_binding = body.get("composeModel")
        if (not isinstance(model_entry, dict) or
                model_entry.get("basename") != "compose-model.json" or
                not SHA256.fullmatch(str(model_entry.get("sha256"))) or
                not isinstance(model_entry.get("size"), int) or
                not isinstance(model_binding, dict) or
                model_binding != {"digest": model_entry["sha256"],
                                  "role": "production-compose-model"}):
            refuse("candidate descriptor lacks its exact Compose model binding")
        model_source, model_source_meta = open_regular(candidate, "compose-model.json", MAX_MODEL)
        model_bytes = read_fd(model_source, model_source_meta, MAX_MODEL)
        model_digest = hashlib.sha256(model_bytes).hexdigest()
        if (model_source_meta.st_size != model_entry["size"] or
                model_digest != model_entry["sha256"]):
            refuse("candidate Compose model differs from its descriptor")
        try:
            model = json.loads(model_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError):
            refuse("candidate Compose model is invalid JSON")
        if (model_bytes != canonical(model) + b"\n" or
                not isinstance(model, dict) or
                model.get("schema") != "revival.production-compose-model" or
                model.get("schemaVersion") != 1 or
                model.get("releaseId") != arguments.release_id):
            refuse("candidate Compose model schema or release binding is invalid")
        model_fd, model_meta = seal_bytes(model_bytes, model_digest)
        receipt = {
            "schema": "revival.candidate-compose-authority",
            "schemaVersion": 1,
            "candidate": {
                "dev": candidate_meta.st_dev, "id": arguments.candidate_id,
                "ino": candidate_meta.st_ino,
            },
            "model": {"sha256": model_digest, "size": len(model_bytes)},
            "record": {
                "dev": record_meta.st_dev, "ino": record_meta.st_ino,
                "name": record_name,
            },
            "releaseId": arguments.release_id,
        }
        receipt_bytes = canonical(receipt) + b"\n"
        receipt_fd, receipt_meta, receipt_digest = write_once(
            record, arguments.receipt_name, receipt_bytes)
        if (arguments.expect_receipt_sha256 is not None and
                receipt_digest != arguments.expect_receipt_sha256):
            refuse("candidate authority record receipt differs from expected digest")
        program_fd, program_meta = open_trusted_program(arguments.program)
        monitor = AuthorityMonitor((candidate_parent, candidate, model_source,
                                    record_parent))

        def revalidate() -> None:
            if (directory_identity(os.fstat(candidate)) != directory_identity(candidate_meta) or
                    directory_identity(os.stat(candidate_name, dir_fd=candidate_parent,
                                               follow_symlinks=False)) != directory_identity(candidate_meta) or
                    set(os.listdir(candidate)) != EXPECTED_CANDIDATE_FILES or
                    directory_identity(os.fstat(record)) != directory_identity(record_meta) or
                    directory_identity(os.stat(record_name, dir_fd=record_parent,
                                               follow_symlinks=False)) != directory_identity(record_meta)):
                refuse("candidate or deployment-record directory authority changed")
            for descriptor, metadata, digest, maximum in (
                    (descriptor_fd, descriptor_meta, hashlib.sha256(descriptor_bytes).hexdigest(), MAX_DESCRIPTOR),
                    (model_source, model_source_meta, model_digest, MAX_MODEL),
                    (model_fd, model_meta, model_digest, MAX_MODEL),
                    (receipt_fd, receipt_meta, receipt_digest, MAX_RECEIPT)):
                if (file_identity(os.fstat(descriptor)) != file_identity(metadata) or
                        hashlib.sha256(read_fd(descriptor, metadata, maximum)).hexdigest() != digest):
                    refuse("held candidate/model/record authority changed")
            current_model = os.stat("compose-model.json", dir_fd=candidate,
                                    follow_symlinks=False)
            current_receipt = os.stat(arguments.receipt_name, dir_fd=record,
                                      follow_symlinks=False)
            if (file_identity(current_model) != file_identity(model_source_meta) or
                    file_identity(current_receipt) != file_identity(receipt_meta) or
                    file_identity(os.fstat(program_fd)) != file_identity(program_meta)):
                refuse("candidate model, receipt, or trusted program name changed")

        revalidate(); monitor.assert_quiet()
        authority_checkpoint("before-consumer", candidate, record)
        revalidate(); monitor.assert_quiet()
        inherited = (candidate_parent, candidate, record_parent, record, model_fd,
                     receipt_fd, program_fd)
        command = ["/usr/bin/python3", "-I", "-B", f"/proc/self/fd/{program_fd}",
                   "--candidate-parent-fd", str(candidate_parent),
                   "--candidate-fd", str(candidate),
                   "--candidate-name", candidate_name,
                   "--record-parent-fd", str(record_parent),
                   "--record-fd", str(record),
                   "--record-name", record_name,
                   "--compose-model-fd", str(model_fd),
                   "--compose-model-sha256", model_digest,
                   "--authority-receipt-fd", str(receipt_fd),
                   "--authority-receipt-sha256", receipt_digest,
                   "--authority-receipt-name", arguments.receipt_name,
                   *arguments.arguments]
        environment = {
            "DOCKER_CONFIG": f"{REMOTE_ROOT}/private/docker-cli-empty",
            "DOCKER_HOST": "unix:///var/run/docker.sock",
            "HOME": "/nonexistent",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": "/usr/bin:/usr/sbin",
            "TZ": "UTC",
        }
        result = subprocess.run(command, check=False, pass_fds=inherited,
                                env=environment)
        authority_checkpoint("after-consumer", candidate, record)
        revalidate(); monitor.assert_quiet()
        raise SystemExit(result.returncode)
    finally:
        if monitor is not None:
            monitor.close()
        for descriptor in (program_fd, receipt_fd, model_fd, model_source,
                           descriptor_fd, record, candidate, record_parent,
                           candidate_parent):
            if descriptor >= 0:
                try: os.close(descriptor)
                except OSError: pass


if __name__ == "__main__":
    main()
