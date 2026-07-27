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
SKILL_DEFAULTS_VERSION = 1
SKILL_STATE_FILE = ".onecomputer-skill-defaults.json"


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
    if len(sys.argv) != 7:
        raise SystemExit(
            "usage: onecomputer-hermes-config HOME MODEL ALLOWED_TOOLS "
            "BROKER_PORT EXECUTION_MODE BUNDLED_SKILLS"
        )

    home_raw, model, allowed_tools, broker_port, execution_mode, bundled_raw = sys.argv[1:]
    if execution_mode not in {"managed", "disposable-open"}:
        raise SystemExit("invalid execution mode")
    if not model or not allowed_tools or not broker_port.isdigit():
        raise SystemExit("invalid Hermes profile configuration")

    home = Path(home_raw)
    bundled_root = Path(bundled_raw)
    home.mkdir(parents=True, exist_ok=True)
    current_bundled = bundled_skill_names(bundled_root)
    missing_office = OFFICE_DEFAULT_SKILLS - current_bundled
    if missing_office:
        raise SystemExit(f"missing required Office skills: {','.join(sorted(missing_office))}")

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
    disabled.update(skills_to_default_off - OFFICE_DEFAULT_SKILLS)
    skills_config["disabled"] = sorted(disabled)

    managed_office_toolsets = ["file", "skills", "terminal", "vision"]
    cli_toolsets = managed_office_toolsets + ["onecomputer_connectors"]
    api_toolsets = managed_office_toolsets + ["onecomputer_connectors"]
    if execution_mode == "disposable-open":
        cli_toolsets = ["hermes-cli", "onecomputer_connectors"]
        api_toolsets = ["hermes-api-server", "onecomputer_connectors"]

    document: dict[str, Any] = {
        "model": {
            "default": model,
            "provider": "custom",
            "base_url": f"http://127.0.0.1:{broker_port}/v1",
            "api_key": "onecomputer-loopback-broker",
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
            # Hermes defaults custom GPT-5 models to medium reasoning, while
            # its chat-completions transport cannot combine that parameter
            # with MCP function tools.
            "reasoning_effort": False,
        },
        "mcp_servers": {
            "onecomputer_connectors": {
                "command": "/usr/local/libexec/onecomputer-connectors-stdio",
                "args": [],
                "env": {
                    "ONECOMPUTER_CONNECTORS_BROKER": f"http://127.0.0.1:{broker_port}",
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
