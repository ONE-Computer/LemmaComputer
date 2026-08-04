"""Run inside the pinned LiteLLM derivative to qualify strict MCP routing.

Usage (from the repository root):
  docker build -f docker/Dockerfile.litellm -t lemmacomputer/litellm:egress-test .
  docker run --rm --entrypoint python \
    -e LEMMACOMPUTER_REMOTE_MCP_EGRESS_PROXY_URL=http://litellm-gateway:test@127.0.0.1:1 \
    -v "$PWD/tests/litellm-remote-mcp-egress.py:/tmp/test.py:ro" \
    lemmacomputer/litellm:egress-test /tmp/test.py
"""

from __future__ import annotations

import asyncio
import os

import httpx


async def main() -> None:
    seen: list[str] = []

    async def proxy(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        first_line = (await reader.readline()).decode("ascii", "replace").strip()
        seen.append(first_line)
        while await reader.readline() not in {b"\r\n", b"\n", b""}:
            pass
        writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(proxy, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    os.environ["LEMMACOMPUTER_REMOTE_MCP_EGRESS_PROXY_URL"] = f"http://litellm-gateway:test@127.0.0.1:{port}"
    os.environ["NO_PROXY"] = "control-api"
    try:
        from litellm.experimental_mcp_client.client import MCPClient
        from litellm.proxy._experimental.mcp_server import mcp_server_manager
        from litellm.types.llms.custom_http import httpxSpecialProvider

        runtime_client = MCPClient(server_url="https://control-api/redirect")._create_httpx_client_factory()()
        assert runtime_client._trust_env is False
        try:
            await runtime_client.get("https://control-api/redirect")
        except httpx.HTTPError:
            pass
        finally:
            await runtime_client.aclose()

        # OAuth discovery, DCR and token paths import this manager-local
        # factory. It must use the same explicit proxy despite NO_PROXY.
        oauth_client = mcp_server_manager.get_async_httpx_client(llm_provider=httpxSpecialProvider.MCP)
        try:
            await oauth_client.get("https://control-api/oauth-metadata")
        except httpx.HTTPError:
            pass
        finally:
            await oauth_client.close()

        assert seen == ["CONNECT control-api:443 HTTP/1.1", "CONNECT control-api:443 HTTP/1.1"], seen
        print("strict remote MCP routing ignores NO_PROXY for runtime and OAuth paths")
    finally:
        server.close()
        await server.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
