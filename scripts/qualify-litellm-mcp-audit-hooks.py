"""Credential-free qualification of pinned LiteLLM MCP terminal callbacks.

The qualification exercises the real v1.93 logging helper for successful and
MCP `isError` results, then drives the real REST handler with exceptional
executors. It deliberately records capability, including missing callbacks,
instead of assuming that model-completion hook behavior applies to MCP calls.
"""

import asyncio
from datetime import datetime, timezone
import json
from types import SimpleNamespace

from fastapi import HTTPException
from mcp.types import CallToolResult, TextContent

from litellm.proxy._experimental.mcp_server import rest_endpoints
from litellm.proxy._experimental.mcp_server.server import _fire_mcp_tool_call_logging
import litellm.proxy.common_request_processing as common_request_processing


class LoggingProbe:
    def __init__(self):
        self.events = []
        self.model_call_details = {}
        self.call_type = None

    def post_call(self, original_response):
        self.events.append("post_call")

    async def async_post_mcp_tool_call_hook(self, **_kwargs):
        self.events.append("post_mcp")

    async def async_success_handler(self, **_kwargs):
        self.events.append("success")

    def has_run_logging(self, **_kwargs):
        return False

    def failure_handler(self, *_args, **_kwargs):
        self.events.append("sync_failure")

    async def async_failure_handler(self, *_args, **_kwargs):
        self.events.append("failure")


class FakeRequest:
    headers = {}
    scope = {"_original_path": "/mcp-rest/tools/call"}
    url = SimpleNamespace(path="/mcp-rest/tools/call")

    async def json(self):
        return {"server_id": "server-a", "name": "read_document", "arguments": {}}


class FakeProcessor:
    def __init__(self, data):
        self.data = data

    async def common_processing_pre_call_logic(self, **_kwargs):
        return {**self.data, "litellm_logging_obj": object()}, object()


async def qualify_logging_helper():
    start = datetime.now(timezone.utc)
    success = LoggingProbe()
    await _fire_mcp_tool_call_logging(
        success,
        CallToolResult(content=[TextContent(type="text", text="ok")], isError=False),
        start,
        datetime.now(timezone.utc),
    )
    assert success.events == ["post_call", "post_mcp", "success"], success.events

    mcp_error = LoggingProbe()
    await _fire_mcp_tool_call_logging(
        mcp_error,
        CallToolResult(content=[TextContent(type="text", text="provider rejected call")], isError=True),
        start,
        datetime.now(timezone.utc),
    )
    assert mcp_error.events == ["post_call", "post_mcp", "sync_failure", "failure"], mcp_error.events
    return {"success": "success_hook", "mcp_error_result": "failure_hook"}


async def qualify_rest_exceptions():
    original_processor = common_request_processing.ProxyBaseLLMRequestProcessing
    original_extract = rest_endpoints._extract_mcp_headers_from_request
    original_resolve = rest_endpoints._resolve_allowed_mcp_servers_with_ip_filter
    original_oauth = rest_endpoints._get_user_oauth_extra_headers
    original_execute = rest_endpoints.execute_mcp_tool
    original_safe_fire = rest_endpoints._safe_fire_mcp_tool_call_logging
    safe_fire_calls = []

    async def resolve(*_args, **_kwargs):
        return [SimpleNamespace(server_id="server-a")], "server-a"

    async def no_oauth(*_args, **_kwargs):
        return None

    async def safe_fire(*_args, **_kwargs):
        safe_fire_calls.append("called")

    common_request_processing.ProxyBaseLLMRequestProcessing = FakeProcessor
    rest_endpoints._extract_mcp_headers_from_request = lambda *_args, **_kwargs: (None, None, {})
    rest_endpoints._resolve_allowed_mcp_servers_with_ip_filter = resolve
    rest_endpoints._get_user_oauth_extra_headers = no_oauth
    rest_endpoints._safe_fire_mcp_tool_call_logging = safe_fire

    findings = {}
    try:
        async def raised_failure(**_kwargs):
            raise RuntimeError("provider failure fixture")

        async def timed_out(**_kwargs):
            raise TimeoutError("provider timeout fixture")

        async def cancelled(**_kwargs):
            raise asyncio.CancelledError()

        for name, executor in (
            ("raised_failure", raised_failure),
            ("timed_out", timed_out),
            ("cancelled", cancelled),
        ):
            safe_fire_calls.clear()
            rest_endpoints.execute_mcp_tool = executor
            try:
                await rest_endpoints.call_tool_rest_api(FakeRequest(), SimpleNamespace())
            except (HTTPException, asyncio.CancelledError):
                pass
            else:
                raise AssertionError(f"{name} fixture unexpectedly succeeded")
            findings[name] = "post_hook" if safe_fire_calls else "no_post_hook"
    finally:
        common_request_processing.ProxyBaseLLMRequestProcessing = original_processor
        rest_endpoints._extract_mcp_headers_from_request = original_extract
        rest_endpoints._resolve_allowed_mcp_servers_with_ip_filter = original_resolve
        rest_endpoints._get_user_oauth_extra_headers = original_oauth
        rest_endpoints.execute_mcp_tool = original_execute
        rest_endpoints._safe_fire_mcp_tool_call_logging = original_safe_fire

    assert findings == {
        "raised_failure": "no_post_hook",
        "timed_out": "no_post_hook",
        "cancelled": "no_post_hook",
    }, findings
    return findings


async def main():
    helper = await qualify_logging_helper()
    exceptional = await qualify_rest_exceptions()
    print(json.dumps({
        "image": "litellm-v1.93.0-pinned",
        "terminal_callbacks": {**helper, **exceptional},
        "qualification": "post_hooks_insufficient_for_mandatory_terminal_audit",
    }, sort_keys=True))


asyncio.run(main())
