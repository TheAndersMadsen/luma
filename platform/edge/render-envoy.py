#!/usr/bin/env python3
"""Render the protected Cosmos Envoy edge without exposing its proof token."""

from __future__ import annotations

import argparse
import os
import re
import tempfile
from pathlib import Path


TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{40,160}$")
SERVER_NAMES_PATTERN = re.compile(r"server_names:\s*\[([^\]]*)\]")
STREAM_TEMPLATE_NAME = "ai-pin-revival-device-edge.stream.conf.template"
STREAM_EDGE_UPSTREAM = "ai_pin_revival_device_edge"
STREAM_MAP_ENTRY = re.compile(r"^\s*([A-Za-z0-9._*-]+)\s+([A-Za-z0-9_]+)\s*;\s*$")


def envoy_server_names(template: str) -> set[str]:
    """Every SNI Envoy declares a filter chain for."""
    names: set[str] = set()
    for match in SERVER_NAMES_PATTERN.finditer(template):
        for raw in match.group(1).split(","):
            name = raw.strip().strip('"').strip("'")
            if name:
                names.add(name)
    if not names:
        raise SystemExit("Envoy template declares no filter chain server names")
    return names


def stream_edge_server_names(path: Path) -> set[str]:
    """Every SNI the public :443 stream hands to the mTLS edge."""
    body = path.read_text(encoding="utf-8")
    names: set[str] = set()
    inside = False
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("map $ssl_preread_server_name"):
            inside = True
            continue
        if inside:
            if stripped == "}":
                break
            entry = STREAM_MAP_ENTRY.match(line)
            if entry and entry.group(1) != "default" and entry.group(2) == STREAM_EDGE_UPSTREAM:
                names.add(entry.group(1))
    if not inside:
        raise SystemExit(f"device edge stream template has no SNI map: {path}")
    return names


def assert_edge_reachable(template: str, envoy_template_path: Path) -> None:
    """Refuse to render an edge the public :443 stream does not route to it.

    The device dials every clone gateway at <host>:443 and nothing on the server
    answers for a name that has no route: the ClientHello dies before a request
    line exists, so neither Nginx nor Envoy nor Cosmos writes a single line about
    it.  That is precisely how api.carry.humane.cloud went unserved indefinitely.
    The two lists are edited in different files by different concerns, so bind
    them here, at the one moment both are on disk and neither is live yet.
    """
    stream_template = envoy_template_path.parent.parent / "nginx" / STREAM_TEMPLATE_NAME
    if not stream_template.is_file() or stream_template.is_symlink():
        raise SystemExit(f"device edge stream template is missing or unsafe: {stream_template}")
    declared = envoy_server_names(template)
    routed = stream_edge_server_names(stream_template)
    if declared != routed:
        unrouted = ", ".join(sorted(declared - routed)) or "-"
        unserved = ", ".join(sorted(routed - declared)) or "-"
        raise SystemExit(
            "public :443 SNI routing and the Envoy filter chains disagree; "
            f"Envoy serves but :443 does not route: {unrouted}; "
            f":443 routes but Envoy does not serve: {unserved}"
        )


def env_value(path: Path, key: str) -> str:
    value = ""
    for line in path.read_text(encoding="utf-8").splitlines():
        name, separator, candidate = line.partition("=")
        if separator and name.strip() == key:
            value = candidate.strip().strip('"')
    if not TOKEN_PATTERN.fullmatch(value):
        raise SystemExit(f"{key} is missing or invalid in the protected environment")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", type=Path, default=Path(__file__).with_name("envoy") / "envoy.yaml.tpl")
    parser.add_argument("--env", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cert-dir", default="/etc/carry-edge/certs")
    args = parser.parse_args()
    if not args.cert_dir.startswith("/") or any(char in args.cert_dir for char in "\n\r\t\"'"):
        raise SystemExit("certificate directory must be a safe absolute container path")
    token = env_value(args.env, "CARRY_EDGE_TOKEN")
    template = args.template.read_text(encoding="utf-8")
    if template.count("@@EDGE_TOKEN@@") != 2 or "@@CERT_DIR@@" not in template:
        raise SystemExit("unexpected Envoy template placeholders")
    if template.count("access_log:") != 3:
        raise SystemExit(
            "Envoy template must keep one listener access log and one per "
            "http_connection_manager; a silent edge is not deployable"
        )
    assert_edge_reachable(template, args.template)
    rendered = template.replace("@@EDGE_TOKEN@@", token).replace("@@CERT_DIR@@", args.cert_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".envoy.", dir=args.output.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, args.output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("rendered protected Envoy configuration")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
