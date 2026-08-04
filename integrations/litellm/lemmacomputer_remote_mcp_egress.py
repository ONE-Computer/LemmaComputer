"""Pinned LiteLLM egress guard for public MCP and OAuth traffic.

This is intentionally a small compatibility extension rather than a global
``HTTP_PROXY`` setting.  LiteLLM's normal process also has private MCP routes,
and HTTPX honours ``NO_PROXY`` when redirects are followed.  For public MCP
work, an explicit client with ``trust_env=False`` is the security boundary.

The extension is tied to LiteLLM 1.93.0.  ``verify()`` checks that release and
the methods patched below before the server is allowed to start.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.metadata
import inspect
import os
from typing import Any, Callable
from urllib.parse import urlsplit

import httpx


EXPECTED_LITELLM_VERSION = "1.93.0"
REMOTE_PROXY_ENV = "LEMMACOMPUTER_REMOTE_MCP_EGRESS_PROXY_URL"
_installed = False
_routing_clients: dict[int, "_McpRoutingClient"] = {}


def _validated_proxy_url() -> str:
    value = os.environ.get(REMOTE_PROXY_ENV, "").strip()
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or not parsed.username
        or not parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError(
            f"{REMOTE_PROXY_ENV} must be an absolute authenticated HTTP(S) proxy URL without a path, query, or fragment"
        )
    return value


def _https_url(url: str) -> bool:
    try:
        parsed = urlsplit(url)
    except ValueError:
        return False
    return parsed.scheme.lower() == "https" and bool(parsed.hostname)


def _internal_http_url(url: str) -> bool:
    """The only HTTP MCP route in the reference deployment is M365.

    A public connector is admitted only as HTTPS.  Refusing every other HTTP
    URL stops OAuth metadata from turning a public HTTPS connector into a
    direct request to an internal service.
    """
    try:
        parsed = urlsplit(url)
    except ValueError:
        return False
    return parsed.scheme.lower() == "http" and (parsed.hostname or "").lower() == "ms365-mcp"


def _strict_profile(client: Any) -> bool:
    profile = getattr(client, "_lemmacomputer_egress_profile", None)
    if profile == "internal":
        return False
    if profile == "strict_remote":
        return True
    return _https_url(getattr(client, "server_url", ""))


class _McpRoutingClient:
    """Route only MCP-package public HTTPS requests through the strict proxy."""

    def __init__(self, direct_client: Any):
        self._direct = direct_client
        # This long-lived client is intentionally separate from LiteLLM's
        # cache: its proxy and trust_env setting can never be inherited from
        # a model client or changed by NO_PROXY.
        self._strict = httpx.AsyncClient(
            proxy=_validated_proxy_url(),
            trust_env=False,
            follow_redirects=True,
        )

    async def close(self) -> None:
        await self._strict.aclose()

    async def _request(self, method: str, url: str, **kwargs: Any) -> Any:
        if _https_url(url):
            stream = bool(kwargs.pop("stream", False))
            logging_obj = kwargs.pop("logging_obj", None)
            files = kwargs.pop("files", None)
            content = kwargs.pop("content", None)
            # HTTPX has no `stream` keyword on request(); the MCP paths that
            # use this wrapper are metadata/token calls.  Preserve a caller's
            # redirect preference while keeping the secure default.
            follow_redirects = kwargs.pop("follow_redirects", True)
            response = await self._strict.request(
                method,
                url,
                follow_redirects=follow_redirects,
                content=content,
                files=files,
                **kwargs,
            )
            if method.upper() != "GET":
                response.raise_for_status()
            # A streaming metadata/token request is not supported by LiteLLM's
            # MCP paths.  Fail closed rather than return a response whose proxy
            # client could be silently reused with a different route.
            if stream or logging_obj is not None:
                raise RuntimeError("Streaming MCP OAuth requests are not supported by the strict egress client")
            return response
        if not _internal_http_url(url):
            raise RuntimeError("MCP and OAuth destinations must use public HTTPS or the private M365 route")
        method_name = method.lower()
        direct_method = getattr(self._direct, method_name, None)
        if direct_method is None:
            raise RuntimeError(f"The pinned LiteLLM HTTP client does not support {method_name}")
        return await direct_method(url, **kwargs)

    async def get(self, url: str, **kwargs: Any) -> Any:
        return await self._request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> Any:
        return await self._request("POST", url, **kwargs)

    async def put(self, url: str, **kwargs: Any) -> Any:
        return await self._request("PUT", url, **kwargs)

    async def patch(self, url: str, **kwargs: Any) -> Any:
        return await self._request("PATCH", url, **kwargs)

    async def delete(self, url: str, **kwargs: Any) -> Any:
        return await self._request("DELETE", url, **kwargs)


def _routed_http_client(original_factory: Callable[..., Any], *args: Any, **kwargs: Any) -> _McpRoutingClient:
    direct = original_factory(*args, **kwargs)
    key = id(direct)
    routed = _routing_clients.get(key)
    if routed is None:
        routed = _McpRoutingClient(direct)
        _routing_clients[key] = routed
    return routed


async def _patched_per_user_post_token_endpoint(
    url: str,
    form: dict[str, str],
    headers: dict[str, str],
) -> dict[str, object] | None:
    """Cover v2 OAuth refresh, which imports its client inside the function."""
    from litellm.llms.custom_httpx.http_handler import get_async_httpx_client
    from litellm.types.llms.custom_http import httpxSpecialProvider

    try:
        client = _routed_http_client(get_async_httpx_client, llm_provider=httpxSpecialProvider.Oauth2Check)
        response = await client.post(url, headers={"Accept": "application/json", **headers}, data=form)
        response.raise_for_status()
        body: dict[str, object] = response.json()
        return body
    except Exception:
        return None


async def _patched_token_exchange_post_token_endpoint(
    url: str,
    form: dict[str, str],
    client_auth_headers: dict[str, str],
) -> dict[str, object] | None:
    """Cover v2 token-exchange refresh, which also imports lazily."""
    from litellm.llms.custom_httpx.http_handler import get_async_httpx_client
    from litellm.types.llms.custom_http import httpxSpecialProvider

    try:
        client = _routed_http_client(get_async_httpx_client, llm_provider=httpxSpecialProvider.MCP)
        response = await client.post(url, headers={"Accept": "application/json", **client_auth_headers}, data=form)
        response.raise_for_status()
        body: dict[str, object] = response.json()
        return body
    except Exception:
        return None


def _patch_mcp_http_client_modules() -> None:
    """Patch every pinned MCP module that imported LiteLLM's cached handler."""
    module_names = (
        "litellm.proxy._experimental.mcp_server.auth.token_exchange",
        "litellm.proxy._experimental.mcp_server.db",
        "litellm.proxy._experimental.mcp_server.discoverable_endpoints",
        "litellm.proxy._experimental.mcp_server.mcp_server_manager",
        "litellm.proxy._experimental.mcp_server.oauth2_token_cache",
        "litellm.proxy._experimental.mcp_server.openapi_to_mcp_generator",
        "litellm.proxy._experimental.mcp_server.outbound_credentials.per_user_oauth_store",
        "litellm.proxy._experimental.mcp_server.outbound_credentials.token_exchange_provider",
        "litellm.proxy._experimental.mcp_server.server",
    )
    for module_name in module_names:
        module = importlib.import_module(module_name)
        original = getattr(module, "get_async_httpx_client", None)
        if original is not None and not getattr(module, "_lemmacomputer_mcp_egress_patched", False):
            setattr(module, "_lemmacomputer_original_get_async_httpx_client", original)
            setattr(module, "get_async_httpx_client", lambda *args, _original=original, **kwargs: _routed_http_client(_original, *args, **kwargs))
            setattr(module, "_lemmacomputer_mcp_egress_patched", True)

    per_user = importlib.import_module(
        "litellm.proxy._experimental.mcp_server.outbound_credentials.per_user_oauth_store"
    )
    per_user._post_token_endpoint = _patched_per_user_post_token_endpoint
    token_exchange = importlib.import_module(
        "litellm.proxy._experimental.mcp_server.outbound_credentials.token_exchange_provider"
    )
    token_exchange._post_token_endpoint = _patched_token_exchange_post_token_endpoint


