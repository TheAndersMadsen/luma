#!/usr/bin/env python3
"""Validate, inventory, and privately export clone-owned prompts.

This tool has no network behavior. It reads only the independently authored
prompt registry in this repository and writes exports only to a new private file
outside the repository.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


REPO_ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = REPO_ROOT / "prompts" / "registry.json"
CONTENT_ROOT = REPO_ROOT / "prompts" / "content"
MAX_PROMPT_BYTES = 256 * 1024

PROMPT_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$")
SEMVER_RE = re.compile(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
EVIDENCE_GRADES = frozenset({"chosen", "derived"})
LIFECYCLES = frozenset({"candidate", "active", "retired"})
ENTRY_FIELDS = frozenset(
    {
        "id",
        "version",
        "path",
        "sha256",
        "evidence_grade",
        "lifecycle",
        "intended_behavior",
    }
)


class RegistryError(ValueError):
    """The prompt inventory is incomplete, inconsistent, or unsafe to export."""


@dataclass(frozen=True)
class ResolvedPrompt:
    metadata: dict[str, str]
    path: Path
    content: str


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _read_json(path: Path) -> tuple[dict[str, Any], bytes]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise RegistryError(f"cannot read registry {path}: {exc}") from exc
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RegistryError(f"registry is not valid UTF-8 JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise RegistryError("registry root must be an object")
    return value, raw


def validate_registry(
    repo_root: Path = REPO_ROOT, registry_path: Path | None = None
) -> tuple[dict[str, Any], bytes, list[ResolvedPrompt]]:
    """Validate the complete registry and return resolved prompt contents.

    Validation fails for an unregistered content file, a missing file, a hash
    mismatch, a path escape, a symlink, duplicate metadata, or an invalid set.
    """

    repo_root = repo_root.resolve()
    registry_path = registry_path or repo_root / "prompts" / "registry.json"
    content_root = (repo_root / "prompts" / "content").resolve()
    registry, registry_raw = _read_json(registry_path)
    errors: list[str] = []

    if registry.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    if registry.get("authorship") != "clean-room-independent":
        errors.append("authorship must be clean-room-independent")
    if not isinstance(registry.get("scope"), str) or not registry["scope"].strip():
        errors.append("scope must be a non-empty string")

    prompt_entries = registry.get("prompts")
    if not isinstance(prompt_entries, list) or not prompt_entries:
        errors.append("prompts must be a non-empty array")
        prompt_entries = []

    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    resolved: list[ResolvedPrompt] = []

    for index, value in enumerate(prompt_entries):
        label = f"prompts[{index}]"
        if not isinstance(value, dict):
            errors.append(f"{label} must be an object")
            continue
        missing_fields = ENTRY_FIELDS - value.keys()
        unknown_fields = value.keys() - ENTRY_FIELDS
        if missing_fields:
            errors.append(f"{label} missing fields: {', '.join(sorted(missing_fields))}")
        if unknown_fields:
            errors.append(f"{label} has unknown fields: {', '.join(sorted(unknown_fields))}")
        if missing_fields:
            continue

        prompt_id = value["id"]
        version = value["version"]
        relative_path = value["path"]
        expected_hash = value["sha256"]
        evidence_grade = value["evidence_grade"]
        lifecycle = value["lifecycle"]
        intended_behavior = value["intended_behavior"]

        if not isinstance(prompt_id, str) or not PROMPT_ID_RE.fullmatch(prompt_id):
            errors.append(f"{label}.id is invalid")
        elif prompt_id in seen_ids:
            errors.append(f"duplicate prompt id: {prompt_id}")
        else:
            seen_ids.add(prompt_id)

        if not isinstance(version, str) or not SEMVER_RE.fullmatch(version):
            errors.append(f"{label}.version must be MAJOR.MINOR.PATCH")
        if not isinstance(expected_hash, str) or not SHA256_RE.fullmatch(expected_hash):
            errors.append(f"{label}.sha256 must be 64 lowercase hexadecimal characters")
        if evidence_grade not in EVIDENCE_GRADES:
            errors.append(f"{label}.evidence_grade must be chosen or derived")
        if lifecycle not in LIFECYCLES:
            errors.append(f"{label}.lifecycle is invalid")
        if (
            not isinstance(intended_behavior, str)
            or not intended_behavior.strip()
            or len(intended_behavior) > 500
        ):
            errors.append(f"{label}.intended_behavior must contain 1 to 500 characters")

        if not isinstance(relative_path, str):
            errors.append(f"{label}.path must be a string")
            continue
        relative = Path(relative_path)
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or relative.suffix != ".prompt"
            or relative.parts[:2] != ("prompts", "content")
        ):
            errors.append(f"{label}.path must name a .prompt file below prompts/content")
            continue
        canonical_relative = relative.as_posix()
        if canonical_relative != relative_path:
            errors.append(f"{label}.path must use canonical POSIX separators")
        if canonical_relative in seen_paths:
            errors.append(f"duplicate prompt path: {canonical_relative}")
            continue
        seen_paths.add(canonical_relative)

        full_path = (repo_root / relative).resolve(strict=False)
        if not _is_within(full_path, content_root):
            errors.append(f"{label}.path escapes prompts/content")
            continue
        if (repo_root / relative).is_symlink():
            errors.append(f"{label}.path must not be a symlink")
            continue
        if not full_path.is_file():
            errors.append(f"{label}.path does not exist: {relative_path}")
            continue
        try:
            raw = full_path.read_bytes()
        except OSError as exc:
            errors.append(f"cannot read {relative_path}: {exc}")
            continue
        if not raw or len(raw) > MAX_PROMPT_BYTES:
            errors.append(f"{relative_path} must contain 1 to {MAX_PROMPT_BYTES} bytes")
            continue
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            errors.append(f"{relative_path} must be UTF-8")
            continue
        if "\x00" in content:
            errors.append(f"{relative_path} must not contain NUL bytes")
        if not content.endswith("\n"):
            errors.append(f"{relative_path} must end with a newline")
        actual_hash = _sha256(raw)
        if actual_hash != expected_hash:
            errors.append(
                f"hash mismatch for {relative_path}: registry={expected_hash} actual={actual_hash}"
            )
        resolved.append(
            ResolvedPrompt(
                metadata={key: str(value[key]) for key in ENTRY_FIELDS},
                path=full_path,
                content=content,
            )
        )

    actual_paths: set[str] = set()
    if content_root.is_dir():
        for path in content_root.rglob("*.prompt"):
            if path.is_symlink():
                errors.append(f"prompt content must not be a symlink: {path}")
                continue
            if path.is_file():
                actual_paths.add(path.relative_to(repo_root).as_posix())
    else:
        errors.append("prompts/content directory does not exist")
    for orphan in sorted(actual_paths - seen_paths):
        errors.append(f"unregistered prompt file: {orphan}")
    for missing in sorted(seen_paths - actual_paths):
        errors.append(f"registered prompt file not found: {missing}")

    prompt_sets = registry.get("prompt_sets")
    if not isinstance(prompt_sets, list):
        errors.append("prompt_sets must be an array")
        prompt_sets = []
    seen_set_ids: set[str] = set()
    for index, value in enumerate(prompt_sets):
        label = f"prompt_sets[{index}]"
        if not isinstance(value, dict) or set(value) != {"id", "members"}:
            errors.append(f"{label} must contain exactly id and members")
            continue
        set_id = value["id"]
        members = value["members"]
        if not isinstance(set_id, str) or not PROMPT_ID_RE.fullmatch(set_id):
            errors.append(f"{label}.id is invalid")
        elif set_id in seen_set_ids:
            errors.append(f"duplicate prompt set id: {set_id}")
        else:
            seen_set_ids.add(set_id)
        if not isinstance(members, list) or not members:
            errors.append(f"{label}.members must be a non-empty array")
            continue
        if len(members) != len(set(members)):
            errors.append(f"{label}.members contains a duplicate")
        for member in members:
            if member not in seen_ids:
                errors.append(f"{label} references unknown prompt id: {member}")

    if errors:
        raise RegistryError("prompt registry validation failed:\n- " + "\n- ".join(errors))
    return registry, registry_raw, resolved


def private_dump(
    output: Path,
    *,
    acknowledge_owned_prompts: bool,
    repo_root: Path = REPO_ROOT,
    registry_path: Path | None = None,
) -> tuple[Path, int, str]:
    """Write a non-overwriting mode-0600 JSON dump outside the repository."""

    if not acknowledge_owned_prompts:
        raise RegistryError(
            "dump requires --acknowledge-owned-prompts; this exports only prompts owned by this clone"
        )
    repo_root = repo_root.resolve()
    if not output.is_absolute():
        raise RegistryError("dump output must be an absolute path")
    if output.suffix.lower() != ".json":
        raise RegistryError("dump output must use a .json suffix")
    if output.is_symlink():
        raise RegistryError("dump output must not be a symlink")
    destination = output.resolve(strict=False)
    if _is_within(destination, repo_root):
        raise RegistryError("dump output must be outside the repository")
    parent = destination.parent
    if not parent.is_dir():
        raise RegistryError("dump output parent directory must already exist")
    parent_mode = stat.S_IMODE(parent.stat().st_mode)
    if parent_mode & 0o077:
        raise RegistryError("dump output parent directory must be private (mode 0700 or stricter)")

    registry, registry_raw, prompts = validate_registry(repo_root, registry_path)
    export = {
        "schema_version": 1,
        "source": "operator-owned clean-room Cosmos runtime",
        "registry_sha256": _sha256(registry_raw),
        "registry_scope": registry["scope"],
        "prompts": [
            {**prompt.metadata, "content": prompt.content}
            for prompt in prompts
        ],
        "prompt_sets": registry["prompt_sets"],
    }
    blob = (json.dumps(export, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(destination, flags, 0o600)
    except OSError as exc:
        raise RegistryError(f"refusing to overwrite or open dump destination: {exc}") from exc
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(blob)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    return destination, len(prompts), _sha256(blob)


def calculated_hashes(repo_root: Path = REPO_ROOT) -> dict[str, str]:
    content_root = repo_root / "prompts" / "content"
    return {
        path.relative_to(repo_root).as_posix(): _sha256(path.read_bytes())
        for path in sorted(content_root.rglob("*.prompt"))
        if path.is_file() and not path.is_symlink()
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("validate", help="verify metadata, inventory, paths, and content hashes")

    list_parser = subparsers.add_parser("list", help="list metadata without prompt contents")
    list_parser.add_argument("--json", action="store_true", help="emit metadata as JSON")

    subparsers.add_parser("hashes", help="calculate current content hashes without modifying files")

    dump_parser = subparsers.add_parser(
        "dump", help="privately export every registered clone-owned prompt"
    )
    dump_parser.add_argument("--output", required=True, type=Path, help="new absolute .json path")
    dump_parser.add_argument(
        "--acknowledge-owned-prompts",
        action="store_true",
        help="confirm this is an export of prompts owned by the operator's clone",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "hashes":
            print(json.dumps(calculated_hashes(), indent=2, sort_keys=True))
            return 0
        registry, registry_raw, prompts = validate_registry()
        if args.command == "validate":
            print(
                f"validated {len(prompts)} prompts and {len(registry['prompt_sets'])} prompt set; "
                f"registry sha256={_sha256(registry_raw)}"
            )
            return 0
        if args.command == "list":
            metadata = [prompt.metadata for prompt in prompts]
            if args.json:
                print(json.dumps(metadata, indent=2, sort_keys=True))
            else:
                for item in metadata:
                    print(
                        f"{item['id']}@{item['version']} {item['evidence_grade']} "
                        f"{item['lifecycle']} sha256:{item['sha256']}"
                    )
            return 0
        if args.command == "dump":
            destination, count, digest = private_dump(
                args.output,
                acknowledge_owned_prompts=args.acknowledge_owned_prompts,
            )
            print(f"exported {count} clone-owned prompts to {destination} sha256={digest}")
            return 0
    except RegistryError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
