import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("the LiteLLM policy callback retries one lost idempotent Control response", () => {
  const callback = path.resolve(import.meta.dirname, "../integrations/litellm/onecomputer_policy_callback.py");
  const script = String.raw`
import json
import runpy
import sys
import types
import urllib.error

fastapi = types.ModuleType("fastapi")
fastapi.HTTPException = type("HTTPException", (Exception,), {
    "__init__": lambda self, *args, **kwargs: Exception.__init__(self, args, kwargs),
})
litellm = types.ModuleType("litellm")
litellm.get_model_info = lambda model: {}
integrations = types.ModuleType("litellm.integrations")
custom_logger = types.ModuleType("litellm.integrations.custom_logger")
custom_logger.CustomLogger = type("CustomLogger", (), {
    "__init__": lambda self, *args, **kwargs: None,
})
sys.modules["fastapi"] = fastapi
sys.modules["litellm"] = litellm
sys.modules["litellm.integrations"] = integrations
sys.modules["litellm.integrations.custom_logger"] = custom_logger

module = runpy.run_path(sys.argv[1])
request_decision = module["_request_decision"]
request_decision.__globals__["POLICY_TOKEN"] = "p" * 24
decision = {
    "schemaVersion": 1,
    "decision": "approval_required",
    "code": "MCP_APPROVAL_REQUIRED",
    "capabilityId": "m365.send-chat-message",
    "schemaId": "onecomputer.m365.send-chat-message.v1",
    "schemaHash": "a" * 64,
    "operationId": "11111111-1111-4111-8111-111111111111",
}

class Response:
    status = 200
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def read(self, *args):
        return json.dumps(decision).encode("utf-8")

calls = []
def recover_after_timeout(request, timeout):
    calls.append(timeout)
    if len(calls) == 1:
        raise TimeoutError("response lost after commit")
    return Response()

request_decision.__globals__["urllib"].request.urlopen = recover_after_timeout
assert request_decision({"toolName": "send-chat-message"}) == decision
assert calls == [2, 2]

http_calls = []
def terminal_http_error(request, timeout):
    http_calls.append(timeout)
    raise urllib.error.HTTPError("http://control.test", 500, "failure", {}, None)

request_decision.__globals__["urllib"].request.urlopen = terminal_http_error
try:
    request_decision({"toolName": "send-chat-message"})
except urllib.error.HTTPError:
    pass
else:
    raise AssertionError("HTTP errors must not be retried")
assert http_calls == [2]
`;
  const result = spawnSync("python3", ["-c", script, callback], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
