#!/usr/bin/env python3
"""Loopback-only broker for a workspace-scoped LiteLLM credential."""

from __future__ import annotations

import base64
import binascii
import hashlib
import http.client
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlsplit

UPSTREAM = urlsplit(os.environ["LEMMACOMPUTER_GATEWAY_UPSTREAM"])
CREDENTIAL = os.environ["LEMMACOMPUTER_GATEWAY_CREDENTIAL"]
MODEL_ALIAS = os.environ.get("LEMMACOMPUTER_TRANSPORT_MODEL_ALIAS", os.environ["LEMMACOMPUTER_MODEL_ALIAS"])
DEFAULT_SERVICE_CLASS = os.environ.get("LEMMACOMPUTER_REQUESTED_SERVICE_CLASS", "auto")
CONTROL = urlsplit(os.environ["LEMMACOMPUTER_CONTROL_UPSTREAM"])
AGENT_BRIDGE_TOKEN = os.environ["LEMMACOMPUTER_AGENT_BRIDGE_TOKEN"]
LISTEN_PORT = int(os.environ.get("LEMMACOMPUTER_GATEWAY_LISTEN_PORT", "4312"))
INFERENCE_PATHS = {"/v1/messages", "/v1/messages/count_tokens", "/v1/chat/completions", "/v1/responses"}
ALLOWED_PATHS = INFERENCE_PATHS | {"/v1/models", "/mcp-rest/tools/list", "/mcp-rest/tools/call"}
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}
MODEL_ALIAS_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
TASK_BINDING_PATTERN = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
AGENT_BRIDGE_TOKEN_PATTERN = re.compile(r"^ocab2_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$")
MCP_SERVER_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
TERMINAL_AGENT_BRIDGE_CODES = {"AGENT_BRIDGE_GRANT_REVOKED", "AGENT_BRIDGE_GRANT_EXPIRED"}
MCP_DISCOVERY_TIMEOUT_SECONDS = 5
MAX_INFERENCE_BODY_BYTES = 64 * 1024 * 1024
LOCAL_UPLOAD_ROOT = os.path.realpath("/home/kasm-user")
UPLOAD_CHUNK_BYTES = 10 * 1024 * 1024
UPLOAD_JOBS: dict[str, dict] = {}
UPLOAD_KEYS: dict[tuple, str] = {}
UPLOAD_LOCK = threading.Lock()
AGENT_BRIDGE_LOCK = threading.RLock()
AGENT_BRIDGE_TERMINAL_CODE: str | None = None


class AgentBridgeTerminalError(RuntimeError):
    pass

if (UPSTREAM.scheme not in {"http", "https"} or not UPSTREAM.hostname or len(CREDENTIAL) < 24
        or CONTROL.scheme not in {"http", "https"} or not CONTROL.hostname or not AGENT_BRIDGE_TOKEN_PATTERN.fullmatch(AGENT_BRIDGE_TOKEN)
        or not MODEL_ALIAS_PATTERN.fullmatch(MODEL_ALIAS) or DEFAULT_SERVICE_CLASS not in {"auto", "lite", "balanced", "pro"}
        or LISTEN_PORT not in {4312, 4314, 4315, 4316, 4317}):
    raise SystemExit("invalid gateway broker configuration")


def agent_bridge_terminal_code() -> str | None:
    with AGENT_BRIDGE_LOCK:
        return AGENT_BRIDGE_TERMINAL_CODE


def mark_agent_bridge_terminal(code: str) -> None:
    global AGENT_BRIDGE_TERMINAL_CODE
    with AGENT_BRIDGE_LOCK:
        AGENT_BRIDGE_TERMINAL_CODE = code


def control_http_error_code(error: urllib.error.HTTPError) -> str | None:
    try:
        payload = json.loads(error.read(16 * 1024))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    detail = payload.get("error")
    return detail.get("code") if isinstance(detail, dict) and isinstance(detail.get("code"), str) else None


