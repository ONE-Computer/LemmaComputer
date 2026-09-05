#!/usr/bin/env python3
"""Build, validate, preview, publish, and manage LemmaComputer static sites."""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import re
import secrets
import socketserver
import sys
import tempfile
import urllib.error
import urllib.request
import webbrowser
import zipfile
from pathlib import Path

MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
MAX_EXTRACTED_BYTES = 50 * 1024 * 1024
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_FILES = 500
ALLOWED_EXTENSIONS = {".avif", ".css", ".csv", ".gif", ".html", ".ico", ".jpeg", ".jpg", ".js", ".json", ".mjs", ".otf", ".png", ".svg", ".ttf", ".webp", ".woff", ".woff2"}
TEXT_EXTENSIONS = {".css", ".csv", ".html", ".js", ".json", ".mjs", ".svg"}
MEDIA_TYPES = {
    ".avif": "image/avif", ".css": "text/css; charset=utf-8", ".csv": "text/csv; charset=utf-8",
    ".gif": "image/gif", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon",
    ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".otf": "font/otf",
    ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".webp": "image/webp",
    ".woff": "font/woff", ".woff2": "font/woff2",
}
FORBIDDEN_NAME = re.compile(r"^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$", re.I)
SECRET_CONTENT = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*[\"'][^\"'\r\n]{8,}[\"']", re.I)
REMOTE_HTML = re.compile(r"<(?:script|link|img|source|video|audio|iframe)\b[^>]*(?:src|href)\s*=\s*[\"'](?:https?:)?//", re.I)
REMOTE_CSS = re.compile(r"(?:@import\s+(?:url\()?\s*[\"']?(?:https?:)?//|url\(\s*[\"']?(?:https?:)?//)", re.I)
OUTBOUND_JS = re.compile(r"(?:new\s+(?:WebSocket|EventSource)\s*\(|XMLHttpRequest\s*\(|navigator\.sendBeacon\s*\()", re.I)
FETCH_CALL = re.compile(r"\bfetch\s*\(", re.I)
LOCAL_SNAPSHOT_FETCH = re.compile(r"\bfetch\s*\(\s*([\"'])(\./[^\"'\\]*)\1", re.I)
DIRECT_DATABASE = re.compile(r"(?:postgres(?:ql)?://|mysql://|mongodb(?:\+srv)?://)", re.I)


class DefinitiveRequestError(Exception):
    """Control returned a response, so a new attempt may use a new key."""


class UncertainRequestError(Exception):
    """Transport failed without proving whether Control committed the request."""


def broker_url() -> str:
    value = (os.environ.get("LEMMACOMPUTER_SITES_BROKER") or os.environ.get("LEMMACOMPUTER_CONNECTORS_BROKER") or "").rstrip("/")
    if value not in {f"http://127.0.0.1:{port}" for port in (4312, 4314, 4315, 4316, 4317)}:
        raise SystemExit("LemmaComputer Sites is unavailable for this agent")
    return value


def normalized_dist(raw: str) -> Path:
    dist = Path(raw).expanduser().resolve()
    if not dist.is_dir():
        raise SystemExit("Site validation failed: --dist must identify a directory")
    return dist


def validate_path(path: str) -> None:
    parts = path.split("/")
    name = parts[-1]
    if not path or path.startswith("/") or "\\" in path or any(not part or part in {".", ".."} or part.startswith(".") for part in parts):
        raise SystemExit(f"Site validation failed: forbidden path {path}")
    if any(part.lower() in {"__macosx", "node_modules"} for part in parts) or FORBIDDEN_NAME.fullmatch(name) or name.lower().endswith(".map"):
        raise SystemExit(f"Site validation failed: forbidden path {path}")
    if Path(name).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise SystemExit(f"Site validation failed: unsupported file type {path}")


def validate_text(path: str, content: bytes) -> None:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        raise SystemExit(f"Site validation failed: invalid UTF-8 in {path}") from None
    if "\0" in text or SECRET_CONTENT.search(text) or DIRECT_DATABASE.search(text):
        raise SystemExit(f"Site validation failed: credentials or database configuration in {path}")
    extension = Path(path).suffix.lower()
    if extension == ".html" and (not re.search(r"<html(?:\s|>)", text, re.I) or REMOTE_HTML.search(text) or re.search(r"<base\b", text, re.I)):
        raise SystemExit(f"Site validation failed: invalid or remote HTML resource in {path}")
    if extension in {".css", ".svg"} and REMOTE_CSS.search(text):
        raise SystemExit(f"Site validation failed: remote resource in {path}")
    if extension in {".js", ".mjs"}:
        fetched_paths = [match.group(2) for match in LOCAL_SNAPSHOT_FETCH.finditer(text)]
        if OUTBOUND_JS.search(text) or len(FETCH_CALL.findall(text)) != len(fetched_paths) or any(".." in value.split("/") for value in fetched_paths):
            raise SystemExit(f"Site validation failed: only packaged ./ snapshot files may be loaded in {path}")
    if extension == ".json":
        try:
            json.loads(text)
        except ValueError:
            raise SystemExit(f"Site validation failed: invalid JSON in {path}") from None


