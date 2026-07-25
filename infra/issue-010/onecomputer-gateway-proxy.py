#!/usr/bin/env python3
"""Loopback-only broker for a workspace-scoped LiteLLM credential."""

from __future__ import annotations

import http.client
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

UPSTREAM = urlsplit(os.environ["ONECOMPUTER_GATEWAY_UPSTREAM"])
CREDENTIAL = os.environ["ONECOMPUTER_GATEWAY_CREDENTIAL"]
CONTROL = urlsplit(os.environ["ONECOMPUTER_CONTROL_UPSTREAM"])
AGENT_BRIDGE_TOKEN = os.environ["ONECOMPUTER_AGENT_BRIDGE_TOKEN"]
LISTEN_PORT = int(os.environ.get("ONECOMPUTER_GATEWAY_LISTEN_PORT", "4312"))
ALLOWED_PATHS = {"/v1/messages", "/v1/chat/completions", "/v1/responses", "/v1/models", "/mcp-rest/tools/list", "/mcp-rest/tools/call"}
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}

if (UPSTREAM.scheme not in {"http", "https"} or not UPSTREAM.hostname or len(CREDENTIAL) < 24
        or CONTROL.scheme not in {"http", "https"} or not CONTROL.hostname or len(AGENT_BRIDGE_TOKEN) < 24
        or LISTEN_PORT not in {4312, 4314, 4315, 4316, 4317}):
    raise SystemExit("invalid gateway broker configuration")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, message: str, *args: object) -> None:
        print(f"gateway-broker: {message % args}", file=sys.stderr, flush=True)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            body = b'{"status":"ready"}'
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.forward()

    def do_POST(self) -> None:
        self.forward()

    def forward(self) -> None:
        path = self.path.split("?", 1)[0]
        operation_prefix = "/onecomputer/operations/"
        is_operation = path.startswith(operation_prefix) and len(path) > len(operation_prefix)
        if path not in ALLOWED_PATHS and not is_operation:
            self.send_error(403, "gateway path is not assigned")
            return
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length) if length else None
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in HOP_BY_HOP | {"host", "authorization", "x-api-key", "content-length"}
        }
        target = CONTROL if is_operation else UPSTREAM
        headers["authorization"] = f"Bearer {AGENT_BRIDGE_TOKEN if is_operation else CREDENTIAL}"
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


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Handler).serve_forever()