def recognize_terminal_control_error(error: urllib.error.HTTPError) -> None:
    code = control_http_error_code(error)
    if code in TERMINAL_AGENT_BRIDGE_CODES:
        mark_agent_bridge_terminal(code)
        raise AgentBridgeTerminalError(
            "Workspace authorization expired or changed. Restart this workspace to restore governed actions."
        ) from None


def bridge_token_expiry(token: str) -> int | None:
    match = AGENT_BRIDGE_TOKEN_PATTERN.fullmatch(token)
    if not match:
        return None
    try:
        encoded = match.group(1)
        padding = "=" * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(encoded + padding))
        expires_at = payload.get("exp")
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError, binascii.Error):
        return None
    return expires_at if isinstance(expires_at, int) and expires_at > 0 else None


def agent_bridge_token() -> str:
    """Renew shortly before expiry without ever widening the injected grant's scopes."""
    global AGENT_BRIDGE_TOKEN
    with AGENT_BRIDGE_LOCK:
        if AGENT_BRIDGE_TERMINAL_CODE is not None:
            raise AgentBridgeTerminalError(
                "Workspace authorization expired or changed. Restart this workspace to restore governed actions."
            )
        expires_at = bridge_token_expiry(AGENT_BRIDGE_TOKEN)
        if expires_at is not None and expires_at > int(time.time()) + 60:
            return AGENT_BRIDGE_TOKEN
        target = CONTROL._replace(
            path=f"{CONTROL.path.rstrip('/')}/internal/v1/agent/grants/renew",
            query="",
            fragment="",
        ).geturl()
        request = urllib.request.Request(target, data=b"{}", method="POST", headers={
            "authorization": f"Bearer {AGENT_BRIDGE_TOKEN}",
            "content-type": "application/json",
        })
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                document = json.loads(response.read())
        except urllib.error.HTTPError as error:
            recognize_terminal_control_error(error)
            raise
        renewed = document.get("token") if isinstance(document, dict) else None
        if not isinstance(renewed, str) or not AGENT_BRIDGE_TOKEN_PATTERN.fullmatch(renewed):
            raise ValueError("invalid renewed agent bridge grant")
        AGENT_BRIDGE_TOKEN = renewed
        return AGENT_BRIDGE_TOKEN


def maintain_agent_bridge_token() -> None:
    """Keep an active workspace grant fresh even when the agent is idle."""
    while True:
        expires_at = bridge_token_expiry(AGENT_BRIDGE_TOKEN)
        now = int(time.time())
        if expires_at is not None and expires_at > now + 60:
            time.sleep(min(30, max(1, expires_at - now - 60)))
            continue
        try:
            agent_bridge_token()
        except AgentBridgeTerminalError as error:
            print(f"gateway-broker: terminal agent bridge failure: {error}", file=sys.stderr, flush=True)
            return
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as error:
            print(f"gateway-broker: agent bridge renewal failed: {str(error)[:160]}", file=sys.stderr, flush=True)
        time.sleep(15)


def task_service_class(task_binding: str) -> str:
    try:
        encoded = task_binding.split(".", 1)[0]
        padding = "=" * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(encoded + padding))
        requested = payload.get("requestedServiceClass", "auto")
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError, binascii.Error):
        raise ValueError("invalid AI task binding payload") from None
    if requested not in {"auto", "lite", "balanced", "pro"}:
        raise ValueError("invalid AI task binding service class")
    return requested


def issue_task_binding() -> str:
    payload = json.dumps({"requestedServiceClass": DEFAULT_SERVICE_CLASS, "taskId": f"workspace-native:{uuid.uuid4()}"}, separators=(",", ":")).encode()
    control_path = CONTROL.path.rstrip("/")
    path = f"{control_path}/internal/v1/agent/usage-bindings"
    target = CONTROL._replace(path=path, query="", fragment="").geturl()
    request = urllib.request.Request(target, data=payload, method="POST", headers={
        "authorization": f"Bearer {agent_bridge_token()}",
        "content-type": "application/json",
    })
    with urllib.request.urlopen(request, timeout=10) as response:
        document = json.loads(response.read())
    binding = document.get("binding") if isinstance(document, dict) else None
    if not isinstance(binding, str) or not TASK_BINDING_PATTERN.fullmatch(binding):
        raise ValueError("invalid issued AI task binding")
    return binding