def collect(dist: Path) -> list[tuple[str, bytes]]:
    if any(path.is_symlink() for path in dist.rglob("*")):
        raise SystemExit("Site validation failed: symbolic links are not allowed")
    files: list[tuple[str, bytes]] = []
    total = 0
    for source in sorted((path for path in dist.rglob("*") if path.is_file()), key=lambda path: path.relative_to(dist).as_posix()):
        relative = source.relative_to(dist).as_posix()
        validate_path(relative)
        content = source.read_bytes()
        if len(content) > MAX_FILE_BYTES:
            raise SystemExit(f"Site validation failed: file exceeds 10 MB: {relative}")
        total += len(content)
        if total > MAX_EXTRACTED_BYTES:
            raise SystemExit("Site validation failed: extracted site exceeds 50 MB")
        if Path(relative).suffix.lower() in TEXT_EXTENSIONS:
            validate_text(relative, content)
        files.append((relative, content))
    if not files or len(files) > MAX_FILES or not any(path == "index.html" for path, _ in files):
        raise SystemExit("Site validation failed: root index.html is required and at most 500 files are allowed")
    return files


def bundle(dist: Path) -> tuple[bytes, dict, str]:
    files = collect(dist)
    with tempfile.SpooledTemporaryFile(max_size=MAX_ARCHIVE_BYTES) as target:
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=True) as archive:
            for path, content in files:
                info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        size = target.tell()
        if size <= 0 or size > MAX_ARCHIVE_BYTES:
            raise SystemExit("Site validation failed: compressed site exceeds 20 MB")
        target.seek(0)
        archive_bytes = target.read()
    manifest = {"schemaVersion": 1, "files": [
        {"path": path, "mediaType": MEDIA_TYPES[Path(path).suffix.lower()], "sizeBytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        for path, content in files
    ]}
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return archive_bytes, manifest, hashlib.sha256(manifest_bytes).hexdigest()


def request_json(path: str, body: dict | None = None) -> dict:
    encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(f"{broker_url()}{path}", data=encoded, method="GET" if body is None else "POST", headers={} if encoded is None else {"content-type": "application/json", "content-length": str(len(encoded))})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.load(error)
            detail = payload.get("error", "Sites request failed")
            message = detail.get("message", detail.get("code")) if isinstance(detail, dict) else detail
        except (ValueError, AttributeError):
            message = "Sites request failed"
        failure = UncertainRequestError if error.code == 429 or error.code >= 500 else DefinitiveRequestError
        raise failure(str(message)[:240]) from None
    except (OSError, urllib.error.URLError) as error:
        raise UncertainRequestError(f"Sites request failed: {str(error)[:180]}") from None
    except ValueError:
        raise DefinitiveRequestError("Sites request failed: invalid response") from None
    if not isinstance(value, dict):
        raise DefinitiveRequestError("Sites request failed: invalid response")
    return value


def binding_path(dist: Path) -> Path:
    return dist.parent / ".lemmacomputer" / "site.json"


def pending_path(dist: Path) -> Path:
    return dist.parent / ".lemmacomputer" / "site-publish-pending.json"


def read_or_create_pending(dist: Path, values: dict) -> dict:
    target = pending_path(dist)
    try:
        current = json.loads(target.read_text(encoding="utf-8")) if target.exists() else None
    except (OSError, ValueError):
        current = None
    if isinstance(current, dict) and current.get("schemaVersion") == 1 and all(current.get(key) == value for key, value in values.items()) and isinstance(current.get("idempotencyKey"), str):
        return current
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    pending = {"schemaVersion": 1, **values, "idempotencyKey": secrets.token_urlsafe(32)}
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(pending, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
    return pending


def remove_pending(dist: Path) -> None:
    try:
        pending_path(dist).unlink()
    except FileNotFoundError:
        pass


def read_binding(dist: Path) -> dict | None:
    path = binding_path(dist)
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise SystemExit("Publishing failed: the project site binding is invalid") from None
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or not isinstance(value.get("siteId"), str):
        raise SystemExit("Publishing failed: the project site binding is invalid")
    return value


def source_project_path(dist: Path) -> str:
    root = Path(os.environ.get("LEMMACOMPUTER_WORKSPACE_ROOT", "/home/kasm-user")).resolve()
    try:
        relative = dist.parent.relative_to(root).as_posix()
    except ValueError:
        raise SystemExit("Publishing failed: the project must be inside the LemmaComputer workspace") from None
    if not relative or relative == ".":
        raise SystemExit("Publishing failed: use a project folder inside the workspace")
    return relative


def write_binding(dist: Path, site: dict) -> None:
    target = binding_path(dist)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    value = {"schemaVersion": 1, "siteId": site["id"], "slug": site["slug"], "stableUrl": site["stableUrl"], "version": site["publishedVersion"]}
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)


def validate_command(arguments: argparse.Namespace) -> int:
    archive, manifest, manifest_sha = bundle(normalized_dist(arguments.dist))
    print(json.dumps({"valid": True, "archiveSizeBytes": len(archive), "archiveSha256": hashlib.sha256(archive).hexdigest(), "manifestSha256": manifest_sha, "fileCount": len(manifest["files"]), "extractedSizeBytes": sum(item["sizeBytes"] for item in manifest["files"])}, separators=(",", ":")))
    return 0


def preview(arguments: argparse.Namespace) -> int:
    dist = normalized_dist(arguments.dist)
    collect(dist)
    def handler(*values, **options):
        return http.server.SimpleHTTPRequestHandler(*values, directory=str(dist), **options)
    with socketserver.TCPServer(("127.0.0.1", arguments.port), handler) as server:
        url = f"http://127.0.0.1:{arguments.port}/"
        print(json.dumps({"preview": True, "url": url}, separators=(",", ":")), flush=True)
        if arguments.open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            return 0
    return 0


def publish(arguments: argparse.Namespace) -> int:
    dist = normalized_dist(arguments.dist)
    archive, _, manifest_sha = bundle(dist)
    binding = read_binding(dist)
    site_id = arguments.site_id or (binding or {}).get("siteId")
    archive_sha = hashlib.sha256(archive).hexdigest()
    project_path = source_project_path(dist)
    pending = read_or_create_pending(dist, {"siteId": site_id, "archiveSha256": archive_sha, "manifestSha256": manifest_sha, "name": arguments.name, "slug": arguments.slug, "sourceProjectPath": project_path})
    body = {"name": arguments.name, "slug": arguments.slug, "bundleBase64": base64.b64encode(archive).decode("ascii"), "archiveSha256": archive_sha, "archiveSizeBytes": len(archive), "manifestSha256": manifest_sha, "idempotencyKey": pending["idempotencyKey"], "sourceProjectPath": project_path}
    if site_id:
        body["siteId"] = site_id
    try:
        site = request_json("/lemmacomputer/sites", body)
    except DefinitiveRequestError:
        remove_pending(dist)
        raise
    if site.get("published") is not True:
        remove_pending(dist)
        raise DefinitiveRequestError("Publishing failed: Control did not confirm publication")
    write_binding(dist, site)
    remove_pending(dist)
    print(json.dumps({"published": True, "siteId": site["id"], "name": site["name"], "slug": site["slug"], "version": site["publishedVersion"], "url": site["stableUrl"]}, separators=(",", ":")))
    return 0


def list_sites(_: argparse.Namespace) -> int:
    print(json.dumps(request_json("/lemmacomputer/sites"), separators=(",", ":")))
    return 0


def inspect_site(arguments: argparse.Namespace) -> int:
    print(json.dumps(request_json(f"/lemmacomputer/sites/{arguments.site_id}"), separators=(",", ":")))
    return 0


def restore(arguments: argparse.Namespace) -> int:
    print(json.dumps(request_json(f"/lemmacomputer/sites/{arguments.site_id}/versions/{arguments.version}/restore", {}), separators=(",", ":")))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="lemmacomputer-sites")
    commands = parser.add_subparsers(dest="command", required=True)
    validate_parser = commands.add_parser("validate", help="Validate and summarize a built static site")
    validate_parser.add_argument("--dist", required=True)
    validate_parser.set_defaults(handler=validate_command)
    preview_parser = commands.add_parser("preview", help="Validate and serve the built site on loopback")
    preview_parser.add_argument("--dist", required=True)
    preview_parser.add_argument("--port", type=int, default=4175)
    preview_parser.add_argument("--open", action="store_true")
    preview_parser.set_defaults(handler=preview)
    publish_parser = commands.add_parser("publish", help="Publish a built static site bundle")
    publish_parser.add_argument("--name", required=True)
    publish_parser.add_argument("--slug", required=True)
    publish_parser.add_argument("--dist", required=True)
    publish_parser.add_argument("--site-id")
    publish_parser.set_defaults(handler=publish)
    list_parser = commands.add_parser("list", help="List sites owned by this workspace user")
    list_parser.set_defaults(handler=list_sites)
    inspect_parser = commands.add_parser("inspect", help="Inspect a site's current published version")
    inspect_parser.add_argument("--site-id", required=True)
    inspect_parser.set_defaults(handler=inspect_site)
    restore_parser = commands.add_parser("restore", help="Restore an immutable site version")
    restore_parser.add_argument("--site-id", required=True)
    restore_parser.add_argument("--version", required=True, type=int)
    restore_parser.set_defaults(handler=restore)
    arguments = parser.parse_args()
    if getattr(arguments, "port", 4175) not in range(1024, 65536):
        raise SystemExit("Preview port must be between 1024 and 65535")
    try:
        return arguments.handler(arguments)
    except (DefinitiveRequestError, UncertainRequestError) as error:
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    sys.exit(main())
