#!/usr/bin/env python3
"""Verify and patch the pinned whisper.cpp sources in an external build cache."""
import argparse
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request


CRATE = "whisper-rs-sys-0.15.0"
MAX_EXPANDED = 32 * 1024**2
MAX_MEMBERS = 4096
MAX_FILE = 8 * 1024**2
DOWNLOAD_SECONDS = 180


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def load_manifest():
    content = Path(__file__).with_name("whisper-source.json").read_bytes()
    if len(content) > 4096:
        raise ValueError("whisper source manifest exceeds its bound")
    manifest = json.loads(content)
    if (set(manifest) != {"schemaVersion", "crate", "bytes", "sha256", "url", "nativePrefix", "patch", "patchSha256", "originalSourceSha256", "patchedSourceSha256"}
            or type(manifest["schemaVersion"]) is not int or manifest["schemaVersion"] != 1
            or manifest["crate"] != CRATE
            or type(manifest["bytes"]) is not int or not 0 < manifest["bytes"] <= 8 * 1024**2
            or manifest["url"] != f"https://static.crates.io/crates/whisper-rs-sys/{CRATE}.crate"
            or manifest["nativePrefix"] != f"{CRATE}/whisper.cpp/"
            or manifest["patch"] != "whisper-abort.patch"
            or any(not isinstance(manifest[key], str) or not re.fullmatch(r"[0-9a-f]{64}", manifest[key])
                   for key in ("sha256", "patchSha256", "originalSourceSha256", "patchedSourceSha256"))):
        raise ValueError("invalid pinned whisper source manifest")
    return manifest


def verify(archive, manifest):
    metadata = archive.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != manifest["bytes"]:
        raise ValueError("whisper archive must be a regular file of the pinned size")
    data = archive.read_bytes()
    if len(data) != manifest["bytes"] or sha256(data) != manifest["sha256"]:
        raise ValueError("whisper archive size or SHA-256 mismatch")


class HttpsRedirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, request, response, code, message, headers, url):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.username or parsed.password:
            raise ValueError("whisper source redirects require credential-free HTTPS")
        return super().redirect_request(request, response, code, message, headers, url)


def download(output, manifest):
    # This Unix command runs on the main thread. A socket timeout alone does
    # not bound slow headers or chunk framing that continually receive bytes.
    def expired(_signal, _frame):
        raise TimeoutError("whisper source download deadline expired")

    previous_handler = signal.signal(signal.SIGALRM, expired)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, DOWNLOAD_SECONDS)
    try:
        download_with_socket_timeout(output, manifest)
    finally:
        signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        signal.signal(signal.SIGALRM, previous_handler)


def download_with_socket_timeout(output, manifest):
    deadline = time.monotonic() + DOWNLOAD_SECONDS
    opener = urllib.request.build_opener(HttpsRedirects())
    count = 0
    with opener.open(manifest["url"], timeout=30) as response:
        parsed = urllib.parse.urlsplit(response.url)
        if parsed.scheme != "https" or parsed.username or parsed.password:
            raise ValueError("whisper source download requires credential-free HTTPS")
        length = response.headers.get("Content-Length")
        if length is not None and int(length) != manifest["bytes"]:
            raise ValueError("whisper source download size does not match")
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError("whisper source download deadline expired")
            block = response.read1(1024 * 1024)
            if not block:
                break
            count += len(block)
            if count > manifest["bytes"]:
                raise ValueError("whisper source download exceeds its pinned size")
            output.write(block)
    if time.monotonic() >= deadline or count != manifest["bytes"]:
        raise ValueError("whisper source download is incomplete or expired")


def apply_patch(original, patch):
    """Apply this one-file unified diff at exact line positions, without fuzz."""
    source = original.splitlines(keepends=True)
    lines = patch.splitlines(keepends=True)
    if lines[:2] != [b"--- a/src/whisper.cpp\n", b"+++ b/src/whisper.cpp\n"]:
        raise ValueError("invalid whisper source patch headers")
    result = []
    position = 0
    index = 2
    hunks = 0
    while index < len(lines):
        match = re.fullmatch(rb"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n", lines[index])
        if not match:
            raise ValueError("invalid whisper source patch hunk")
        old_start, old_count, new_start, new_count = (int(value) if value is not None else 1 for value in match.groups())
        start = old_start - 1 if old_count else old_start
        new_position = new_start - 1 if new_count else new_start
        if start < position or start > len(source):
            raise ValueError("whisper source patch position mismatch")
        result.extend(source[position:start])
        position = start
        if len(result) != new_position:
            raise ValueError("whisper source patch output position mismatch")
        index += 1
        old_seen = new_seen = 0
        while index < len(lines) and not lines[index].startswith(b"@@"):
            line = lines[index]
            kind = line[:1]
            if kind not in (b" ", b"-", b"+"):
                raise ValueError("invalid whisper source patch line")
            if kind in (b" ", b"-"):
                if position >= len(source) or source[position] != line[1:]:
                    raise ValueError("whisper source patch context mismatch")
                position += 1
                old_seen += 1
            if kind in (b" ", b"+"):
                result.append(line[1:])
                new_seen += 1
            index += 1
        if (old_seen, new_seen) != (old_count, new_count):
            raise ValueError("whisper source patch hunk count mismatch")
        hunks += 1
    if not hunks:
        raise ValueError("whisper source patch is empty")
    return b"".join(result + source[position:])