def _patch_runtime_mcp_client() -> None:
    client_module = importlib.import_module("litellm.experimental_mcp_client.client")
    manager_module = importlib.import_module("litellm.proxy._experimental.mcp_server.mcp_server_manager")
    mcp_client_type = client_module.MCPClient
    manager_type = manager_module.MCPServerManager

    if not getattr(mcp_client_type, "_lemmacomputer_mcp_egress_patched", False):
        original_factory = mcp_client_type._create_httpx_client_factory

        def strict_factory(self: Any):
            normal_factory = original_factory(self)
            if not _strict_profile(self):
                return normal_factory

            def factory(*, headers: Any = None, timeout: Any = None, auth: Any = None) -> httpx.AsyncClient:
                fallback_auth = getattr(self, "_resolved_auth", None) or getattr(self, "_aws_auth", None)
                return httpx.AsyncClient(
                    headers=headers,
                    timeout=timeout,
                    auth=auth if auth is not None else fallback_auth,
                    verify=client_module.get_ssl_configuration(getattr(self, "ssl_verify", None)),
                    proxy=_validated_proxy_url(),
                    trust_env=False,
                    follow_redirects=True,
                )

            return factory

        mcp_client_type._create_httpx_client_factory = strict_factory
        mcp_client_type._lemmacomputer_mcp_egress_patched = True

    if not getattr(manager_type, "_lemmacomputer_mcp_egress_patched", False):
        original_create_client = manager_type._create_mcp_client

        async def create_client_with_profile(self: Any, server: Any, *args: Any, **kwargs: Any) -> Any:
            client = await original_create_client(self, server, *args, **kwargs)
            info = getattr(server, "mcp_info", None)
            profile = info.get("lemmacomputer_egress_profile") if isinstance(info, dict) else None
            setattr(client, "_lemmacomputer_egress_profile", profile)
            return client

        manager_type._create_mcp_client = create_client_with_profile
        manager_type._lemmacomputer_mcp_egress_patched = True


def verify() -> None:
    actual = importlib.metadata.version("litellm")
    if actual != EXPECTED_LITELLM_VERSION:
        raise RuntimeError(f"LemmaComputer remote MCP egress patch requires LiteLLM {EXPECTED_LITELLM_VERSION}, found {actual}")
    _validated_proxy_url()
    client_module = importlib.import_module("litellm.experimental_mcp_client.client")
    manager_module = importlib.import_module("litellm.proxy._experimental.mcp_server.mcp_server_manager")
    if "follow_redirects=True" not in inspect.getsource(client_module.MCPClient._create_httpx_client_factory):
        raise RuntimeError("Pinned LiteLLM MCP client implementation changed; refusing to start without an egress review")
    if "server" not in inspect.signature(manager_module.MCPServerManager._create_mcp_client).parameters:
        raise RuntimeError("Pinned LiteLLM MCP manager signature changed; refusing to start without an egress review")


def install() -> None:
    global _installed
    if _installed:
        return
    verify()
    _patch_mcp_http_client_modules()
    _patch_runtime_mcp_client()
    _installed = True


if __name__ == "__main__":
    install()
