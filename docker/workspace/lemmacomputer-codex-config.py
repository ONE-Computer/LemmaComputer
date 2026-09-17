#!/usr/bin/env python3
"""Project organization model modes into the pinned Codex client.

The catalog is presentation metadata. The root-owned broker and Control remain
the authority for route readiness, model choice, tools, and reasoning effort.
"""

import json
import os
from pathlib import Path
import sys


def configure(home, default_class, allowed_classes, execution_mode):
    if execution_mode not in {"managed", "disposable-open"}:
        raise ValueError("invalid Codex execution mode")
    classes = list(dict.fromkeys(allowed_classes.split(",")))
    if not classes or any(value not in {"lite", "balanced", "pro"} for value in classes):
        raise ValueError("invalid Codex model modes")
    default_class = "balanced" if default_class == "auto" else default_class
    if default_class not in classes:
        raise ValueError("default Codex mode is not assigned")
    limits = json.loads(os.environ.get("LEMMACOMPUTER_MODEL_LIMITS") or "{}")
    models = []
    for priority, mode in enumerate(classes):
        model = {
            "slug": f"lemmacomputer-{mode}",
            "display_name": mode.title(),
            "description": f"Organization-governed {mode.title()} route",
            "default_reasoning_level": "medium",
            "supported_reasoning_levels": [
                {"effort": "low", "description": "Faster responses with lighter analysis"},
                {"effort": "medium", "description": "Balanced analysis for everyday work"},
                {"effort": "high", "description": "More thorough analysis for complex work"},
            ],
            "shell_type": "default",
            "visibility": "list",
            "supported_in_api": True,
            "priority": 0 if mode == default_class else priority + 1,
            "base_instructions": "You are an assistant in a governed LemmaComputer workspace. Use the approved tools and organization routes.",
            "supports_reasoning_summaries": False,
            "supports_reasoning_summary_parameter": False,
            "support_verbosity": False,
            "truncation_policy": {"mode": "tokens", "limit": 10000},
            "input_modalities": ["text", "image"],
            "experimental_supported_tools": [],
        }
        if mode in limits:
            context, output = limits[mode]["contextTokens"], limits[mode]["outputTokens"]
            if type(context) is not int or type(output) is not int or not 0 < output < context:
                raise ValueError("invalid Codex model limits")
            model.update(context_window=context, max_context_window=context,
                         auto_compact_token_limit=min(context * 90 // 100, context - output))
        models.append(model)
    home = Path(home)
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    catalog_path = home / "lemmacomputer-models.json"
    document = f'''model = "lemmacomputer-{default_class}"
model_provider = "lemmacomputer"
model_catalog_json = {json.dumps(str(catalog_path))}
approval_policy = "never"
sandbox_mode = {json.dumps("danger-full-access" if execution_mode == "disposable-open" else "read-only")}
web_search = "disabled"
check_for_update_on_startup = false
model_reasoning_summary = "none"

[features]
enable_request_compression = false
apps = false
remote_plugin = false

[model_providers.lemmacomputer]
name = "LemmaComputer organization routes"
base_url = "http://127.0.0.1:4317/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false
env_http_headers = {{ "x-lemmacomputer-agent-instance-id" = "LEMMACOMPUTER_AGENT_INSTANCE_ID" }}

[analytics]
enabled = false
[feedback]
enabled = false

[mcp_servers.lemmacomputer_connectors]
command = "/usr/local/libexec/lemmacomputer-connectors-stdio"
args = []
startup_timeout_sec = 60
env_vars = ["LEMMACOMPUTER_AGENT_INSTANCE_ID"]
# This bridge exposes only the policy-filtered connector catalog. Control
# remains authoritative for tool authorization and signed approval of writes,
# so Codex must not add a second client-local approval gate.
default_tools_approval_mode = "approve"

[mcp_servers.lemmacomputer_connectors.env]
LEMMACOMPUTER_CONNECTORS_BROKER = "http://127.0.0.1:4317"
'''
    for path, text in [(catalog_path, json.dumps({"models": models})), (home / "config.toml", document)]:
        path.write_text(text + "\n", encoding="utf-8")
        path.chmod(0o600)


if __name__ == "__main__":
    configure(*sys.argv[1:])
