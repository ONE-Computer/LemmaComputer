#!/usr/bin/env python3
"""Loopback proxy that authenticates Firefox to the workspace egress sidecar."""

from __future__ import annotations

import base64
import os
import selectors
import socket
import socketserver
import sys
from urllib.parse import unquote, urlsplit

MAX_HEADER_BYTES = 64 * 1024
UPSTREAM_URL = urlsplit(os.environ["ONECOMPUTER_EGRESS_UPSTREAM"])

if (
    UPSTREAM_URL.scheme != "http"
    or not UPSTREAM_URL.hostname
    or not UPSTREAM_URL.port
    or UPSTREAM_URL.username != "onecomputer"
    or not UPSTREAM_URL.password
):
    raise SystemExit("invalid egress broker configuration")

UPSTREAM_ADDRESS = (UPSTREAM_URL.hostname, UPSTREAM_URL.port)
UPSTREAM_CREDENTIAL = base64.b64encode(
    f"{unquote(UPSTREAM_URL.username)}:{unquote(UPSTREAM_URL.password)}".encode()
).decode()


def read_headers(connection: socket.socket) -> bytes:
    document = bytearray()
    while b"\r\n\r\n" not in document:
        chunk = connection.recv(4096)
        if not chunk:
            break
        document.extend(chunk)
        if len(document) > MAX_HEADER_BYTES:
            raise ValueError("proxy request headers are too large")
    return bytes(document)


def authenticated_request(document: bytes, *, close: bool) -> bytes:
    header, marker, remainder = document.partition(b"\r\n\r\n")
    if not marker:
        raise ValueError("incomplete proxy request headers")
    lines = header.split(b"\r\n")
    filtered = [
        line
        for line in lines
        if not line.lower().startswith(
            (b"proxy-authorization:", b"proxy-connection:", b"connection:")
        )
    ]
    filtered.append(f"Proxy-Authorization: Basic {UPSTREAM_CREDENTIAL}".encode())
    if close:
        filtered.extend((b"Proxy-Connection: close", b"Connection: close"))
    return b"\r\n".join(filtered) + marker + remainder


def tunnel(left: socket.socket, right: socket.socket) -> None:
    selector = selectors.DefaultSelector()
    selector.register(left, selectors.EVENT_READ, right)
    selector.register(right, selectors.EVENT_READ, left)
    try:
        while True:
            for key, _ in selector.select(timeout=60):
                source = key.fileobj
                destination = key.data
                data = source.recv(64 * 1024)
                if not data:
                    return
                destination.sendall(data)
    finally:
        selector.close()


class Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        upstream: socket.socket | None = None
        try:
            request = read_headers(self.request)
            if not request:
                return
            method = request.split(b" ", 1)[0].upper()
            upstream = socket.create_connection(UPSTREAM_ADDRESS, timeout=10)
            upstream.sendall(authenticated_request(request, close=method != b"CONNECT"))

            if method == b"CONNECT":
                response = read_headers(upstream)
                self.request.sendall(response)
                status_line = response.split(b"\r\n", 1)[0].split()
                if len(status_line) < 2 or status_line[1] != b"200":
                    return
            tunnel(self.request, upstream)
        except (OSError, ValueError) as error:
            print(f"egress-broker: {type(error).__name__}", file=sys.stderr, flush=True)
        finally:
            if upstream is not None:
                upstream.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    Server(("127.0.0.1", 4313), Handler).serve_forever()
