#!/usr/bin/env python3
"""Acquire one checksum-pinned model into an external cache or image layer."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
import urllib.parse
import urllib.request


def load_manifest():
    content = Path(__file__).with_name("stt-model.json").read_bytes()
    if len(content) > 4096:
        raise ValueError("STT model manifest exceeds its bound")
    model = json.loads(content)
    if (set(model) != {"schemaVersion", "id", "file", "bytes", "sha256", "url"}
            or type(model["schemaVersion"]) is not int or model["schemaVersion"] != 1
            or model["file"] != "ggml-base.bin"
            or type(model["bytes"]) is not int or not 0 < model["bytes"] <= 1024**3
            or not isinstance(model["id"], str) or not model["id"].isascii() or not 0 < len(model["id"]) <= 512
            or not re.fullmatch(r"[0-9a-f]{64}", model["sha256"])
            or not re.fullmatch(r"https://huggingface\.co/ggerganov/whisper\.cpp/resolve/[0-9a-f]{40}/ggml-base\.bin", model["url"])):
        raise ValueError("invalid pinned STT model manifest")
    return model


def verify(path, model):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != model["bytes"]:
        raise ValueError("STT model must be a regular file of the pinned size")
    digest = hashlib.sha256()
    count = 0
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            count += len(block)
            if count > model["bytes"]:
                raise ValueError("STT model exceeds its pinned size")
            digest.update(block)
    if count != model["bytes"] or digest.hexdigest() != model["sha256"]:
        raise ValueError("STT model size or SHA-256 mismatch")


class HttpsRedirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, request, response, code, message, headers, url):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.username or parsed.password:
            raise ValueError("STT model redirects require credential-free HTTPS")
        return super().redirect_request(request, response, code, message, headers, url)


def download(output, model):
    deadline = time.monotonic() + 180
    opener = urllib.request.build_opener(HttpsRedirects())
    count = 0
    with opener.open(model["url"], timeout=30) as response:
        if not response.url.startswith("https://"):
            raise ValueError("STT model download requires HTTPS")
        length = response.headers.get("Content-Length")
        if length is not None and int(length) != model["bytes"]:
            raise ValueError("STT model download size does not match")
        # read1 returns available bytes, unlike read(N), which may keep filling
        # a buffer across a slow stream. Check the total budget each time; a
        # pending network read has a separate 30-second timeout.
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError("STT model download deadline expired")
            block = response.read1(1024 * 1024)
            if not block:
                break
            count += len(block)
            if count > model["bytes"]:
                raise ValueError("STT model download exceeds its pinned size")
            output.write(block)
    if time.monotonic() >= deadline or count != model["bytes"]:
        raise ValueError("STT model download is incomplete or expired")


def prepare(directory):
    model = load_manifest()
    directory = directory.resolve()
    checkout = Path(__file__).resolve().parents[2]
    if directory == checkout or checkout in directory.parents:
        raise ValueError("STT model directory must be outside the checkout")
    directory.mkdir(parents=True, exist_ok=True, mode=0o755)
    target = directory / model["file"]
    if target.exists() or target.is_symlink():
        verify(target, model)
        if stat.S_IMODE(target.stat().st_mode) != 0o444:
            raise ValueError("STT model must be read-only with mode 0444")
        return target
    with tempfile.NamedTemporaryFile(dir=directory, prefix=".stt-", delete=False) as output:
        temporary = Path(output.name)
        try:
            download(output, model)
            output.flush()
            os.fsync(output.fileno())
            verify(temporary, model)
            temporary.chmod(0o444)
            # Exclusive link is atomic and cannot replace a competing writer's
            # file. Every winner must independently match the pinned bytes.
            try:
                os.link(temporary, target)
            except FileExistsError:
                verify(target, model)
                if stat.S_IMODE(target.stat().st_mode) != 0o444:
                    raise ValueError("STT model must be read-only with mode 0444")
        finally:
            temporary.unlink(missing_ok=True)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    print(prepare(args.directory))