def normalize_inference_body(body: bytes, task_binding: str | None = None) -> tuple[bytes, str]:
    request = json.loads(body)
    if not isinstance(request, dict):
        raise ValueError("inference request must be an object")
    requested_model = request.get("model")
    if not isinstance(requested_model, str) or not requested_model.strip():
        raise ValueError("inference model is required")
    internal_request = {
        "user_api_key_dict", "user_api_key_metadata", "model_info",
        "litellm_model_info", "litellm_params", "previous_models",
    }
    for name in list(request):
        if name in internal_request or (
            isinstance(name, str) and name.startswith("lemmacomputer_")
        ):
            request.pop(name, None)
    metadata = request.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    internal_metadata = {
        "user_api_key_metadata", "model_info", "requester_metadata",
        "user_api_key", "headers", "endpoint", "deployment",
    }
    metadata = {
        name: value for name, value in metadata.items()
        if name not in internal_metadata
        and not (isinstance(name, str) and name.startswith("lemmacomputer_"))
    }
    if task_binding is not None:
        metadata["lemmacomputer_task_binding"] = task_binding
        metadata["lemmacomputer_requested_service_class"] = task_service_class(task_binding)
    request["metadata"] = metadata
    request["model"] = MODEL_ALIAS
    return json.dumps(request, separators=(",", ":")).encode(), requested_model


