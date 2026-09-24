#!/usr/bin/env python3
"""Exercise the pinned CLI/SDK pair against a local Responses fixture.

Run with the agent-chat Python environment and --binary PATH. No provider
credentials are used. This proves wire compatibility, not live qualification.
"""

import ast
import argparse
import dataclasses
import asyncio
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from openai_codex import ApprovalMode, AsyncCodex, CodexConfig, Sandbox

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
requests = []


class Responses(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        requests.append((dict(self.headers), body))
        assert self.path == "/v1/responses", self.path
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        item = {"id": "msg_fixture", "type": "message", "role": "assistant", "phase": "final_answer",
                "content": [{"type": "output_text", "text": "SDK fixture OK", "annotations": []}]}
        response = {"id": "resp_fixture", "object": "response", "status": "completed",
                    "output": [item], "usage": {"input_tokens": 10, "output_tokens": 3, "total_tokens": 13}}
        events = [
            ("response.created", {"response": {**response, "status": "in_progress", "output": []}}),
            ("response.output_item.added", {"output_index": 0, "item": {**item, "content": []}}),
            ("response.content_part.added", {"item_id": item["id"], "output_index": 0, "content_index": 0,
                                              "part": {"type": "output_text", "text": "", "annotations": []}}),
            ("response.output_text.delta", {"item_id": item["id"], "output_index": 0, "content_index": 0, "delta": "SDK fixture OK"}),
            ("response.output_text.done", {"item_id": item["id"], "output_index": 0, "content_index": 0, "text": "SDK fixture OK"}),
            ("response.output_item.done", {"output_index": 0, "item": item}),
            ("response.completed", {"response": response}),
        ]
        for event, payload in events:
            self.wfile.write(f"event: {event}\ndata: {json.dumps({'type': event, **payload})}\n\n".encode())
        self.wfile.flush()


async def qualify(binary):
    assert subprocess.check_output([binary, "--version"], text=True).strip() == "codex-cli 0.154.0"
    assert importlib.metadata.version("openai-codex") == "0.154.0"
    spec = importlib.util.spec_from_file_location("codex_config", ROOT / "docker/workspace/lemmacomputer-codex-config.py")
    configurator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(configurator)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Responses)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with tempfile.TemporaryDirectory(prefix="codex-wire-") as directory:
            home = Path(directory)
            configurator.configure(home, "balanced", "lite,balanced,pro", "managed")
            path = home / "config.toml"
            config = path.read_text().replace("http://127.0.0.1:4317/v1", f"http://127.0.0.1:{server.server_port}/v1")
            # Tool custody is tested by the broker suite and live MCP check;
            # this fixture does not install a workspace connector executable.
            path.write_text(config.split("[mcp_servers.", 1)[0])
            # Match the workspace adapter startup: initialize the durable vendor
            # home once before launching concurrent per-instance app servers.
            async with AsyncCodex(CodexConfig(codex_bin=binary, cwd=str(home), env={
                "HOME": str(home), "CODEX_HOME": str(home), "PATH": "/usr/bin:/bin",
                "OPENAI_API_KEY": "fixture-only",
            })) as initial:
                await initial.models()
            async def conversation(mode):
                thread_id = None
                for index in range(2):
                    binding = f"fixture-{mode}-turn-{index}"
                    # Execute the production process configuration, including
                    # its binding override, rather than duplicating that seam.
                    source = ast.parse((ROOT / "docker/workspace/lemmacomputer-agent-chat.py").read_text())
                    function = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "codex_config")
                    scope = {"Any": object, "json": json, "HOME": home, "BROKER": f"http://127.0.0.1:{server.server_port}"}
                    exec(compile(ast.Module(body=[function], type_ignores=[]), "codex_config", "exec"), scope)
                    runtime = scope["codex_config"](f"fixture-{mode}", binding)
                    runtime = dataclasses.replace(runtime, codex_bin=binary, env={**runtime.env, "CODEX_HOME": str(home)})
                    async with AsyncCodex(runtime) as client:
                        models = await client.models()
                        assert {model.id for model in models.data} == {"lemmacomputer-lite", "lemmacomputer-balanced", "lemmacomputer-pro"}
                        assert next(model.id for model in models.data if model.is_default) == "lemmacomputer-balanced"
                        assert all(
                            [option.reasoning_effort.value for option in model.supported_reasoning_efforts]
                            == ["low", "medium", "high"]
                            for model in models.data
                        )
                        options = dict(model=f"lemmacomputer-{mode}", cwd=str(home),
                                       approval_mode=ApprovalMode.deny_all, sandbox=Sandbox.read_only,
                                       config={"model_providers": {"lemmacomputer": {
                                           "http_headers": {"x-lemmacomputer-ai-task-binding": binding},
                                       }}})
                        thread = await client.thread_resume(thread_id, **options) if thread_id else await client.thread_start(**options)
                        thread_id = thread.id
                        turn = await thread.turn("Reply with the fixture marker", approval_mode=ApprovalMode.deny_all, sandbox=Sandbox.read_only)
                        seen = []
                        async for event in turn.stream():
                            seen.append(event.method)
                            if event.method == "turn/completed":
                                assert event.payload.turn.status.value == "completed"
                        assert "item/agentMessage/delta" in seen and "turn/completed" in seen
                return thread_id
            ids = await asyncio.wait_for(asyncio.gather(*(conversation(mode) for mode in ("lite", "balanced", "pro"))), timeout=90)
            assert len(set(ids)) == 3
            assert len(requests) == 6
            observed = set()
            for headers, body in requests:
                headers = {key.lower(): value for key, value in headers.items()}
                mode = body["model"].removeprefix("lemmacomputer-")
                assert headers["x-lemmacomputer-agent-instance-id"] == f"fixture-{mode}"
                binding = headers["x-lemmacomputer-ai-task-binding"]
                assert binding in {f"fixture-{mode}-turn-0", f"fixture-{mode}-turn-1"}
                assert headers.get("content-encoding", "identity") == "identity"
                observed.add(binding)
            assert len(observed) == 6, "resume must replace the previous signed task binding"
            print("Codex CLI 0.154.0 + SDK 0.154.0: catalog, governed reasoning options, streaming, three concurrent modes, resume, and per-turn identity headers passed (local fixture).")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    args = parser.parse_args()
    asyncio.run(qualify(str(Path(args.binary).resolve())))
