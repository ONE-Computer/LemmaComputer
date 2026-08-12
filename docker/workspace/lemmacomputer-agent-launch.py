#!/usr/bin/env python3
"""Run one interactive agent process under a Control-issued instance identity."""

import json
import os
import signal
import subprocess
import sys
import urllib.request
import uuid

PORTS = {
    "claude-desktop": 4312,
    "hermes-claw": 4314,
    "claude-cli": 4315,
    "hermes-desktop": 4316,
    "codex-cli": 4317,
}


def request(port, path, value):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(value, separators=(",", ":")).encode(),
        method="POST",
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        result = json.load(response)
    if not isinstance(result, dict):
        raise RuntimeError("invalid lifecycle response")
    return result


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in PORTS:
        raise SystemExit("usage: lemmacomputer-agent-launch CATALOG COMMAND [ARG ...]")
    catalog, command = sys.argv[1], sys.argv[2:]
    port = PORTS[catalog]
    created = request(port, "/lemmacomputer/agent-instances", {"launchNonce": str(uuid.uuid4())})
    instance_id = created.get("agentInstanceId")
    if not isinstance(instance_id, str):
        raise RuntimeError("Control did not issue an agent instance identity")
    env = dict(os.environ)
    env["LEMMACOMPUTER_AGENT_INSTANCE_ID"] = instance_id
    existing_headers = env.get("ANTHROPIC_CUSTOM_HEADERS", "").strip()
    instance_header = f"x-lemmacomputer-agent-instance-id: {instance_id}"
    env["ANTHROPIC_CUSTOM_HEADERS"] = f"{existing_headers}\n{instance_header}".strip()
    process = None
    try:
        process = subprocess.Popen(command, env=env, start_new_session=True)
        request(port, f"/lemmacomputer/agent-instances/{instance_id}/running", {
            "providerRuntimeId": f"workspace-pid:{process.pid}",
            **({"imageDigest": env["LEMMACOMPUTER_WORKSPACE_IMAGE_DIGEST"]} if env.get("LEMMACOMPUTER_WORKSPACE_IMAGE_DIGEST") else {}),
            **({"imageVersion": env["LEMMACOMPUTER_WORKSPACE_IMAGE_VERSION"]} if env.get("LEMMACOMPUTER_WORKSPACE_IMAGE_VERSION") else {}),
        })
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, lambda received, _frame: os.killpg(process.pid, received))
        status = process.wait()
        request(port, f"/lemmacomputer/agent-instances/{instance_id}/end", {"reason": "process_exited"})
        return status
    except BaseException:
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait()
        try:
            request(port, f"/lemmacomputer/agent-instances/{instance_id}/end", {"reason": "provider_failed" if process else "launch_failed"})
        except Exception:
            pass
        raise


if __name__ == "__main__":
    raise SystemExit(main())
