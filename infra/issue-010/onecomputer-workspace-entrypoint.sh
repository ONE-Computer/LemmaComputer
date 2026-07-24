#!/usr/bin/env bash
set -euo pipefail

: "${ONECOMPUTER_ENABLED_AGENTS:=claude-desktop}"
: "${ONECOMPUTER_ENABLED_APPLICATIONS:=firefox}"
: "${ONECOMPUTER_CLIPBOARD_ENABLED:=true}"
: "${ONECOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE:=true}"
: "${ONECOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL:=true}"
: "${ONECOMPUTER_CLIPBOARD_MAX_BYTES:=65536}"
: "${ONECOMPUTER_SIGNED_POLICY_B64:?Signed ONEComputer policy projection is required}"
: "${ONECOMPUTER_POLICY_VERIFICATION_KEYS_B64:?Policy verification keys are required}"

claude_code_version="2.1.215"
claude_code_checksum="7ff9594e53cd89d1af9ceb3c18d3d70be1a5c6d27475e31ee2bed65d748f18c0"
claude_code_source="/opt/onecomputer/claude-code/${claude_code_version}/claude"
claude_code_dir="/home/kasm-user/.config/Claude-3p/claude-code/${claude_code_version}"
claude_code_binary="${claude_code_dir}/claude"
claude_code_marker="${claude_code_dir}/.verified"
launcher_dir="/usr/local/share/onecomputer/applications"

agent_enabled() {
  [[ ",${ONECOMPUTER_ENABLED_AGENTS}," == *",$1,"* ]]
}

IFS=',' read -r -a enabled_agents <<< "$ONECOMPUTER_ENABLED_AGENTS"
(( ${#enabled_agents[@]} >= 1 && ${#enabled_agents[@]} <= 4 )) || {
  echo "invalid agent selection" >&2
  exit 78
}
for enabled_agent in "${enabled_agents[@]}"; do
  [[ "$enabled_agent" == "claude-desktop" \
    || "$enabled_agent" == "claude-cli" \
    || "$enabled_agent" == "hermes-desktop" \
    || "$enabled_agent" == "hermes-claw" ]] || {
    echo "unrecognized agent selection" >&2
    exit 78
  }
done
[[ "$(printf '%s\n' "${enabled_agents[@]}" | sort -u | wc -l)" -eq "${#enabled_agents[@]}" ]] || {
  echo "duplicate agent selection" >&2
  exit 78
}

IFS=',' read -r -a enabled_applications <<< "$ONECOMPUTER_ENABLED_APPLICATIONS"
(( ${#enabled_applications[@]} >= 1 && ${#enabled_applications[@]} <= 2 )) || {
  echo "invalid application selection" >&2
  exit 78
}
for enabled_application in "${enabled_applications[@]}"; do
  [[ "$enabled_application" == "firefox" || "$enabled_application" == "google-chrome" ]] || {
    echo "unrecognized application selection" >&2
    exit 78
  }
done
[[ "$(printf '%s\n' "${enabled_applications[@]}" | sort -u | wc -l)" -eq "${#enabled_applications[@]}" ]] || {
  echo "duplicate application selection" >&2
  exit 78
}

application_enabled() {
  [[ ",${ONECOMPUTER_ENABLED_APPLICATIONS}," == *",$1,"* ]]
}

require_agent_environment() {
  local prefix="$1"
  local label="$2"
  local suffix variable
  for suffix in GATEWAY_UPSTREAM GATEWAY_CREDENTIAL MODEL_ALIAS CONTROL_UPSTREAM AGENT_BRIDGE_TOKEN ALLOWED_TOOLS; do
    variable="${prefix}_${suffix}"
    [[ -n "${!variable:-}" ]] || {
      echo "${label} ${suffix} is required" >&2
      exit 78
    }
  done
}

agent_enabled claude-desktop && require_agent_environment ONECOMPUTER "Claude Desktop"
agent_enabled claude-cli && require_agent_environment ONECOMPUTER_CLAUDE_CLI "Claude CLI"
agent_enabled hermes-claw && require_agent_environment ONECOMPUTER_HERMES "Hermes Agent CLI"
agent_enabled hermes-desktop && require_agent_environment ONECOMPUTER_HERMES_DESKTOP "Hermes Agent Desktop"
if agent_enabled hermes-claw; then
  hermes_api_key="${API_SERVER_KEY:-}"
  [[ "${API_SERVER_ENABLED:-}" == "true" \
    && "${API_SERVER_HOST:-}" == "0.0.0.0" \
    && "${API_SERVER_PORT:-}" == "8642" \
    && "${#hermes_api_key}" -ge 32 ]] || {
    echo "Hermes sandbox API configuration is required" >&2
    exit 78
  }
fi

for clipboard_boolean in \
  "$ONECOMPUTER_CLIPBOARD_ENABLED" \
  "$ONECOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE" \
  "$ONECOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL"; do
  [[ "$clipboard_boolean" == "true" || "$clipboard_boolean" == "false" ]] || {
    echo "invalid clipboard policy boolean" >&2
    exit 78
  }
done
[[ "$ONECOMPUTER_CLIPBOARD_MAX_BYTES" =~ ^[0-9]+$ ]] \
  && ((ONECOMPUTER_CLIPBOARD_MAX_BYTES >= 1 && ONECOMPUTER_CLIPBOARD_MAX_BYTES <= 1048576)) || {
    echo "invalid clipboard size policy" >&2
    exit 78
  }

clipboard_local_to_workspace="$ONECOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE"
clipboard_workspace_to_local="$ONECOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL"
if [[ "$ONECOMPUTER_CLIPBOARD_ENABLED" != "true" ]]; then
  clipboard_local_to_workspace=false
  clipboard_workspace_to_local=false
fi

if agent_enabled claude-desktop; then
  case "$ONECOMPUTER_MODEL_ALIAS" in
    onecomputer-claude|claude-sonnet-4-6) model_label="Claude — organization route" ;;
    onecomputer-openai|claude-opus-4-6) model_label="OpenAI — organization route" ;;
    onecomputer-glm|claude-sonnet-4-5) model_label="GLM — organization route" ;;
    onecomputer-assistant) model_label="Standard organization route" ;;
    *) echo "unrecognized Claude model assignment" >&2; exit 78 ;;
  esac
