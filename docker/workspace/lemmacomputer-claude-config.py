#!/usr/bin/env python3
"""Write Claude Desktop's root-owned LemmaComputer managed settings."""

import json
import os
import sys


def main() -> None:
    if len(sys.argv) != 9:
        raise SystemExit(
            "usage: lemmacomputer-claude-config PATH MODEL TRANSPORT_MODEL "
            "SERVICE_CLASS ALLOWED_SERVICE_CLASSES LABEL COWORK_ENABLED CODE_ENABLED"
        )
    path, model, transport_model, default_service_class, allowed_value, label, cowork_enabled, code_enabled = sys.argv[1:]
    allowed_service_classes = [value for value in allowed_value.split(",") if value]
    if not allowed_service_classes or any(value not in {"lite", "balanced", "pro"} for value in allowed_service_classes):
        raise SystemExit("invalid allowed Claude model modes")
    if default_service_class == "auto":
        default_service_class = "balanced" if "balanced" in allowed_service_classes else allowed_service_classes[0]
    if default_service_class not in {"lite", "balanced", "pro"}:
        raise SystemExit("invalid Claude model mode")
    if default_service_class not in allowed_service_classes:
        raise SystemExit("default Claude model mode is not allowed")

    if transport_model == "lemmacomputer-auto":
        # Claude Desktop 1.22209.3 rejects gateway model IDs that do not look
        # Anthropic-owned before it opens Cowork, and exposes its independent
        # effort control only for exact built-in capability IDs. Its pinned
        # normalizer removes a trailing release date, so these three distinct
        # client-adapter IDs all resolve to the qualified sonnet-4-6 UI
        # capability without selecting an Anthropic provider route. The
        # loopback broker maps the exact IDs only to provider-neutral
        # LemmaComputer service classes.
        modes = [
            ("claude-sonnet-4-6-20260101", "Lite — organization route", "lite"),
            ("claude-sonnet-4-6-20260102", "Balanced — organization route", "balanced"),
            ("claude-sonnet-4-6-20260103", "Pro — organization route", "pro"),
        ]
        modes = [item for item in modes if item[2] in allowed_service_classes]
        modes.sort(key=lambda item: item[2] != default_service_class)
        inference_models = [{
            "name": name,
            "labelOverride": mode_label,
            "anthropicFamilyTier": "sonnet",
            "isFamilyDefault": service_class == default_service_class,
        } for name, mode_label, service_class in modes]
    else:
        inference_models = [{
            "name": model,
            "labelOverride": label,
            "anthropicFamilyTier": "sonnet",
            "isFamilyDefault": True,
        }]

    document = {
        "inferenceProvider": "gateway",
        "inferenceGatewayBaseUrl": "http://127.0.0.1:4312",
        "inferenceGatewayApiKey": "lemmacomputer-loopback-broker",
        "inferenceGatewayAuthScheme": "bearer",
        "modelDiscoveryEnabled": False,
        "inferenceModels": inference_models,
        "disableDeploymentModeChooser": True,
        "disableDeepLinkRegistration": True,
        "chatTabEnabled": True,
        "chatAdvancedFileAnalysisEnabled": False,
        "isClaudeCodeForDesktopEnabled": code_enabled == "true",
        "coworkTabEnabled": cowork_enabled == "true",
        "secureVmFeaturesEnabled": cowork_enabled == "true",
        "allowedWorkspaceFolders": ["/home/kasm-user"],
        "disableBundledSkills": True,
        "autoModeEnabled": False,
        "toolSearchEnabled": False,
        "managedMcpServers": [{
            "name": "LemmaComputer connectors",
            "transport": "stdio",
            "command": "/usr/local/libexec/lemmacomputer-connectors-stdio",
            "args": [],
        }],
        "isLocalDevMcpEnabled": False,
        "isDesktopExtensionEnabled": False,
    }
    with open(path, "w", encoding="utf-8") as output:
        json.dump(document, output, separators=(",", ":"))
        output.write("\n")
    os.chmod(path, 0o644)
    if os.geteuid() == 0:
        os.chown(path, 0, 0)


if __name__ == "__main__":
    main()