def compiler_inputs(archive, manifest, patch):
    # Bound decompression before tarfile parses extended headers or member data.
    with gzip.open(archive, "rb") as compressed:
        expanded = compressed.read(MAX_EXPANDED + 1)
    if len(expanded) > MAX_EXPANDED:
        raise ValueError("whisper source archive expansion exceeds its bound")
    names = set()
    files = {}
    with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as bundle:
        for item in bundle:
            path = PurePosixPath(item.name)
            if (len(names) >= MAX_MEMBERS or item.name in names or not path.parts
                    or path.is_absolute() or path.parts[0] != manifest["crate"]
                    or ".." in path.parts or "\\" in item.name
                    or item.name.rstrip("/") != str(path)
                    or item.type not in (tarfile.REGTYPE, tarfile.DIRTYPE)
                    or item.size < 0 or item.size > MAX_FILE):
                raise ValueError("invalid whisper source archive member")
            names.add(item.name)
            if item.type == tarfile.REGTYPE and item.name.startswith(manifest["nativePrefix"]):
                relative = item.name[len(manifest["nativePrefix"]):]
                with bundle.extractfile(item) as stream:
                    data = stream.read(item.size + 1)
                if len(data) != item.size:
                    raise ValueError("incomplete whisper source archive member")
                files[relative] = data
    if "CMakeLists.txt" not in files or "src/whisper.cpp" not in files:
        raise ValueError("whisper source archive is missing required compiler inputs")
    if sha256(patch) != manifest["patchSha256"] or sha256(files["src/whisper.cpp"]) != manifest["originalSourceSha256"]:
        raise ValueError("whisper source patch or original source SHA-256 mismatch")
    files["src/whisper.cpp"] = apply_patch(files["src/whisper.cpp"], patch)
    if sha256(files["src/whisper.cpp"]) != manifest["patchedSourceSha256"]:
        raise ValueError("patched whisper source SHA-256 mismatch")
    return files


def verify_materialized(root, files):
    if root.is_symlink() or not root.is_dir():
        raise ValueError("cached whisper source root must be a directory")
    expected_dirs = {str(parent) for name in files for parent in PurePosixPath(name).parents if str(parent) != "."}
    actual_files = set()
    actual_dirs = set()
    for path in root.rglob("*"):
        name = str(path.relative_to(root))
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            actual_dirs.add(name)
        elif stat.S_ISREG(mode) and name in files:
            if path.stat().st_size != len(files[name]) or path.read_bytes() != files[name]:
                raise ValueError("cached whisper compiler inputs changed")
            actual_files.add(name)
        else:
            raise ValueError("cached whisper compiler input member changed")
    if actual_files != set(files) or actual_dirs != expected_dirs:
        raise ValueError("cached whisper compiler input member set changed")


def load_patch(manifest):
    patch_path = Path(__file__).with_name(manifest["patch"])
    metadata = patch_path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 64 * 1024:
        raise ValueError("whisper source patch must be a bounded regular file")
    return patch_path.read_bytes()


def prepare(cache):
    manifest = load_manifest()
    patch = load_patch(manifest)
    cache = cache.resolve()
    checkout = Path(__file__).resolve().parents[2]
    if cache == checkout or checkout in cache.parents:
        raise ValueError("whisper source cache must be outside the checkout")
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_fd = os.open(cache / "whisper.lock", os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        archive = cache / (manifest["crate"] + ".crate")
        if not archive.exists() and not archive.is_symlink():
            with tempfile.NamedTemporaryFile(dir=cache, prefix=".download-", delete=False) as output:
                temporary = Path(output.name)
                try:
                    download(output, manifest)
                    output.flush()
                    os.fsync(output.fileno())
                    verify(temporary, manifest)
                    os.replace(temporary, archive)
                finally:
                    temporary.unlink(missing_ok=True)
        verify(archive, manifest)
        files = compiler_inputs(archive, manifest, patch)
        root = cache / (manifest["crate"] + "-" + manifest["patchSha256"][:16])
        if root.exists() or root.is_symlink():
            verify_materialized(root, files)
        else:
            destination = Path(tempfile.mkdtemp(prefix=".extract-", dir=cache))
            try:
                for name, data in files.items():
                    target = destination / name
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    target.write_bytes(data)
                    target.chmod(0o600)
                verify_materialized(destination, files)
                os.rename(destination, root)
            finally:
                if destination.exists():
                    shutil.rmtree(destination)
    return root


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    print(prepare(args.cache))