fi

install -d -o root -g root -m 0755 /etc/claude-desktop /run/onecomputer
install -d -o root -g root -m 0755 /etc/onecomputer/policy
python3 - "$ONECOMPUTER_SIGNED_POLICY_B64" "$ONECOMPUTER_POLICY_VERIFICATION_KEYS_B64" <<'PY'
import base64
import json
import os
import sys

def decode(value):
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding).decode("utf-8")

bundle_text = decode(sys.argv[1])
keys_text = decode(sys.argv[2])
bundle = json.loads(bundle_text)
keys = json.loads(keys_text)
if (
    set(bundle) != {"profile", "canonicalization", "algorithm", "keyId", "payload", "payloadDigest", "signature"}
    or bundle.get("profile") != "onecomputer-effective-policy/v1"
    or bundle.get("canonicalization") != "RFC8785-JCS"
    or bundle.get("algorithm") != "Ed25519"
    or keys.get("profile") != "onecomputer-policy-key-set/v1"
):
    raise SystemExit("invalid signed policy projection")

files = {
    "/etc/onecomputer/policy/signed-policy.json": bundle_text,
    "/etc/onecomputer/policy/verification-keys.json": keys_text,
    "/etc/onecomputer/policy/README.txt": (
        "This is the transparent ONEComputer policy projection. The workspace copy is not an "
        "enforcement authority. Control and the workspace controller independently verify and "
        "enforce the signed policy outside this sandbox.\n"
    ),
}
for path, content in files.items():
    with open(path, "w", encoding="utf-8") as output:
        output.write(content)
        if not content.endswith("\n"):
            output.write("\n")
    os.chmod(path, 0o644)
    os.chown(path, 0, 0)
PY
unset ONECOMPUTER_SIGNED_POLICY_B64 ONECOMPUTER_POLICY_VERIFICATION_KEYS_B64
python3 - \
  "$clipboard_local_to_workspace" \
  "$clipboard_workspace_to_local" \
  "$ONECOMPUTER_CLIPBOARD_MAX_BYTES" <<'PY'
import os
import sys

