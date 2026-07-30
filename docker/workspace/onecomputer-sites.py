#!/usr/bin/env python3
"""Publish a bounded static site through the workspace-local ONEComputer broker."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def broker_url() -> str:
    value = (
        os.environ.get("ONECOMPUTER_SITES_BROKER")
        or os.environ.get("ONECOMPUTER_CONNECTORS_BROKER")
        or ""
    ).rstrip("/")
    if value not in {
        "http://127.0.0.1:4312",
        "http://127.0.0.1:4314",
        "http://127.0.0.1:4315",
        "http://127.0.0.1:4316",
        "http://127.0.0.1:4317",
    }:
        raise SystemExit("ONEComputer Sites is unavailable for this agent")
    return value


def publish(arguments: argparse.Namespace) -> int:
    dist = Path(arguments.dist).expanduser().resolve()
    if not dist.is_dir():
        raise SystemExit("Publishing failed: --dist must identify a directory")
    files = sorted(path.relative_to(dist).as_posix() for path in dist.rglob("*") if path.is_file())
    if files != ["index.html"] or any(path.is_symlink() for path in dist.rglob("*")):
        raise SystemExit("Publishing failed: the demo publisher accepts only dist/index.html and no symbolic links")
    content = (dist / "index.html").read_bytes()
    if not content or len(content) > 512 * 1024:
        raise SystemExit("Publishing failed: dist/index.html must be between 1 byte and 512 KB")
    body = json.dumps({
        "name": arguments.name,
        "slug": arguments.slug,
        "htmlBase64": base64.b64encode(content).decode("ascii"),
        "artifactSha256": hashlib.sha256(content).hexdigest(),
    }, separators=(",", ":")).encode()
    request = urllib.request.Request(
        f"{broker_url()}/onecomputer/sites",
        data=body,
        method="POST",
        headers={"content-type": "application/json", "content-length": str(len(body))},
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            site = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.load(error)
            message = payload.get("error", "Publishing failed")
        except (ValueError, AttributeError):
            message = "Publishing failed"
        raise SystemExit(str(message)[:240]) from None
    except (OSError, urllib.error.URLError, ValueError) as error:
        raise SystemExit(f"Publishing failed: {str(error)[:180]}") from None
    print(json.dumps({
        "published": True,
        "siteId": site["id"],
        "name": site["name"],
        "slug": site["slug"],
        "revision": site["currentRevision"],
        "open": "Open ONEComputer and choose Sites",
    }, separators=(",", ":")))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="onecomputer-sites")
    commands = parser.add_subparsers(dest="command", required=True)
    publish_parser = commands.add_parser("publish", help="Publish a built single-file Vite site")
    publish_parser.add_argument("--name", required=True)
    publish_parser.add_argument("--slug", required=True)
    publish_parser.add_argument("--dist", required=True)
    arguments = parser.parse_args()
    return publish(arguments)


if __name__ == "__main__":
    sys.exit(main())
