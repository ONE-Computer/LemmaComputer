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
from typing import Any

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

        class FakeResponse:
            def __init__(self, status_code: int, location: str | None = None):
                self.status_code = status_code
                self.headers = {"location": location} if location else {}

            @property
            def is_redirect(self) -> bool:
                return 300 <= self.status_code < 400 and "location" in self.headers

        class FakeClient:
            def __init__(self, responses: list[FakeResponse]):
                self.responses = responses
                self.calls: list[tuple[str, bool, Any]] = []

            async def get(self, url: str, *, follow_redirects: bool, timeout: Any) -> FakeResponse:
                self.calls.append((url, follow_redirects, timeout))
                if not self.responses:
                    raise AssertionError("unexpected metadata request")
                return self.responses.pop(0)

        manager = object.__new__(mcp_server_manager.MCPServerManager)
        original_factory = mcp_server_manager.get_async_httpx_client
        original_safe_get = mcp_server_manager.async_safe_get
        manager_type = mcp_server_manager.MCPServerManager
        original_internal_fetch = manager_type._lemmacomputer_original_fetch_oauth_discovery_url

        async def forbidden_safe_get(*_args: Any, **_kwargs: Any) -> Any:
            raise AssertionError("public OAuth metadata must not use LiteLLM's local-DNS safe_get")

        try:
            metadata_client = FakeClient([
                FakeResponse(302, "https://auth.unresolvable.invalid/oauth-metadata"),
                FakeResponse(200),
            ])
            mcp_server_manager.get_async_httpx_client = lambda *_args, **_kwargs: metadata_client
            mcp_server_manager.async_safe_get = forbidden_safe_get
            response = await manager._fetch_oauth_discovery_url(
                "https://resource.unresolvable.invalid/.well-known/oauth-protected-resource",
                "https://resource.unresolvable.invalid/mcp",
            )
            assert response.status_code == 200
            assert [call[0] for call in metadata_client.calls] == [
                "https://resource.unresolvable.invalid/.well-known/oauth-protected-resource",
                "https://auth.unresolvable.invalid/oauth-metadata",
            ]
            assert all(call[1] is False for call in metadata_client.calls)

            for invalid_url in (
                "http://auth.unresolvable.invalid/metadata",
                "https://user:password@auth.unresolvable.invalid/metadata",
                "https://127.0.0.1/metadata",
                "https://auth.unresolvable.invalid/metadata#fragment",
                "https://auth.unresolvable.invalid/metadata#",
                "https://auth.unresolvable.invalid:invalid/metadata",
            ):
                try:
                    await manager._fetch_oauth_discovery_url(
                        invalid_url,
                        "https://resource.unresolvable.invalid/mcp",
                    )
                except RuntimeError:
                    pass
                else:
                    raise AssertionError(f"unsafe OAuth metadata URL was accepted: {invalid_url}")

            redirecting_client = FakeClient([
                FakeResponse(302, "/again") for _ in range(6)
            ])
            mcp_server_manager.get_async_httpx_client = lambda *_args, **_kwargs: redirecting_client
            try:
                await manager._fetch_oauth_discovery_url(
                    "https://resource.unresolvable.invalid/start",
                    "https://resource.unresolvable.invalid/mcp",
                )
            except RuntimeError as exc:
                assert "redirect limit" in str(exc)
            else:
                raise AssertionError("OAuth metadata redirect limit was not enforced")

            internal_result = object()

            async def internal_fetch(_self: Any, url: str, server_url: str) -> Any:
                assert url == "http://ms365-mcp:3000/.well-known/oauth-protected-resource"
                assert server_url == "http://ms365-mcp:3000/mcp"
                return internal_result

            manager_type._lemmacomputer_original_fetch_oauth_discovery_url = internal_fetch
            assert await manager._fetch_oauth_discovery_url(
                "http://ms365-mcp:3000/.well-known/oauth-protected-resource",
                "http://ms365-mcp:3000/mcp",
            ) is internal_result
        finally:
            mcp_server_manager.get_async_httpx_client = original_factory
            mcp_server_manager.async_safe_get = original_safe_get
            manager_type._lemmacomputer_original_fetch_oauth_discovery_url = original_internal_fetch

        print("strict remote MCP routing covers OAuth metadata without local DNS and preserves internal MCP")
    finally:
        server.close()
        await server.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