local_to_workspace, workspace_to_local, max_bytes = sys.argv[1:]
document = f"""network:
  ssl:
    pem_certificate: ${{HOME}}/.vnc/self.pem
    pem_key: ${{HOME}}/.vnc/self.pem
  udp:
    public_ip: 127.0.0.1
runtime_configuration:
  allow_override_standard_vnc_server_settings: true
  allow_override_list:
    - pointer.enabled
data_loss_prevention:
  logging:
    level: off
  clipboard:
    delay_between_operations: none
    allow_mimetypes:
      - text/plain
    server_to_client:
      enabled: {workspace_to_local}
      size: {max_bytes}
      primary_clipboard_enabled: false
    client_to_server:
      enabled: {local_to_workspace}
      size: {max_bytes}
"""
path = "/etc/kasmvnc/kasmvnc.yaml"
with open(path, "w", encoding="utf-8") as output:
    output.write(document)
os.chmod(path, 0o644)
os.chown(path, 0, 0)
PY
if agent_enabled claude-desktop; then
python3 - "$ONECOMPUTER_MODEL_ALIAS" "$model_label" "$ONECOMPUTER_ALLOWED_TOOLS" <<'PY'
import json
import os
import sys

model, label, allowed_tools = sys.argv[1:]
tools = [item for item in allowed_tools.split(",") if item]
tool_policy = {tool: "allow" for tool in tools}
tool_policy["wait-for-governed-operation"] = "allow"
document = {
    "inferenceProvider": "gateway",
    "inferenceGatewayBaseUrl": "http://127.0.0.1:4312",
    "inferenceGatewayApiKey": "onecomputer-loopback-broker",
    "inferenceGatewayAuthScheme": "bearer",
    "modelDiscoveryEnabled": False,
    "inferenceModels": [{
        "name": model,
        "labelOverride": label,
        "anthropicFamilyTier": "sonnet",
        "isFamilyDefault": True,
    }],
    "disableDeploymentModeChooser": True,
    "disableDeepLinkRegistration": True,
    "chatTabEnabled": True,
    "chatAdvancedFileAnalysisEnabled": False,
    "isClaudeCodeForDesktopEnabled": False,
    "coworkTabEnabled": False,
    "disableBundledSkills": True,
    "autoModeEnabled": False,
    "toolSearchEnabled": False,
    "managedMcpServers": [{
        "name": "Microsoft 365 through ONEComputer",
        "transport": "stdio",
        "command": "/usr/local/libexec/onecomputer-mcp-stdio",
        "args": [],
        # Desktop's local prompt layer is pre-approved. ONEComputer Control is
        # the authoritative allow / signed-approval / deny policy boundary.
        "toolPolicy": tool_policy,
    }],
    "isLocalDevMcpEnabled": False,
    "isDesktopExtensionEnabled": False,
}
path = "/etc/claude-desktop/managed-settings.json"
with open(path, "w", encoding="utf-8") as output:
    json.dump(document, output, separators=(",", ":"))
    output.write("\n")
os.chmod(path, 0o644)
os.chown(path, 0, 0)
PY
fi

if agent_enabled claude-cli; then
  install -d -o 1000 -g 1000 -m 0700 /home/kasm-user/.claude-cli
  python3 - "$ONECOMPUTER_CLAUDE_CLI_MODEL_ALIAS" "$ONECOMPUTER_CLAUDE_CLI_ALLOWED_TOOLS" <<'PY'
import json
import os
import sys

model, allowed_tools = sys.argv[1:]
tools = [item for item in allowed_tools.split(",") if item]
with open("/home/kasm-user/.claude-cli/onecomputer.env", "w", encoding="utf-8") as output:
    output.write(f"ONECOMPUTER_MODEL_ALIAS={model}\n")
with open("/home/kasm-user/.claude-cli/mcp.json", "w", encoding="utf-8") as output:
    json.dump({
        "mcpServers": {
            "onecomputer_ms365": {
                "type": "stdio",
                "command": "/usr/local/libexec/onecomputer-mcp-stdio",
                "args": [],
                "env": {"ONECOMPUTER_MCP_BROKER": "http://127.0.0.1:4315"},
                "tools": tools + ["wait-for-governed-operation"],
            },
        },
    }, output, separators=(",", ":"))
    output.write("\n")
