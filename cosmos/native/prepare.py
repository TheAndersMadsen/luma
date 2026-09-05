#!/usr/bin/env python3
"""Acquire the exact libwebrtc archive into an external, operator-owned cache."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import tempfile
import urllib.request
import zipfile


def verify(archive, expected):
    digest = hashlib.sha256()
    size = 0
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(block)
            digest.update(block)
    if size != expected["bytes"] or digest.hexdigest() != expected["sha256"]:
        raise ValueError("libwebrtc archive size or SHA-256 mismatch")


def extract(archive, destination, root_name):
    with zipfile.ZipFile(archive) as bundle:
        names = set()
        total = 0
        for item in bundle.infolist():
            path = PurePosixPath(item.filename)
            mode = item.external_attr >> 16
            total += item.file_size
            if (path.is_absolute() or ".." in path.parts or "\\" in item.filename
                    or not path.parts or path.parts[0] != root_name
                    or item.filename in names or total > 3 * 1024**3
                    or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError("invalid libwebrtc archive member")
            names.add(item.filename)
        bundle.extractall(destination)
    # Python deliberately does not restore zip mode bits. Inputs are data; no
    # downloaded executable is run during acquisition or compilation.
    for path in (destination / root_name).rglob("*"):
        path.chmod(0o700 if path.is_dir() else 0o600)


def verify_materialized(archive, root):
    """Compare every compiler input with bytes from the authenticated archive."""
    expected = set()
    with zipfile.ZipFile(archive) as bundle:
        for item in bundle.infolist():
            if item.is_dir():
                continue
            relative = PurePosixPath(item.filename).relative_to(root.name)
            expected.add(str(relative))
            target = root / relative
            if target.is_symlink() or not target.is_file() or target.stat().st_size != item.file_size:
                raise ValueError("cached libwebrtc inputs changed")
            with bundle.open(item) as original, target.open("rb") as cached:
                while block := original.read(1024 * 1024):
                    if block != cached.read(len(block)):
                        raise ValueError("cached libwebrtc inputs changed")
    actual = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("cached libwebrtc symlink")
        if path.is_file():
            actual.add(str(path.relative_to(root)))
    if actual != expected:
        raise ValueError("cached libwebrtc member set changed")


def prepare(cache, target):
    contract = json.loads(Path(__file__).with_name("webrtc.json").read_text())
    expected = contract["assets"][target]
    cache = cache.resolve()
    checkout = Path(__file__).resolve().parents[2]
    if cache == checkout or checkout in cache.parents:
        raise ValueError("libwebrtc cache must be outside the checkout")
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    root_name = target + "-release"
    archive = cache / ("webrtc-" + root_name + ".zip")
    if archive.is_symlink():
        raise ValueError("libwebrtc archive must not be a symlink")
    if not archive.exists():
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as output:
            temporary = Path(output.name)
            try:
                url = ("https://github.com/livekit/rust-sdks/releases/download/"
                       + contract["tag"] + "/" + archive.name)
                size = 0
                with urllib.request.urlopen(url, timeout=45) as response:
                    if not response.url.startswith("https://"):
                        raise ValueError("libwebrtc download requires HTTPS")
                    while block := response.read(1024 * 1024):
                        size += len(block)
                        if size > expected["bytes"]:
                            raise ValueError("libwebrtc download exceeds pinned size")
                        output.write(block)
                output.flush()
                verify(temporary, expected)
                os.replace(temporary, archive)
            finally:
                temporary.unlink(missing_ok=True)
    verify(archive, expected)
    # Stable paths preserve Cargo reuse. Existence alone is never verification;
    # compare the complete extracted tree with the digest-verified archive.
    parent = cache / contract["tag"]
    parent.mkdir(exist_ok=True, mode=0o700)
    root = parent / root_name
    with (cache / (target + ".lock")).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if root.exists():
            if root.is_symlink():
                raise ValueError("cached libwebrtc root must not be a symlink")
            verify_materialized(archive, root)
        else:
            destination = Path(tempfile.mkdtemp(prefix="extract-", dir=cache))
            try:
                extract(archive, destination, root_name)
                os.rename(destination / root_name, root)
            finally:
                shutil.rmtree(destination)
    return root


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, required=True)
    default_os = {"Darwin": "mac", "Linux": "linux"}.get(platform.system(), "unsupported")
    default_arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x64"}.get(platform.machine(), "unsupported")
    parser.add_argument("--target", default=default_os + "-" + default_arch)
    args = parser.parse_args()
    print(prepare(args.cache, args.target))
