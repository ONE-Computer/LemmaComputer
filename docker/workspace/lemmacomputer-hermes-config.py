#!/usr/bin/env python3
"""Generate a governed Hermes profile while preserving employee skill choices."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import yaml
from toolsets import TOOLSETS, resolve_toolset

OFFICE_DEFAULT_SKILLS = frozenset({
    "docx",
    "ocr-and-documents",
    "pdf",
    "powerpoint",
    "xlsx",
})
REVIEWED_DEFAULT_SKILLS = OFFICE_DEFAULT_SKILLS | frozenset({"make-a-site"})
SKILL_DEFAULTS_VERSION = 1
SKILL_STATE_FILE = ".lemmacomputer-skill-defaults.json"


def normalized_strings(value: Any) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple, set)):
        return set()
    return {str(item).strip() for item in value if str(item).strip()}


def skill_name(skill_file: Path) -> str:
    fallback = skill_file.parent.name
    try:
        content = skill_file.read_text(encoding="utf-8")
        if not content.startswith("---"):
            return fallback
        _, frontmatter, _ = content.split("---", 2)
        parsed = yaml.safe_load(frontmatter)
        if isinstance(parsed, dict) and isinstance(parsed.get("name"), str):
            return parsed["name"].strip() or fallback
    except (OSError, UnicodeError, ValueError, yaml.YAMLError):
        pass
    return fallback


def bundled_skill_names(root: Path) -> set[str]:
    return {
        name
        for name in (skill_name(path) for path in root.rglob("SKILL.md"))
        if name
    }


def load_mapping(path: Path) -> dict[str, Any]:
    try:
        value = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError):
        return {}
    return value if isinstance(value, dict) else {}


def load_skill_state(path: Path) -> tuple[bool, set[str]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False, set()
    if not isinstance(value, dict) or value.get("version") != SKILL_DEFAULTS_VERSION:
        return False, set()
    catalog = value.get("bundledSkills")
    return isinstance(catalog, list), normalized_strings(catalog)


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(
        json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    os.chown(temporary, 1000, 1000)
    os.replace(temporary, path)


def main() -> None:
    if len(sys.argv) != 8:
        raise SystemExit(
            "usage: lemmacomputer-hermes-config HOME MODEL SERVICE_CLASS ALLOWED_TOOLS "
            "BROKER_PORT EXECUTION_MODE BUNDLED_SKILLS"
        )

    home_raw, model, service_class, allowed_tools, broker_port, execution_mode, bundled_raw = sys.argv[1:]
    if execution_mode not in {"managed", "disposable-open"}:
        raise SystemExit("invalid execution mode")
    if not model or service_class not in {"auto", "lite", "balanced", "pro"} or not allowed_tools or not broker_port.isdigit():
        raise SystemExit("invalid Hermes profile configuration")
    service_class = "balanced" if service_class == "auto" else service_class
    selected_model = f"lemmacomputer-{service_class}" if model == "lemmacomputer-auto" else model

    home = Path(home_raw)
    bundled_root = Path(bundled_raw)
    home.mkdir(parents=True, exist_ok=True)
    current_bundled = bundled_skill_names(bundled_root)
    missing_required = REVIEWED_DEFAULT_SKILLS - current_bundled
    if missing_required:
        raise SystemExit(f"missing required reviewed skills: {','.join(sorted(missing_required))}")

    config_path = home / "config.yaml"
    existing = load_mapping(config_path)
    existing_skills = existing.get("skills")
    skills_config = dict(existing_skills) if isinstance(existing_skills, dict) else {}
    disabled = normalized_strings(skills_config.get("disabled"))

    state_path = home / SKILL_STATE_FILE
    initialized, previous_bundled = load_skill_state(state_path)
    skills_to_default_off = (
        current_bundled - previous_bundled
        if initialized
        else current_bundled
    )
    disabled.update(skills_to_default_off - REVIEWED_DEFAULT_SKILLS)
    skills_config["disabled"] = sorted(disabled)

    managed_office_toolsets = ["file", "skills", "terminal", "vision"]
    cli_toolsets = managed_office_toolsets + ["lemmacomputer_connectors"]
    api_toolsets = managed_office_toolsets + ["lemmacomputer_connectors"]
    if execution_mode == "disposable-open":
        cli_toolsets = ["hermes-cli", "lemmacomputer_connectors"]
        api_toolsets = ["hermes-api-server", "lemmacomputer_connectors"]

    document: dict[str, Any] = {
        "model": {
            "default": selected_model,
            "provider": "custom",
            "base_url": f"http://127.0.0.1:{broker_port}/v1",
            "api_key": "lemmacomputer-loopback-broker",
        },
        # Hermes does not attach globally configured MCP servers to the API
        # platform by default. Web Chat uses api_server, so name the governed
        # server explicitly for both the API and interactive CLI surfaces.
        "platform_toolsets": {
            "cli": cli_toolsets,
            "api_server": api_toolsets,
            "telegram": [],
        },
        "agent": {
            # The governed loopback broker, not Hermes, owns provider reasoning
            # fields. Web Chat pins the product effort to the conversation and
            # carries it in a signed task binding on every turn. Keep Hermes'
            # mutable global setting disabled so it cannot become a second
            # effort authority or change prompt behavior mid-conversation.
            "reasoning_effort": False,
        },
        "mcp_servers": {
            "lemmacomputer_connectors": {
                "command": "/usr/local/libexec/lemmacomputer-connectors-stdio",
                "args": [],
                # The stdio process starts immediately, but its first tool-list
                # response can include an OAuth-backed provider discovery. Keep
                # Hermes' MCP budget above the broker's bounded 10-second
                # provider timeout so a healthy, slower connector is retained.
                "connect_timeout": 15,
                "env": {
                    "LEMMACOMPUTER_CONNECTORS_BROKER": f"http://127.0.0.1:{broker_port}",
                    "LEMMACOMPUTER_CONNECTOR_RECOVERY_STATE_FILE": str(
                        home / ".lemmacomputer-connectors-recovery.json"
                    ),
                    "LEMMACOMPUTER_CONNECTOR_RECOVERY_DEADLINE_SECONDS": "60",
                },
            },
        },
        "skills": skills_config,
        "stt": {"enabled": False},
    }
    if execution_mode == "managed":
        managed_office_tools: set[str] = set()
        for toolset in managed_office_toolsets:
            managed_office_tools.update(resolve_toolset(toolset))
        document["agent"]["disabled_toolsets"] = sorted(
            name
            for name in TOOLSETS
            if managed_office_tools.isdisjoint(resolve_toolset(name))
        )

    atomic_json(config_path, document)
    atomic_json(state_path, {
        "version": SKILL_DEFAULTS_VERSION,
        "bundledSkills": sorted(current_bundled),
    })


if __name__ == "__main__":
    main()