for path in ["/home/kasm-user/.claude-cli/onecomputer.env", "/home/kasm-user/.claude-cli/mcp.json"]:
    os.chmod(path, 0o600)
    os.chown(path, 1000, 1000)
PY
fi

configure_hermes() {
  local home="$1"
  local model="$2"
  local allowed_tools="$3"
  local broker_port="$4"
  install -d -o 1000 -g 1000 -m 0700 "$home"
  /opt/onecomputer/hermes-venv/bin/python - "$home" "$model" "$allowed_tools" "$broker_port" <<'PY'
import json
import os
import sys
from toolsets import TOOLSETS

home, model, allowed_tools, broker_port = sys.argv[1:]
tools = [item for item in allowed_tools.split(",") if item]
document = {
    "model": {
        "default": model,
        "provider": "custom",
        "base_url": f"http://127.0.0.1:{broker_port}/v1",
        "api_key": "onecomputer-loopback-broker",
    },
    "platform_toolsets": {"cli": [], "api_server": [], "telegram": []},
    "agent": {"disabled_toolsets": sorted(TOOLSETS)},
    "mcp_servers": {
        "onecomputer_ms365": {
            "command": "/usr/local/libexec/onecomputer-mcp-stdio",
            "args": [],
            "env": {"ONECOMPUTER_MCP_BROKER": f"http://127.0.0.1:{broker_port}"},
            "tools": {"include": tools + ["wait-for-governed-operation"]},
        },
    },
    "stt": {"enabled": False},
}
path = os.path.join(home, "config.yaml")
with open(path, "w", encoding="utf-8") as output:
    json.dump(document, output, separators=(",", ":"))
    output.write("\n")
os.chmod(path, 0o600)
os.chown(path, 1000, 1000)
PY
}

agent_enabled hermes-claw \
  && configure_hermes /home/kasm-user/.hermes "$ONECOMPUTER_HERMES_MODEL_ALIAS" "$ONECOMPUTER_HERMES_ALLOWED_TOOLS" 4314
agent_enabled hermes-desktop \
  && configure_hermes /home/kasm-user/.hermes-desktop "$ONECOMPUTER_HERMES_DESKTOP_MODEL_ALIAS" "$ONECOMPUTER_HERMES_DESKTOP_ALLOWED_TOOLS" 4316

install -d -o 1000 -g 1000 -m 0755 /home/kasm-user/.config/autostart /home/kasm-user/Desktop
rm -f /home/kasm-user/.config/autostart/claude-desktop.desktop \
  /home/kasm-user/Desktop/Claude-Desktop.desktop \
  /home/kasm-user/Desktop/Claude-CLI.desktop \
  /home/kasm-user/Desktop/ONEComputer-Agent.desktop \
  /home/kasm-user/Desktop/Hermes-Claw.desktop \
  /home/kasm-user/Desktop/Hermes-CLI.desktop \
  /home/kasm-user/Desktop/Hermes-Agent-CLI.desktop \
  /home/kasm-user/Desktop/Hermes-Desktop.desktop \
  /home/kasm-user/Desktop/Hermes-Agent-Desktop.desktop \
  /home/kasm-user/Desktop/Firefox.desktop \
  /home/kasm-user/Desktop/Google-Chrome.desktop
if agent_enabled claude-desktop; then
  chmod 0755 "$(command -v claude-desktop)"
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/onecomputer-claude-desktop.desktop" /home/kasm-user/.config/autostart/claude-desktop.desktop
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/onecomputer-claude-desktop.desktop" /home/kasm-user/Desktop/Claude-Desktop.desktop
else
  chmod 0700 "$(command -v claude-desktop)"
fi
if agent_enabled claude-cli; then
  chmod 0755 /usr/local/bin/onecomputer-claude
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/onecomputer-claude-cli.desktop" /home/kasm-user/Desktop/Claude-CLI.desktop
else
  chmod 0700 /usr/local/bin/onecomputer-claude
fi
if agent_enabled hermes-claw; then
  chmod 0755 /usr/local/bin/onecomputer-hermes
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/onecomputer-hermes-agent-cli.desktop" /home/kasm-user/Desktop/Hermes-Agent-CLI.desktop
else
  chmod 0700 /usr/local/bin/onecomputer-hermes
