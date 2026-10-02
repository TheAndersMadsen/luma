#!/usr/bin/env python3
"""Fail when Cosmos source files resemble private evidence or secrets."""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
from pathlib import Path


FORBIDDEN_SUFFIXES = {
    ".apk",
    ".bks",
    ".bin",
    ".dump",
    ".key",
    ".p12",
    ".pfx",
    ".pcap",
    ".pcapng",
}
FORBIDDEN_NAMES = {"cosmos-raw.log", "cosmos-traffic.jsonl", "captured_flow.jsonl"}
SENSITIVE_PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:EC |RSA )?PRIVATE KEY-----"),
    "device-user subject": re.compile(r"CN=V:[0-9]+:D:[^\s,:]+:U:[^\s,]+"),
    "bearer token": re.compile(r"authorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._~+/-]{16,}", re.I),
    "full pin serial": re.compile(r"\b1H4MPA[0-9A-Z]{7,}\b"),
}

REVIEWED_BINARY_SHA256: dict[str, str] = {}

STANDALONE_EXCLUDED_DIRS = {
    ".git",
    ".idea",
    ".vscode",
    "__pycache__",
    "captures",
    "evidence-private",
    "generated",
    "logs",
    "secrets",
    "target",
}

# These reviewed implementation/verification files contain deliberately
# synthetic certificate subjects. Real subjects remain forbidden everywhere,
# and any newly added file containing the pattern still fails.
REVIEWED_SYNTHETIC_SUBJECT_FILES = {
    "crates/cosmos/src/config.rs",
    "crates/cosmos/src/enrollment.rs",
    "crates/cosmos/src/services/device_block.rs",
}


def repository_files(root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return [root / line for line in result.stdout.splitlines() if line]

    # Luma is deliberately usable as a standalone source tree, before
    # anyone initializes Git. Mirror the narrow generated/private exclusions
    # from .gitignore rather than silently skipping the hygiene gate.
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(part in STANDALONE_EXCLUDED_DIRS for part in relative.parts[:-1]):
            continue
        if relative.as_posix().startswith("proto/private-observed/"):
            continue
        if path.name == ".DS_Store" or path.suffix in {".pyc", ".pyo"}:
            continue
        if path.name == ".env" or (
            path.name.startswith(".env.") and path.name != ".env.example"
        ):
            continue
        if path.is_file() or path.is_symlink():
            files.append(path)
    return files


def check(root: Path) -> list[str]:
    errors: list[str] = []
    for path in repository_files(root):
        relative = path.relative_to(root)
        relative_text = relative.as_posix()
        if path.is_symlink():
            errors.append(f"unreviewed symlink: {relative}")
            continue
        if path.name in FORBIDDEN_NAMES or path.suffix.lower() in FORBIDDEN_SUFFIXES:
            errors.append(f"forbidden artifact: {relative}")
            continue
        try:
            if path.stat().st_size > 2_000_000:
                errors.append(f"unreviewed large file: {relative}")
                continue
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            expected = REVIEWED_BINARY_SHA256.get(relative_text)
            try:
                actual = hashlib.sha256(path.read_bytes()).hexdigest()
            except OSError:
                actual = ""
            if expected != actual:
                errors.append(f"unreviewed binary file: {relative}")
            continue
        except OSError:
            errors.append(f"unreadable repository file: {relative}")
            continue
        for label, pattern in SENSITIVE_PATTERNS.items():
            if (
                label == "device-user subject"
                and relative_text in REVIEWED_SYNTHETIC_SUBJECT_FILES
            ):
                continue
            if pattern.search(content):
                errors.append(f"{label}: {relative}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    errors = check(args.root.resolve())
    if errors:
        print("\n".join(errors))
        return 1
    print("repository hygiene check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