def control_json_request(path: str, body: dict | None = None) -> dict:
    headers = {"authorization": f"Bearer {agent_bridge_token()}"}
    encoded = None
    if body is not None:
        encoded = json.dumps(body, separators=(",", ":")).encode()
        headers["content-type"] = "application/json"
    request = urllib.request.Request(
        f"{CONTROL.scheme}://{CONTROL.hostname}:{CONTROL.port}{CONTROL.path.rstrip('/')}{path}",
        data=encoded,
        method="GET" if body is None else "POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=70) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        recognize_terminal_control_error(error)
        raise
    if not isinstance(value, dict):
        raise ValueError("invalid Control response")
    return value


def mcp_discovery_plan() -> tuple[list[str], str]:
    plan = control_json_request("/internal/v1/agent/mcp-discovery-plan")
    raw_servers = plan.get("servers")
    if not isinstance(raw_servers, list) or len(raw_servers) > 32:
        raise ValueError("Control returned an invalid MCP discovery plan")
    servers: list[str] = []
    for raw in raw_servers:
        if not isinstance(raw, str) or not MCP_SERVER_NAME_PATTERN.fullmatch(raw):
            raise ValueError("Control returned an invalid MCP server name")
        if raw not in servers:
            servers.append(raw)
    projection_hash = plan.get("projectionHash")
    if not isinstance(projection_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", projection_hash):
        projection_hash = hashlib.sha256(
            json.dumps(servers, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
    return servers, projection_hash


def mcp_discovery_servers() -> list[str]:
    return mcp_discovery_plan()[0]


def discover_mcp_server(server_name: str) -> tuple[str, list[dict] | None, str | None]:
    target = UPSTREAM._replace(
        path=f"{UPSTREAM.path.rstrip('/')}/mcp-rest/tools/list",
        query=urlencode({"mcp_server_name": server_name}),
        fragment="",
    ).geturl()
    request = urllib.request.Request(target, method="GET", headers={
        "authorization": f"Bearer {CREDENTIAL}",
        "accept": "application/json",
    })
    try:
        # This endpoint feeds an MCP stdio handshake. A disconnected or slow
        # connector must fail within that caller's startup budget so another
        # healthy connector (or the valid empty tool surface) can still load.
        with urllib.request.urlopen(request, timeout=MCP_DISCOVERY_TIMEOUT_SECONDS) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        error.read()
        return server_name, None, f"http_{error.code}"
    except (OSError, ValueError, urllib.error.URLError):
        return server_name, None, "unavailable"
    if not isinstance(payload, dict):
        return server_name, None, "invalid_response"
    upstream_error = payload.get("error")
    if isinstance(upstream_error, str) and upstream_error:
        return server_name, None, "upstream_error"
    tools = payload.get("tools")
    if not isinstance(tools, list) or not all(isinstance(tool, dict) for tool in tools):
        return server_name, None, "invalid_tool_list"
    return server_name, tools, None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, message: str, *args: object) -> None:
        print(f"gateway-broker: {message % args}", file=sys.stderr, flush=True)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            terminal_code = agent_bridge_terminal_code()
            self.send_json(
                503 if terminal_code else 200,
                {"status": "failed", "code": terminal_code} if terminal_code else {"status": "ready"},
            )
            return
        if self.path.split("?", 1)[0] == "/mcp-rest/tools/list":
            self.discover_mcp_tools()
            return
        if self.path.split("?", 1)[0] == "/mcp-rest/tools/signature":
            self.mcp_tool_signature()
            return
        self.forward()

    def do_POST(self) -> None:
        if self.path == "/lemmacomputer/uploads":
            self.create_local_upload()
            return
        if self.path == "/lemmacomputer/uploads/start":
            self.start_local_upload()
            return
        if self.path == "/lemmacomputer/deletions":
            self.create_onedrive_deletion()
            return
        if self.path == "/lemmacomputer/sites":
            self.publish_site()
            return
        self.forward()

    def read_json(self, max_bytes: int = 16 * 1024) -> dict:
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > max_bytes:
            raise ValueError("invalid request body")
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError("invalid request body")
        return value

    def send_json(self, status: int, value: dict) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.send_header("connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The MCP client can cancel discovery when its own startup budget
            # expires. That is a closed request, not a broker failure worth a
            # second response or an unhandled server-thread traceback.
            pass
        self.close_connection = True

    def control_json(self, path: str, body: dict | None = None) -> dict:
        return control_json_request(path, body)

    def discover_mcp_tools(self) -> None:
        try:
            servers = mcp_discovery_servers()
            if not servers:
                self.send_json(200, {"tools": [], "error": None, "message": "No connected MCP servers"})
                return
            with ThreadPoolExecutor(max_workers=min(8, len(servers))) as executor:
                results = list(executor.map(discover_mcp_server, servers))
            tools: list[dict] = []
            failures: list[dict[str, str]] = []
            for server_name, discovered, error_code in results:
                if discovered is None:
                    failures.append({"serverName": server_name, "code": error_code or "discovery_failed"})
                    self.log_message("MCP discovery failed server=%s code=%s", server_name, error_code or "discovery_failed")
                    continue
                tools.extend(discovered)
            self.send_json(200, {
                "tools": tools,
                "error": "partial_failure" if failures else None,
                "message": "Some connectors are unavailable" if failures else "Successfully retrieved tools",
                "failedServers": failures,
            })
        except AgentBridgeTerminalError as error:
            self.send_json(503, {"error": "workspace_authorization_changed", "message": str(error)})
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError):
            self.send_json(502, {"error": "connector_discovery_unavailable", "message": "Connector discovery is temporarily unavailable"})

    def mcp_tool_signature(self) -> None:
        """Return Control's durable connector projection without probing providers."""
        try:
            servers, signature = mcp_discovery_plan()
            self.send_json(200, {"signature": signature, "servers": servers})
        except AgentBridgeTerminalError as error:
            self.send_json(503, {"error": "workspace_authorization_changed", "message": str(error)})
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError):
            self.send_json(502, {"error": "connector_projection_unavailable", "message": "Connector projection is temporarily unavailable"})

    def create_local_upload(self) -> None:
        try:
            value = self.read_json()
            path = value.get("localFilePath")
            drive_id = value.get("driveId")
            drive_item_id = value.get("driveItemId")
            if not all(isinstance(item, str) and item for item in (path, drive_id, drive_item_id)):
                raise ValueError("localFilePath, driveId, and driveItemId are required")
            resolved = os.path.realpath(path)
            if os.path.commonpath([LOCAL_UPLOAD_ROOT, resolved]) != LOCAL_UPLOAD_ROOT or not os.path.isfile(resolved):
                raise ValueError("localFilePath must identify a regular workspace file")
            stat = os.stat(resolved)
            if stat.st_size <= 0:
                raise ValueError("localFilePath must not be empty")
            key = (resolved, stat.st_size, stat.st_mtime_ns, drive_id, drive_item_id)
            with UPLOAD_LOCK:
                existing_id = UPLOAD_KEYS.get(key)
                existing = UPLOAD_JOBS.get(existing_id or "")
            if existing:
                operation = self.control_json(f"/internal/v1/agent/operations/{existing['operationId']}")
                self.send_json(200, {"operation": operation})
                return
            digest = hashlib.sha256()
            with open(resolved, "rb") as source:
                while chunk := source.read(UPLOAD_CHUNK_BYTES):
                    digest.update(chunk)
            request_id = f"workspace-upload-{uuid.uuid4().hex}"
            operation = self.control_json("/internal/v1/agent/uploads", {
                "driveId": drive_id,
                "driveItemId": drive_item_id,
                "fileName": os.path.basename(resolved),
                "size": stat.st_size,
                "sha256": digest.hexdigest(),
                "idempotencyKey": request_id,
            })
            job = {
                "operationId": operation["id"],
                "path": resolved,
                "size": stat.st_size,
                "mtimeNs": stat.st_mtime_ns,
                "sha256": digest.hexdigest(),
                "running": False,
            }
            with UPLOAD_LOCK:
                UPLOAD_KEYS[key] = operation["id"]
                UPLOAD_JOBS[operation["id"]] = job
            self.send_json(201, {"operation": operation})
        except AgentBridgeTerminalError as error:
            self.send_json(503, {"error": "workspace_authorization_changed", "message": str(error)})
        except (OSError, ValueError, KeyError, json.JSONDecodeError, urllib.error.URLError) as error:
            self.send_json(400, {"error": str(error)[:240]})

    def publish_site(self) -> None:
        try:
            value = self.read_json(800 * 1024)
            name = value.get("name")
            slug = value.get("slug")
            html_base64 = value.get("htmlBase64")
            artifact_sha256 = value.get("artifactSha256")
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
                raise ValueError("name must contain 1 to 80 characters")
            if not isinstance(slug, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug) or not 2 <= len(slug) <= 80:
                raise ValueError("slug must be 2 to 80 lowercase hyphenated characters")
            if not isinstance(html_base64, str) or len(html_base64) > 750_000:
                raise ValueError("htmlBase64 is required")
            if not isinstance(artifact_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", artifact_sha256):
                raise ValueError("artifactSha256 is required")
            try:
                content = base64.b64decode(html_base64, validate=True)
            except (ValueError, base64.binascii.Error):
                raise ValueError("htmlBase64 is invalid") from None
            if not content or len(content) > 512 * 1024:
                raise ValueError("site artifact must be between 1 byte and 512 KB")
            if hashlib.sha256(content).hexdigest() != artifact_sha256:
                raise ValueError("site artifact digest does not match")
            site = self.control_json("/internal/v1/agent/sites", {
                "name": name.strip(),
                "slug": slug,
                "htmlBase64": html_base64,
                "artifactSha256": artifact_sha256,
            })
            self.send_json(201, site)
        except AgentBridgeTerminalError as error:
            self.send_json(503, {"error": "workspace_authorization_changed", "message": str(error)})
        except (OSError, ValueError, KeyError, json.JSONDecodeError, urllib.error.URLError) as error:
            self.send_json(400, {"error": str(error)[:240]})

    def create_onedrive_deletion(self) -> None:
        try:
            value = self.read_json()
            drive_id = value.get("driveId")
            drive_item_id = value.get("driveItemId")
            resource_name = value.get("resourceName")
            etag = value.get("If-Match")
            if not all(isinstance(item, str) and item.strip() for item in (
                drive_id, drive_item_id, resource_name, etag
            )):
                raise ValueError("driveId, driveItemId, resourceName, and If-Match are required")
            fingerprint = hashlib.sha256(json.dumps({
                "driveId": drive_id,
                "driveItemId": drive_item_id,
                "resourceName": resource_name.strip(),
                "If-Match": etag,
            }, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            operation = self.control_json("/internal/v1/agent/deletions", {
                "driveId": drive_id,
                "driveItemId": drive_item_id,
                "resourceName": resource_name.strip(),
                "If-Match": etag,
                "idempotencyKey": f"workspace-delete-{fingerprint}",
            })
            self.send_json(201, {"operation": operation})
        except AgentBridgeTerminalError as error:
            self.send_json(503, {"error": "workspace_authorization_changed", "message": str(error)})
        except (OSError, ValueError, KeyError, json.JSONDecodeError, urllib.error.URLError) as error:
            self.send_json(400, {"error": str(error)[:240]})

    def start_local_upload(self) -> None:
        job = None
        try:
            value = self.read_json()
            operation_id = value.get("operationId")
            if not isinstance(operation_id, str):
                raise ValueError("operationId is required")
            with UPLOAD_LOCK:
                job = UPLOAD_JOBS.get(operation_id)
                if not job:
                    raise ValueError("the local upload is not available in this workspace")
                if job["running"]:
                    self.send_json(200, {"state": "executing"})
                    return
                job["running"] = True
            started = self.control_json(f"/internal/v1/agent/uploads/{operation_id}/begin", {})
            job["leaseId"] = started["leaseId"]
            job["uploadUrl"] = started["uploadUrl"]
            threading.Thread(target=run_upload, args=(job,), daemon=True).start()
            self.send_json(202, {"state": "executing"})
        except AgentBridgeTerminalError as error:
            if job is not None and "leaseId" not in job:
                with UPLOAD_LOCK:
                    job["running"] = False
            self.send_json(503, {"error": "workspace_authorization_changed", "message": str(error)})
        except (OSError, ValueError, KeyError, json.JSONDecodeError, urllib.error.URLError) as error:
            if job is not None and "leaseId" not in job:
                with UPLOAD_LOCK:
                    job["running"] = False
            self.send_json(409, {"error": str(error)[:240]})

    def forward(self) -> None:
        path = self.path.split("?", 1)[0]
        operation_prefix = "/lemmacomputer/operations/"
        is_operation = path.startswith(operation_prefix) and len(path) > len(operation_prefix)
        if path not in ALLOWED_PATHS and not is_operation:
            self.send_error(403, "gateway path is not assigned")
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.send_json(400, {"error": "invalid content length"})
            return
        if length < 0:
            self.send_json(400, {"error": "invalid content length"})
            return
        if path in INFERENCE_PATHS and (length <= 0 or length > MAX_INFERENCE_BODY_BYTES):
            self.send_json(413, {"error": "invalid inference request body size"})
            return
        body = self.rfile.read(length) if length else None
        if path in INFERENCE_PATHS:
            if self.command != "POST":
                self.send_json(405, {"error": "inference requests must use POST"})
                return
            if self.headers.get("content-encoding", "identity").lower() not in {"", "identity"}:
                self.send_json(415, {"error": "encoded inference request bodies are not supported"})
                return
            try:
                task_binding = self.headers.get("x-lemmacomputer-ai-task-binding")
                if task_binding is None and MODEL_ALIAS == "lemmacomputer-auto":
                    task_binding = issue_task_binding()
                if task_binding is not None and (
                    not 32 <= len(task_binding) <= 4096
                    or not TASK_BINDING_PATTERN.fullmatch(task_binding)
                ):
                    raise ValueError("invalid AI task binding")
                body, requested_model = normalize_inference_body(body, task_binding)
                if requested_model != MODEL_ALIAS:
                    logged_model = requested_model if MODEL_ALIAS_PATTERN.fullmatch(requested_model) else "<nonstandard>"
                    self.log_message(
                        'normalized model "%s" to assigned route "%s"',
                        logged_model,
                        MODEL_ALIAS,
                    )
            except (json.JSONDecodeError, ValueError, urllib.error.URLError) as error:
                self.send_json(400, {"error": str(error)})
                return
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in HOP_BY_HOP | {
                "host", "authorization", "x-api-key", "content-length",
                "x-lemmacomputer-ai-task-binding", "x-litellm-call-id",
            }
        }
        target = CONTROL if is_operation else UPSTREAM
        try:
            headers["authorization"] = f"Bearer {agent_bridge_token() if is_operation else CREDENTIAL}"
        except AgentBridgeTerminalError as error:
            self.send_json(503, {"error": "workspace_authorization_changed", "message": str(error)})
            return
        if body is not None:
            headers["content-length"] = str(len(body))
        connection_class = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        connection = connection_class(target.hostname, target.port, timeout=65)
        try:
            upstream_path = (f"{target.path.rstrip('/')}/internal/v1/agent/operations/{path.removeprefix(operation_prefix)}"
                             if is_operation else f"{target.path.rstrip('/')}{self.path}")
            connection.request(self.command, upstream_path, body=body, headers=headers)
            response = connection.getresponse()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP_BY_HOP:
                    self.send_header(key, value)
            self.send_header("connection", "close")
            self.end_headers()
            # read1 returns the next available buffered bytes instead of waiting
            # for a large fixed-size read, preserving Anthropic SSE streaming.
            while chunk := response.read1(16 * 1024):
                self.wfile.write(chunk)
                self.wfile.flush()
            self.close_connection = True
        except (OSError, http.client.HTTPException):
            if not self.wfile.closed:
                self.send_error(502, "governed gateway unavailable")
        finally:
            connection.close()


def control_job_update(operation_id: str, action: str, lease_id: str) -> None:
    target = f"{CONTROL.scheme}://{CONTROL.hostname}:{CONTROL.port}{CONTROL.path.rstrip('/')}/internal/v1/agent/uploads/{operation_id}/{action}"
    request = urllib.request.Request(
        target,
        data=json.dumps({"leaseId": lease_id}, separators=(",", ":")).encode(),
        method="POST",
        headers={
            "authorization": f"Bearer {agent_bridge_token()}",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=70) as response:
        response.read()


def run_upload(job: dict) -> None:
    operation_id = job["operationId"]
    lease_id = job["leaseId"]
    try:
        stat = os.stat(job["path"])
        if stat.st_size != job["size"] or stat.st_mtime_ns != job["mtimeNs"]:
            raise ValueError("the local file changed after approval was requested")
        proxy = urllib.request.ProxyHandler({"https": "http://127.0.0.1:4313"})
        opener = urllib.request.build_opener(proxy)
        digest = hashlib.sha256()
        offset = 0
        with open(job["path"], "rb") as source:
            while chunk := source.read(UPLOAD_CHUNK_BYTES):
                digest.update(chunk)
                end = offset + len(chunk) - 1
                request = urllib.request.Request(
                    job["uploadUrl"],
                    data=chunk,
                    method="PUT",
                    headers={
                        "content-length": str(len(chunk)),
                        "content-range": f"bytes {offset}-{end}/{job['size']}",
                    },
                )
                try:
                    with opener.open(request, timeout=300) as response:
                        if response.status not in ({200, 201} if end + 1 == job["size"] else {202}):
                            raise ValueError("Microsoft rejected an upload chunk")
                        response.read()
                except urllib.error.HTTPError as error:
                    error.read()
                    raise ValueError(f"Microsoft rejected an upload chunk (HTTP {error.code})") from None
                offset = end + 1
        if digest.hexdigest() != job["sha256"]:
            raise ValueError("the local file changed while it was uploading")
        control_job_update(operation_id, "complete", lease_id)
    except (OSError, ValueError, urllib.error.URLError):
        try:
            control_job_update(operation_id, "fail", lease_id)
        except (OSError, urllib.error.URLError):
            pass
    finally:
        # The preauthenticated Microsoft URL is an execution credential. Keep
        # it only for the lifetime of the transfer.
        with UPLOAD_LOCK:
            job.pop("uploadUrl", None)
            job.pop("leaseId", None)


if __name__ == "__main__":
    threading.Thread(target=maintain_agent_bridge_token, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Handler).serve_forever()