fi
if agent_enabled hermes-desktop; then
  chmod 0755 /usr/local/bin/onecomputer-hermes-desktop /opt/onecomputer/hermes-desktop/Hermes
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/onecomputer-hermes-desktop.desktop" /home/kasm-user/Desktop/Hermes-Agent-Desktop.desktop
else
  chmod 0700 /usr/local/bin/onecomputer-hermes-desktop /opt/onecomputer/hermes-desktop/Hermes
fi
if agent_enabled hermes-claw || agent_enabled hermes-desktop; then
  chmod 0755 /opt/onecomputer/hermes-venv/bin/hermes
else
  chmod 0700 /opt/onecomputer/hermes-venv/bin/hermes
fi
if application_enabled firefox; then
  chmod 0755 /opt/firefox/firefox
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/onecomputer-firefox.desktop" /home/kasm-user/Desktop/Firefox.desktop
else
  chmod 0700 /opt/firefox/firefox
fi
if application_enabled google-chrome; then
  chmod 0755 /opt/google/chrome/google-chrome
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/onecomputer-google-chrome.desktop" /home/kasm-user/Desktop/Google-Chrome.desktop
else
  chmod 0700 /opt/google/chrome/google-chrome
fi

# Claude Desktop's Chat runtime uses the exact Claude Code engine embedded in
# its signed build manifest. Seed that generated cache from the immutable image
# because the managed workspace has no direct route to Anthropic's CDN.
if agent_enabled claude-desktop && { [[ ! -x "$claude_code_binary" ]] \
  || [[ ! -f "$claude_code_marker" ]] \
  || [[ "$(<"$claude_code_marker")" != "$claude_code_checksum" ]]; }; then
  install -d -o 1000 -g 1000 -m 0755 "$claude_code_dir"
  install -o 1000 -g 1000 -m 0755 "$claude_code_source" "$claude_code_binary"
  printf '%s\n' "$claude_code_checksum" > "$claude_code_marker"
  chown 1000:1000 "$claude_code_marker"
  chmod 0600 "$claude_code_marker"
fi

for hermes_home in /home/kasm-user/.hermes /home/kasm-user/.hermes-desktop; do
  [[ -d "$hermes_home" ]] || continue
  # Hermes creates runtime logs, sessions, and curator state beneath its home.
  # Some imports initialize those paths while this management entrypoint is
  # still root, so reconcile the complete tree before handing it to the user.
  chown -R 1000:1000 "$hermes_home"
  find "$hermes_home" -type d -exec chmod 0700 {} +
done
chown -R 1000:1000 /home/kasm-user/.config /home/kasm-user/Desktop

start_agent_broker() {
  local prefix="$1"
  local port="$2"
  local pid_name="$3"
  local upstream_variable="${prefix}_GATEWAY_UPSTREAM"
  local credential_variable="${prefix}_GATEWAY_CREDENTIAL"
  local control_variable="${prefix}_CONTROL_UPSTREAM"
  local bridge_variable="${prefix}_AGENT_BRIDGE_TOKEN"
  env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    ONECOMPUTER_GATEWAY_UPSTREAM="${!upstream_variable}" \
    ONECOMPUTER_GATEWAY_CREDENTIAL="${!credential_variable}" \
    ONECOMPUTER_CONTROL_UPSTREAM="${!control_variable}" \
    ONECOMPUTER_AGENT_BRIDGE_TOKEN="${!bridge_variable}" \
    ONECOMPUTER_GATEWAY_LISTEN_PORT="$port" \
    /usr/local/libexec/onecomputer-gateway-proxy &
  printf '%s\n' "$!" > "/run/onecomputer/${pid_name}.pid"
}

agent_enabled claude-desktop && start_agent_broker ONECOMPUTER 4312 gateway-proxy
agent_enabled hermes-claw && start_agent_broker ONECOMPUTER_HERMES 4314 hermes-gateway-proxy
agent_enabled claude-cli && start_agent_broker ONECOMPUTER_CLAUDE_CLI 4315 claude-cli-gateway-proxy
agent_enabled hermes-desktop && start_agent_broker ONECOMPUTER_HERMES_DESKTOP 4316 hermes-desktop-gateway-proxy

