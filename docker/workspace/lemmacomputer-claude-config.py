#!/usr/bin/env python3
"""Write Claude Desktop's root-owned LemmaComputer managed settings."""

import json
import os
import sys


def main() -> None:
    if len(sys.argv) != 8:
        raise SystemExit(
            "usage: lemmacomputer-claude-config PATH MODEL TRANSPORT_MODEL "
            "SERVICE_CLASS LABEL COWORK_ENABLED CODE_ENABLED"
        )
    path, model, transport_model, default_service_class, label, cowork_enabled, code_enabled = sys.argv[1:]
    if default_service_class == "auto":
        default_service_class = "balanced"
    if default_service_class not in {"lite", "balanced", "pro"}:
        raise SystemExit("invalid Claude model mode")

    if transport_model == "lemmacomputer-auto":
        # Claude Desktop 1.22209.3 rejects gateway model IDs that do not look
        # Anthropic-owned before it opens Cowork. Keep these client-adapter
        # aliases Claude-shaped while the loopback broker maps them only to
        # provider-neutral LemmaComputer service classes.
        modes = [
            ("lemmacomputer-claude-haiku-lite", "Lite — organization route", "haiku", "lite"),
            ("lemmacomputer-claude-sonnet-balanced", "Balanced — organization route", "sonnet", "balanced"),
            ("lemmacomputer-claude-opus-pro", "Pro — organization route", "opus", "pro"),
        ]
        inference_models = [{
            "name": name,
            "labelOverride": mode_label,
            "anthropicFamilyTier": family,
            "isFamilyDefault": service_class == default_service_class,
        } for name, mode_label, family, service_class in modes]
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
