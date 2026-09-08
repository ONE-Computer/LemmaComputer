import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("Codex uses the task's product mode for local context metadata without accepting provider IDs", () => {
  const result = execFileSync("python3", ["-c", String.raw`
import ast, base64, binascii, json
from pathlib import Path
source = ast.parse(Path("docker/workspace/lemmacomputer-agent-chat.py").read_text())
node = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "codex_model")
MODEL = "lemmacomputer-auto"
exec(compile(ast.Module(body=[node], type_ignores=[]), "adapter", "exec"))
def binding(value): return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=") + ".fixture"
assert codex_model(None) is None
for mode in ("lite", "balanced", "pro"):
    assert codex_model(binding({"requestedServiceClass": mode})) == "lemmacomputer-" + mode
assert codex_model(binding({"requestedServiceClass": "auto"})) is None
for value in ({"requestedServiceClass": "gpt-6-astra"}, {"requestedServiceClass": ["pro"]}, []):
    try: codex_model(binding(value))
    except ValueError: pass
    else: raise AssertionError("accepted invalid mode")
print("passed")
`], { encoding: "utf8" });
  assert.equal(result.trim(), "passed");
});

test("every Codex turn owns a fresh process with its own binding, including legacy channel resumes", () => {
  const program = String.raw`
import ast, asyncio, json, sys, types
from pathlib import Path
from typing import Any, AsyncIterator
source = ast.parse(Path("docker/workspace/lemmacomputer-agent-chat.py").read_text())
nodes = [node for node in source.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in {"codex_config", "codex_vendor_events"}]
HOME = Path("/home/kasm-user")
BROKER = "http://127.0.0.1:4317"
processes = []
class Client:
    def __init__(self, config):
        self.config = config
        self.closed = False
        processes.append(self)
    async def __aenter__(self): return self
    async def __aexit__(self, *_args): self.closed = True
sys.modules["openai_codex"] = types.SimpleNamespace(CodexConfig=lambda **kwargs: kwargs, AsyncCodex=Client)
exec(compile(ast.Module(body=nodes, type_ignores=[]), "adapter", "exec"))
async def _codex_vendor_events_with_client(client, item, text, attachments, turn_id, return_artifacts, binding):
    await asyncio.sleep(0)
    assert client.config["config_overrides"] == ('model_providers.lemmacomputer.http_headers={"x-lemmacomputer-ai-task-binding"=' + json.dumps(binding) + '}',)
    assert client.config["codex_bin"] == "/usr/local/libexec/lemmacomputer-codex-bin"
    yield {"kind": "vendor-finish", "vendorSessionId": item["vendorSessionId"], "state": "completed"}
async def run_one(index, instance):
    return [event async for event in codex_vendor_events({"vendorSessionId": "saved-thread"}, "fixture", [], str(index), False, "signed-turn-" + str(index), instance)]
async def run():
    results = await asyncio.gather(run_one(0, None), run_one(1, None), run_one(2, "instance-browser"))
    assert len(processes) == 3 and all(client.closed for client in processes)
    assert "LEMMACOMPUTER_AGENT_INSTANCE_ID" not in processes[0].config["env"]
    assert processes[2].config["env"]["LEMMACOMPUTER_AGENT_INSTANCE_ID"] == "instance-browser"
    print(json.dumps(results))
asyncio.run(run())
`;
  const result = JSON.parse(execFileSync("python3", ["-c", program], { encoding: "utf8" }));
  assert.equal(result.length, 3);
  assert.ok(result.every((events: Array<{ vendorSessionId: string }>) => events[0]?.vendorSessionId === "saved-thread"));
});

test("Codex preserves text and completed tools while dropping raw reasoning and summaries", () => {
  assert.equal(execFileSync("python3", ["tests/codex-events-test.py"], { encoding: "utf8" }).trim(), "passed");
});