for credential_variable in \
  ONECOMPUTER_GATEWAY_CREDENTIAL ONECOMPUTER_GATEWAY_UPSTREAM ONECOMPUTER_AGENT_BRIDGE_TOKEN ONECOMPUTER_CONTROL_UPSTREAM \
  ONECOMPUTER_HERMES_GATEWAY_CREDENTIAL ONECOMPUTER_HERMES_GATEWAY_UPSTREAM ONECOMPUTER_HERMES_AGENT_BRIDGE_TOKEN ONECOMPUTER_HERMES_CONTROL_UPSTREAM \
  ONECOMPUTER_CLAUDE_CLI_GATEWAY_CREDENTIAL ONECOMPUTER_CLAUDE_CLI_GATEWAY_UPSTREAM ONECOMPUTER_CLAUDE_CLI_AGENT_BRIDGE_TOKEN ONECOMPUTER_CLAUDE_CLI_CONTROL_UPSTREAM \
  ONECOMPUTER_HERMES_DESKTOP_GATEWAY_CREDENTIAL ONECOMPUTER_HERMES_DESKTOP_GATEWAY_UPSTREAM ONECOMPUTER_HERMES_DESKTOP_AGENT_BRIDGE_TOKEN ONECOMPUTER_HERMES_DESKTOP_CONTROL_UPSTREAM; do
  unset "$credential_variable"
done

if [[ -n "${HTTPS_PROXY:-}" ]]; then
  env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    ONECOMPUTER_EGRESS_UPSTREAM="$HTTPS_PROXY" \
    /usr/local/libexec/onecomputer-egress-broker &
  egress_broker_pid=$!
  printf '%s\n' "$egress_broker_pid" > /run/onecomputer/egress-broker.pid
fi

for enabled_agent in "${enabled_agents[@]}"; do
  case "$enabled_agent" in
    claude-desktop) broker_port=4312 ;;
    hermes-claw) broker_port=4314 ;;
    claude-cli) broker_port=4315 ;;
    hermes-desktop) broker_port=4316 ;;
  esac
  for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:${broker_port}/healthz" >/dev/null; then break; fi
    sleep 0.1
  done
  curl -fsS "http://127.0.0.1:${broker_port}/healthz" >/dev/null
done

if agent_enabled hermes-claw; then
  install -d -o 1000 -g 1000 -m 0700 /home/kasm-user/.hermes/logs
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env -i \
      PATH=/opt/onecomputer/hermes-venv/bin:/usr/local/bin:/usr/bin:/bin \
      HOME=/home/kasm-user \
      USER=kasm-user \
      HERMES_HOME=/home/kasm-user/.hermes \
      OPENAI_API_KEY=onecomputer-loopback-broker \
      ONECOMPUTER_MCP_BROKER=http://127.0.0.1:4314 \
      API_SERVER_ENABLED=true \
      API_SERVER_HOST=0.0.0.0 \
      API_SERVER_PORT=8642 \
      API_SERVER_KEY="$hermes_api_key" \
      HTTP_PROXY="${HTTP_PROXY:-}" \
      HTTPS_PROXY="${HTTPS_PROXY:-}" \
      http_proxy="${http_proxy:-}" \
      https_proxy="${https_proxy:-}" \
      NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,onecomputer-control,litellm}" \
      no_proxy="${no_proxy:-localhost,127.0.0.1,onecomputer-control,litellm}" \
      /opt/onecomputer/hermes-venv/bin/hermes gateway run \
      >>/run/onecomputer/hermes-gateway-bootstrap.log 2>&1 &
  printf '%s\n' "$!" > /run/onecomputer/hermes-gateway.pid
  unset API_SERVER_KEY hermes_api_key
  for _ in $(seq 1 200); do
    if curl -fsS "http://127.0.0.1:8642/health" >/dev/null; then break; fi
    sleep 0.1
  done
  curl -fsS "http://127.0.0.1:8642/health" >/dev/null
fi
touch /run/onecomputer/workspace-ready

exec setpriv --reuid=1000 --regid=1000 --init-groups \
  /dockerstartup/kasm_default_profile.sh \
  /dockerstartup/vnc_startup.sh \
  /dockerstartup/kasm_startup.sh "$@"
