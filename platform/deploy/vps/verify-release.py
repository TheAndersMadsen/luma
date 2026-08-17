#!/usr/bin/env python3
"""Verify and safely extract one deterministic Ai Pin Revival release archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SUPPORTED_MODES = {"0644": 0o644, "0755": 0o755}


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"release verification failed: {message}")


def safe_path(value: str) -> PurePosixPath:
    if not isinstance(value, str):
        fail("manifest contains a non-string path")
    if not value or value.startswith("/") or "\\" in value or "\0" in value:
        fail("manifest contains an unsafe path")
    if any(part in ("", ".", "..") for part in value.split("/")):
        fail("manifest contains a non-canonical path")
    return PurePosixPath(value)


def require_regular_file(path: Path, label: str) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(f"cannot inspect {label}: {error}")
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail(f"{label} must be a regular file")
    return metadata


def require_real_directory(path: Path, label: str) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(f"cannot inspect {label}: {error}")
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail(f"{label} must be a real directory")
    return metadata


def path_exists_without_following(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    except OSError as error:
        fail(f"cannot inspect extraction target: {error}")
    return True


def canonical_release_id(manifest: dict) -> str:
    payload = {
        "schemaVersion": manifest.get("schemaVersion"),
        "profile": manifest.get("profile"),
        "entries": manifest.get("entries"),
    }
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def load_manifest(path: Path) -> tuple[dict, dict[str, dict]]:
    require_regular_file(path, "manifest")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read manifest: {error}")
    if not isinstance(manifest, dict) or set(manifest) != {
        "schemaVersion",
        "profile",
        "releaseId",
        "entries",
    }:
        fail("manifest fields do not match the supported schema")
    if manifest.get("schemaVersion") != 1 or manifest.get("profile") != "vps":
        fail("unexpected manifest schema or profile")
    release_id = manifest.get("releaseId")
    if not isinstance(release_id, str) or SHA256_RE.fullmatch(release_id) is None:
        fail("invalid release id")
    if canonical_release_id(manifest) != release_id:
        fail("release id does not match canonical manifest digest")
    entries = manifest.get("entries")
    if not isinstance(entries, list) or not entries:
        fail("manifest has no entries")
    indexed: dict[str, dict] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            fail("invalid manifest entry")
        if set(entry) != {"path", "sha256", "size", "mode"}:
            fail("manifest entry fields do not match the supported schema")
        name = str(safe_path(entry.get("path", "")))
        # The canonical packager sorts with JavaScript localeCompare("en"),
        # whose collation is not byte-for-byte reproducible with Python's
        # default ordering. The selected release ID binds the exact entry order;
        # the remote verifier only needs to reject duplicates here.
        if name in indexed:
            fail("manifest paths are not unique")
        digest = entry.get("sha256")
        size = entry.get("size")
        mode = entry.get("mode")
        if not isinstance(digest, str) or SHA256_RE.fullmatch(digest) is None:
            fail("invalid file digest")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            fail("invalid file size")
        if not isinstance(mode, str) or mode not in SUPPORTED_MODES:
            fail("invalid file mode")
        mode_value = SUPPORTED_MODES[mode]
        entry = dict(entry)
        entry["modeValue"] = mode_value
        indexed[name] = entry
    return manifest, indexed


def allowed_directories(entries: dict[str, dict]) -> set[str]:
    directories: set[str] = set()
    for name in entries:
        parent = PurePosixPath(name).parent
        while str(parent) != ".":
            directories.add(str(parent))
            parent = parent.parent
    return directories


def verify_archive(archive: Path, entries: dict[str, dict], extract: Path | None) -> None:
    archive_metadata = require_regular_file(archive, "archive")
    if archive_metadata.st_size > MAX_ARCHIVE_BYTES:
        fail("archive exceeds the verification size limit")
    if extract is not None and path_exists_without_following(extract):
        fail("extraction target already exists")
    temporary: Path | None = None
    try:
        if extract is not None:
            extract.parent.mkdir(parents=True, exist_ok=True)
            temporary = Path(tempfile.mkdtemp(prefix=f".{extract.name}.", dir=extract.parent))
        seen: list[str] = []
        extracted_bytes = 0
        try:
            bundle = tarfile.open(archive, mode="r:gz")
        except (OSError, tarfile.TarError) as error:
            fail(f"cannot open archive: {error}")
        with bundle:
            try:
                for member in bundle:
                    if not member.isreg():
                        fail("archive contains a non-regular member")
                    name = str(safe_path(member.name))
                    if name not in entries or name in seen:
                        fail("archive contains an unexpected or duplicate member")
                    seen.append(name)
                    expected = entries[name]
                    if member.size != expected["size"]:
                        fail(f"size mismatch for {name}")
                    if stat.S_IMODE(member.mode) != expected["modeValue"]:
                        fail(f"mode mismatch for {name}")
                    extracted_bytes += member.size
                    if extracted_bytes > MAX_EXTRACTED_BYTES:
                        fail("archive exceeds the extracted-size limit")
                    source = bundle.extractfile(member)
                    if source is None:
                        fail(f"cannot read {name}")
                    digest = hashlib.sha256()
                    destination = temporary / name if temporary is not None else None
                    if destination is not None:
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        output = destination.open("xb")
                    else:
                        output = None
                    try:
                        while chunk := source.read(1024 * 1024):
                            digest.update(chunk)
                            if output is not None:
                                output.write(chunk)
                    finally:
                        source.close()
                        if output is not None:
                            output.close()
                    if digest.hexdigest() != expected["sha256"]:
                        fail(f"digest mismatch for {name}")
                    if destination is not None:
                        destination.chmod(expected["modeValue"])
            except (OSError, tarfile.TarError) as error:
                fail(f"cannot read archive: {error}")
        if seen != list(entries):
            fail("archive file set does not match the manifest")
        if extract is not None and temporary is not None:
            os.replace(temporary, extract)
            temporary = None
    finally:
        if temporary is not None:
            shutil.rmtree(temporary, ignore_errors=True)


def verify_tree(root: Path, entries: dict[str, dict]) -> None:
    require_real_directory(root, "release tree")
    seen: set[str] = set()
    allowed_dirs = allowed_directories(entries)
    def walk_error(error: OSError) -> None:
        fail(f"cannot inspect release tree: {error}")

    for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
        dirs[:] = sorted(dirs)
        for dirname in dirs:
            path = Path(directory) / dirname
            relative = path.relative_to(root).as_posix()
            metadata = path.lstat()
            if not stat.S_ISDIR(metadata.st_mode) or relative not in allowed_dirs:
                fail("release tree contains an unexpected or unsafe directory")
        for filename in sorted(files):
            path = Path(directory) / filename
            relative = path.relative_to(root).as_posix()
            metadata = path.lstat()
            if not stat.S_ISREG(metadata.st_mode) or relative not in entries:
                fail("release tree contains an unexpected or unsafe file")
            expected = entries[relative]
            if metadata.st_size != expected["size"]:
                fail(f"tree size mismatch for {relative}")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != expected["sha256"]:
                fail(f"tree digest mismatch for {relative}")
            if stat.S_IMODE(metadata.st_mode) != expected["modeValue"]:
                fail(f"tree mode mismatch for {relative}")
            seen.add(relative)
    if seen != set(entries):
        fail("release tree file set does not match manifest")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--tree", type=Path)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--extract", type=Path)
    parser.add_argument("--expect-release-id")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if (args.archive is None) == (args.tree is None):
        parser.error("choose exactly one of --archive or --tree")
    manifest, entries = load_manifest(args.manifest)
    if args.expect_release_id is not None:
        if SHA256_RE.fullmatch(args.expect_release_id) is None:
            parser.error("--expect-release-id must be a lowercase SHA-256 digest")
        if manifest["releaseId"] != args.expect_release_id:
            fail("manifest release id does not match the expected release")
    if args.archive is not None:
        verify_archive(args.archive, entries, args.extract)
    else:
        if args.extract is not None:
            parser.error("--extract requires --archive")
        verify_tree(args.tree, entries)
    result = {
        "ok": True,
        "releaseId": manifest["releaseId"],
        "profile": manifest["profile"],
        "files": len(entries),
    }
    print(json.dumps(result, separators=(",", ":")) if args.json else f"verified {len(entries)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
