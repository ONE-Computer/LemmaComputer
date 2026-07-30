#!/usr/bin/env bash
set -euo pipefail

: "${ONECOMPUTER_ENABLED_AGENTS:=claude-desktop}"
: "${ONECOMPUTER_ENABLED_APPLICATIONS:=firefox}"
: "${ONECOMPUTER_EXECUTION_MODE:=managed}"
: "${ONECOMPUTER_EGRESS_MODE:=restricted}"
: "${ONECOMPUTER_TIME_ZONE:=}"
: "${ONECOMPUTER_CLIPBOARD_ENABLED:=true}"
: "${ONECOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE:=true}"
: "${ONECOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL:=true}"
: "${ONECOMPUTER_CLIPBOARD_MAX_BYTES:=65536}"
: "${ONECOMPUTER_COWORK_ENABLED:=false}"
: "${ONECOMPUTER_SIGNED_POLICY_B64:?Signed ONEComputer policy projection is required}"
: "${ONECOMPUTER_POLICY_VERIFICATION_KEYS_B64:?Policy verification keys are required}"

[[ "$ONECOMPUTER_EXECUTION_MODE" == "managed" || "$ONECOMPUTER_EXECUTION_MODE" == "disposable-open" ]] || {
  echo "invalid execution mode" >&2
  exit 78
}
if [[ "$ONECOMPUTER_EXECUTION_MODE" == "disposable-open" ]]; then
  [[ "$ONECOMPUTER_EGRESS_MODE" == "full-web" ]] || {
    echo "disposable-open requires full-web egress" >&2
    exit 78
  }
else
  [[ "$ONECOMPUTER_EGRESS_MODE" == "restricted" ]] || {
    echo "managed workspaces require restricted egress" >&2
    exit 78
  }
fi

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
(( ${#enabled_agents[@]} >= 1 && ${#enabled_agents[@]} <= 5 )) || {
  echo "invalid agent selection" >&2
  exit 78
}
for enabled_agent in "${enabled_agents[@]}"; do
  [[ "$enabled_agent" == "claude-desktop" \
    || "$enabled_agent" == "claude-cli" \
    || "$enabled_agent" == "codex-cli" \
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

grant_cowork_device_access() {
  local device_path="$1"
  local fallback_group="$2"
  [[ -c "$device_path" ]] || {
    echo "Cowork requires the virtualization device at ${device_path}" >&2
    exit 78
  }

  local device_gid
  local device_group
  device_gid="$(stat -c '%g' "$device_path")"
  device_group="$(getent group "$device_gid" | cut -d: -f1 || true)"
  if [[ -z "$device_group" ]]; then
    device_group="$fallback_group"
    groupadd --system --gid "$device_gid" "$device_group"
  fi
  usermod -aG "$device_group" kasm-user
  setpriv --reuid=1000 --regid=1000 --init-groups \
    /bin/bash -c '[[ -r "$1" && -w "$1" ]]' _ "$device_path" || {
      echo "Cowork cannot access ${device_path} as kasm-user" >&2
      exit 78
    }
}

[[ "$ONECOMPUTER_COWORK_ENABLED" == "true" || "$ONECOMPUTER_COWORK_ENABLED" == "false" ]] || {
  echo "invalid Cowork capability setting" >&2
  exit 78
}
if [[ "$ONECOMPUTER_COWORK_ENABLED" == "true" ]]; then
  agent_enabled claude-desktop || {
    echo "Cowork requires the Claude Desktop agent" >&2
    exit 78
  }
  grant_cowork_device_access /dev/kvm onecomputer-kvm
  grant_cowork_device_access /dev/vhost-vsock onecomputer-vhost-vsock
  setpriv --reuid=1000 --regid=1000 --init-groups \
    python3 -c 'import socket; socket.socket(40, socket.SOCK_STREAM).close()' \
    2>/dev/null || {
      echo "Cowork cannot create an AF_VSOCK socket; check the workspace seccomp profile" >&2
      exit 78
    }
fi

remove_stale_chrome_singletons() {
  local chrome_profile="/home/kasm-user/.config/google-chrome"
  [[ -d "$chrome_profile" ]] || return 0
  if pgrep -u 1000 -f '/opt/google/chrome/google-chrome|/usr/bin/google-chrome-stable' >/dev/null; then
    return 0
  fi
  # The profile lives on the persistent workspace volume, while Chrome's
  # process and /tmp socket do not. A recreated container therefore inherits
  # locks owned by the prior container and Chrome refuses to launch until the
  # three process-singleton artifacts are removed.
  rm -f -- \
    "$chrome_profile/SingletonLock" \
    "$chrome_profile/SingletonCookie" \
    "$chrome_profile/SingletonSocket"
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
  variable="${prefix}_MODEL_ALIAS"
  [[ "${!variable}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$ ]] || {
    echo "${label} MODEL_ALIAS is invalid" >&2
    exit 78
  }
}

agent_enabled claude-desktop && require_agent_environment ONECOMPUTER "Claude Desktop"
agent_enabled claude-cli && require_agent_environment ONECOMPUTER_CLAUDE_CLI "Claude CLI"
agent_enabled codex-cli && require_agent_environment ONECOMPUTER_CODEX_CLI "Codex CLI"
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
if agent_enabled claude-cli; then
  claude_chat_api_key="${ONECOMPUTER_CLAUDE_CHAT_API_KEY:-}"
  [[ "${#claude_chat_api_key}" -ge 32 ]] || {
    echo "Claude Chat API configuration is required" >&2
    exit 78
  }
fi
if agent_enabled codex-cli; then
  codex_chat_api_key="${ONECOMPUTER_CODEX_CHAT_API_KEY:-}"
  [[ "${#codex_chat_api_key}" -ge 32 ]] || {
    echo "Codex Chat API configuration is required" >&2
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

claude_code_for_desktop_enabled=false
if agent_enabled claude-desktop && agent_enabled claude-cli; then
  claude_code_for_desktop_enabled=true
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
python3 - "$ONECOMPUTER_MODEL_ALIAS" "$model_label" "$ONECOMPUTER_COWORK_ENABLED" "$claude_code_for_desktop_enabled" <<'PY'
import json
import os
import sys

model, label, cowork_enabled, code_enabled = sys.argv[1:]
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
    "isClaudeCodeForDesktopEnabled": code_enabled == "true",
    "coworkTabEnabled": cowork_enabled == "true",
    "secureVmFeaturesEnabled": cowork_enabled == "true",
    "allowedWorkspaceFolders": ["/home/kasm-user"],
    "disableBundledSkills": True,
    "autoModeEnabled": False,
    "toolSearchEnabled": False,
    "managedMcpServers": [{
        "name": "ONEComputer connectors",
        "transport": "stdio",
        "command": "/usr/local/libexec/onecomputer-connectors-stdio",
        "args": [],
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

rm -f /etc/claude-desktop/code-model
if [[ "$claude_code_for_desktop_enabled" == "true" ]]; then
  printf '%s\n' "$ONECOMPUTER_CLAUDE_CLI_MODEL_ALIAS" > /etc/claude-desktop/code-model
  chown root:root /etc/claude-desktop/code-model
  chmod 0644 /etc/claude-desktop/code-model
fi

if agent_enabled claude-cli; then
  install -d -o 1000 -g 1000 -m 0700 /home/kasm-user/.claude-cli
python3 - "$ONECOMPUTER_CLAUDE_CLI_MODEL_ALIAS" <<'PY'
import json
import os
import sys

model = sys.argv[1]
with open("/home/kasm-user/.claude-cli/onecomputer.env", "w", encoding="utf-8") as output:
    output.write(f"ONECOMPUTER_MODEL_ALIAS={model}\n")
with open("/home/kasm-user/.claude-cli/mcp.json", "w", encoding="utf-8") as output:
    json.dump({
        "mcpServers": {
            "onecomputer_connectors": {
                "type": "stdio",
                "command": "/usr/local/libexec/onecomputer-connectors-stdio",
                "args": [],
                "env": {"ONECOMPUTER_CONNECTORS_BROKER": "http://127.0.0.1:4315"},
            },
        },
    }, output, separators=(",", ":"))
    output.write("\n")
for path in ["/home/kasm-user/.claude-cli/onecomputer.env", "/home/kasm-user/.claude-cli/mcp.json"]:
    os.chmod(path, 0o600)
    os.chown(path, 1000, 1000)
PY
fi

configure_codex() {
  local home="$1"
  local model="$2"
  local allowed_tools="$3"
  local execution_mode="$4"
  install -d -o 1000 -g 1000 -m 0700 "$home"
  python3 - "$home" "$model" "$allowed_tools" "$execution_mode" <<'PY'
import json
import os
import sys

home, model, allowed_tools, execution_mode = sys.argv[1:]
tools = [item for item in allowed_tools.split(",") if item]
sandbox_mode = "danger-full-access" if execution_mode == "disposable-open" else "read-only"
web_search = "live" if execution_mode == "disposable-open" else "disabled"
document = f"""model = {json.dumps(model)}
model_provider = "onecomputer"
approval_policy = "never"
sandbox_mode = {json.dumps(sandbox_mode)}
web_search = {json.dumps(web_search)}

[model_providers.onecomputer]
name = "ONEComputer governed OpenAI"
base_url = "http://127.0.0.1:4317/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false

[analytics]
enabled = false

[mcp_servers.onecomputer_connectors]
command = "/usr/local/libexec/onecomputer-connectors-stdio"
args = []
default_tools_approval_mode = "approve"

[mcp_servers.onecomputer_connectors.env]
ONECOMPUTER_CONNECTORS_BROKER = "http://127.0.0.1:4317"
"""
path = os.path.join(home, "config.toml")
with open(path, "w", encoding="utf-8") as output:
    output.write(document)
os.chmod(path, 0o600)
os.chown(path, 1000, 1000)
PY
}

if agent_enabled codex-cli; then
  configure_codex /home/kasm-user/.codex-cli "$ONECOMPUTER_CODEX_CLI_MODEL_ALIAS" "$ONECOMPUTER_CODEX_CLI_ALLOWED_TOOLS" "$ONECOMPUTER_EXECUTION_MODE"
  configure_codex /home/kasm-user/.codex-chat-sdk "$ONECOMPUTER_CODEX_CLI_MODEL_ALIAS" "$ONECOMPUTER_CODEX_CLI_ALLOWED_TOOLS" "$ONECOMPUTER_EXECUTION_MODE"
fi

install_agent_skill() {
  local home="$1"
  local target="$home/skills/make-a-site"
  install -d -o 1000 -g 1000 -m 0700 "$home/skills"
  rm -rf -- "$target"
  cp -a /opt/onecomputer/skills/make-a-site "$target"
  chown -R 1000:1000 "$target"
}

if agent_enabled claude-desktop; then
  install_agent_skill /home/kasm-user/.claude
fi
if agent_enabled claude-cli; then
  install_agent_skill /home/kasm-user/.claude-cli
  install_agent_skill /home/kasm-user/.claude-chat-sdk
fi
if agent_enabled codex-cli; then
  install_agent_skill /home/kasm-user/.codex-cli
  install_agent_skill /home/kasm-user/.codex-chat-sdk
fi

configure_hermes() {
  local home="$1"
  local model="$2"
  local allowed_tools="$3"
  local broker_port="$4"
  local execution_mode="$5"
  install -d -o 1000 -g 1000 -m 0700 "$home"
  /opt/onecomputer/hermes-venv/bin/python \
    /usr/local/libexec/onecomputer-hermes-config \
    "$home" "$model" "$allowed_tools" "$broker_port" "$execution_mode" \
    /opt/onecomputer/hermes-agent/skills
}

sync_hermes_skills() {
  local home="$1"
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env -i \
      PATH=/opt/onecomputer/hermes-office-venv/bin:/opt/onecomputer/hermes-venv/bin:/usr/local/bin:/usr/bin:/bin \
      HOME=/home/kasm-user \
      HERMES_HOME="$home" \
      HERMES_BUNDLED_SKILLS=/opt/onecomputer/hermes-agent/skills \
      /opt/onecomputer/hermes-venv/bin/python -c \
      'from tools.skills_sync import sync_skills; sync_skills(quiet=True)'
}

agent_enabled hermes-claw \
  && configure_hermes /home/kasm-user/.hermes "$ONECOMPUTER_HERMES_MODEL_ALIAS" "$ONECOMPUTER_HERMES_ALLOWED_TOOLS" 4314 "$ONECOMPUTER_EXECUTION_MODE" \
  && sync_hermes_skills /home/kasm-user/.hermes
agent_enabled hermes-desktop \
  && configure_hermes /home/kasm-user/.hermes-desktop "$ONECOMPUTER_HERMES_DESKTOP_MODEL_ALIAS" "$ONECOMPUTER_HERMES_DESKTOP_ALLOWED_TOOLS" 4316 "$ONECOMPUTER_EXECUTION_MODE" \
  && sync_hermes_skills /home/kasm-user/.hermes-desktop

install -d -o 1000 -g 1000 -m 0755 /home/kasm-user/.config/autostart /home/kasm-user/Desktop
rm -f /home/kasm-user/.config/autostart/claude-desktop.desktop \
  /home/kasm-user/Desktop/Claude-Desktop.desktop \
  /home/kasm-user/Desktop/Claude-CLI.desktop \
  /home/kasm-user/Desktop/Codex-CLI.desktop \
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
if agent_enabled codex-cli; then
  chmod 0755 /usr/local/bin/onecomputer-codex /usr/local/libexec/onecomputer-codex-bin
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/onecomputer-codex-cli.desktop" /home/kasm-user/Desktop/Codex-CLI.desktop
else
  chmod 0700 /usr/local/bin/onecomputer-codex /usr/local/libexec/onecomputer-codex-bin
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
  remove_stale_chrome_singletons
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
  local model_variable="${prefix}_MODEL_ALIAS"
  env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    ONECOMPUTER_GATEWAY_UPSTREAM="${!upstream_variable}" \
    ONECOMPUTER_GATEWAY_CREDENTIAL="${!credential_variable}" \
    ONECOMPUTER_MODEL_ALIAS="${!model_variable}" \
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
agent_enabled codex-cli && start_agent_broker ONECOMPUTER_CODEX_CLI 4317 codex-cli-gateway-proxy

for credential_variable in \
  ONECOMPUTER_GATEWAY_CREDENTIAL ONECOMPUTER_GATEWAY_UPSTREAM ONECOMPUTER_AGENT_BRIDGE_TOKEN ONECOMPUTER_CONTROL_UPSTREAM \
  ONECOMPUTER_HERMES_GATEWAY_CREDENTIAL ONECOMPUTER_HERMES_GATEWAY_UPSTREAM ONECOMPUTER_HERMES_AGENT_BRIDGE_TOKEN ONECOMPUTER_HERMES_CONTROL_UPSTREAM \
  ONECOMPUTER_CLAUDE_CLI_GATEWAY_CREDENTIAL ONECOMPUTER_CLAUDE_CLI_GATEWAY_UPSTREAM ONECOMPUTER_CLAUDE_CLI_AGENT_BRIDGE_TOKEN ONECOMPUTER_CLAUDE_CLI_CONTROL_UPSTREAM \
  ONECOMPUTER_HERMES_DESKTOP_GATEWAY_CREDENTIAL ONECOMPUTER_HERMES_DESKTOP_GATEWAY_UPSTREAM ONECOMPUTER_HERMES_DESKTOP_AGENT_BRIDGE_TOKEN ONECOMPUTER_HERMES_DESKTOP_CONTROL_UPSTREAM \
  ONECOMPUTER_CODEX_CLI_GATEWAY_CREDENTIAL ONECOMPUTER_CODEX_CLI_GATEWAY_UPSTREAM ONECOMPUTER_CODEX_CLI_AGENT_BRIDGE_TOKEN ONECOMPUTER_CODEX_CLI_CONTROL_UPSTREAM; do
  unset "$credential_variable"
done

if [[ -n "${HTTPS_PROXY:-}" ]]; then
  egress_upstream_file=/run/onecomputer/egress-upstream
  umask 077
  printf '%s\n' "$HTTPS_PROXY" > "$egress_upstream_file"
  env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    ONECOMPUTER_EGRESS_UPSTREAM_FILE="$egress_upstream_file" \
    /usr/local/libexec/onecomputer-egress-broker &
  egress_broker_pid=$!
  printf '%s\n' "$egress_broker_pid" > /run/onecomputer/egress-broker.pid
  export HTTP_PROXY=http://127.0.0.1:4313
  export HTTPS_PROXY=http://127.0.0.1:4313
  export http_proxy=http://127.0.0.1:4313
  export https_proxy=http://127.0.0.1:4313
fi

for enabled_agent in "${enabled_agents[@]}"; do
  case "$enabled_agent" in
    claude-desktop) broker_port=4312 ;;
    hermes-claw) broker_port=4314 ;;
    claude-cli) broker_port=4315 ;;
    hermes-desktop) broker_port=4316 ;;
    codex-cli) broker_port=4317 ;;
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
      PATH=/opt/onecomputer/hermes-office-venv/bin:/opt/onecomputer/hermes-venv/bin:/usr/local/bin:/usr/bin:/bin \
      HOME=/home/kasm-user \
      USER=kasm-user \
      HERMES_HOME=/home/kasm-user/.hermes \
      HERMES_BUNDLED_SKILLS=/opt/onecomputer/hermes-agent/skills \
      NODE_PATH=/opt/onecomputer/hermes-office-node/node_modules \
      TZ="${TZ:-Etc/UTC}" \
      ONECOMPUTER_TIME_ZONE="$ONECOMPUTER_TIME_ZONE" \
      OPENAI_API_KEY=onecomputer-loopback-broker \
      ONECOMPUTER_CONNECTORS_BROKER=http://127.0.0.1:4314 \
      ONECOMPUTER_SITES_BROKER=http://127.0.0.1:4314 \
      API_SERVER_ENABLED=true \
      API_SERVER_HOST=127.0.0.1 \
      API_SERVER_PORT=8652 \
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
  for _ in $(seq 1 200); do
    if curl -fsS "http://127.0.0.1:8652/health" >/dev/null; then break; fi
    sleep 0.1
  done
  curl -fsS "http://127.0.0.1:8652/health" >/dev/null
fi

start_sdk_chat_adapter() {
  local agent="$1"
  local port="$2"
  local broker_port="$3"
  local model="$4"
  local allowed_tools="$5"
  local api_key="$6"
  local hermes_url="${7:-}"
  local hermes_key="${8:-}"
  install -d -o 1000 -g 1000 -m 0700 \
    "/home/kasm-user/.onecomputer-chat/${agent}" \
    /home/kasm-user/.claude-chat-sdk
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env -i \
      PATH=/opt/onecomputer/agent-chat-venv/bin:/usr/local/bin:/usr/bin:/bin \
      HOME=/home/kasm-user \
      USER=kasm-user \
      ONECOMPUTER_CHAT_AGENT="$agent" \
      ONECOMPUTER_CHAT_API_KEY="$api_key" \
      ONECOMPUTER_CHAT_MODEL_ALIAS="$model" \
      ONECOMPUTER_CHAT_ALLOWED_TOOLS="$allowed_tools" \
      ONECOMPUTER_EXECUTION_MODE="$ONECOMPUTER_EXECUTION_MODE" \
      TZ="${TZ:-Etc/UTC}" \
      ONECOMPUTER_TIME_ZONE="$ONECOMPUTER_TIME_ZONE" \
      ONECOMPUTER_CHAT_BROKER="http://127.0.0.1:${broker_port}" \
      ONECOMPUTER_SITES_BROKER="http://127.0.0.1:${broker_port}" \
      ONECOMPUTER_CHAT_PORT="$port" \
      ONECOMPUTER_HERMES_CHAT_URL="$hermes_url" \
      ONECOMPUTER_HERMES_CHAT_KEY="$hermes_key" \
      /opt/onecomputer/agent-chat-venv/bin/python \
      /usr/local/libexec/onecomputer-agent-chat \
      >>"/run/onecomputer/${agent}-chat.log" 2>&1 &
  printf '%s\n' "$!" > "/run/onecomputer/${agent}-chat.pid"
  for _ in $(seq 1 200); do
    if curl -fsS -H "authorization: Bearer ${api_key}" "http://127.0.0.1:${port}/health" >/dev/null; then break; fi
    sleep 0.1
  done
  curl -fsS -H "authorization: Bearer ${api_key}" "http://127.0.0.1:${port}/health" >/dev/null
}

if agent_enabled hermes-claw; then
  start_sdk_chat_adapter \
    hermes-claw 8642 4314 \
    "$ONECOMPUTER_HERMES_MODEL_ALIAS" \
    "$ONECOMPUTER_HERMES_ALLOWED_TOOLS" \
    "$hermes_api_key" \
    http://127.0.0.1:8652 \
    "$hermes_api_key"
  unset API_SERVER_KEY hermes_api_key
fi
if agent_enabled claude-cli; then
  start_sdk_chat_adapter \
    claude-cli 8643 4315 \
    "$ONECOMPUTER_CLAUDE_CLI_MODEL_ALIAS" \
    "$ONECOMPUTER_CLAUDE_CLI_ALLOWED_TOOLS" \
    "$claude_chat_api_key"
  unset ONECOMPUTER_CLAUDE_CHAT_API_KEY claude_chat_api_key
fi
if agent_enabled codex-cli; then
  start_sdk_chat_adapter \
    codex-cli 8644 4317 \
    "$ONECOMPUTER_CODEX_CLI_MODEL_ALIAS" \
    "$ONECOMPUTER_CODEX_CLI_ALLOWED_TOOLS" \
    "$codex_chat_api_key"
  unset ONECOMPUTER_CODEX_CHAT_API_KEY codex_chat_api_key
fi

cron_supervisor_pid=""
if [[ "$ONECOMPUTER_EXECUTION_MODE" == "disposable-open" ]]; then
  install -d -o 1000 -g 1000 -m 0700 \
    /home/kasm-user/.onecomputer \
    /home/kasm-user/.onecomputer/logs \
    /home/kasm-user/.onecomputer/locks \
    /home/kasm-user/.onecomputer/scripts \
    /home/kasm-user/.onecomputer/results
  install -o 1000 -g 1000 -m 0644 \
    /usr/local/share/onecomputer/SCHEDULING.md \
    /home/kasm-user/.onecomputer/SCHEDULING.md
  install -o 1000 -g 1000 -m 0600 /dev/null /run/onecomputer/cron-events.log
  canonical_crontab="/home/kasm-user/.onecomputer/crontab"
  if [[ -f "$canonical_crontab" ]]; then
    [[ "$(stat -c %u "$canonical_crontab")" -eq 1000 \
      && "$(stat -c %g "$canonical_crontab")" -eq 1000 \
      && "$(stat -c %a "$canonical_crontab")" == "600" \
      && "$(stat -c %s "$canonical_crontab")" -le 65536 ]] || {
      echo "persistent crontab has unsafe ownership, mode, or size" >&2
      exit 78
    }
    if LC_ALL=C grep -qP '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' "$canonical_crontab"; then
      echo "persistent crontab contains unsupported control characters" >&2
      exit 78
    fi
    /usr/bin/crontab -u kasm-user "$canonical_crontab"
    printf '%s\n' '{"event":"crontab_restore","result":"installed"}' >> /run/onecomputer/cron-events.log
  else
    /usr/bin/crontab -u kasm-user -r 2>/dev/null || true
    printf '%s\n' '{"event":"crontab_restore","result":"empty"}' >> /run/onecomputer/cron-events.log
  fi
  (
    set +e
    /usr/sbin/cron -f -L 0 >>/run/onecomputer/cron-daemon.log 2>&1
    cron_status=$?
    rm -f /run/onecomputer/workspace-ready
    printf '{"event":"cron_daemon_exit","exitStatus":%d}\n' "$cron_status" >> /run/onecomputer/cron-events.log
    kill -TERM 1 2>/dev/null || true
    exit "$cron_status"
  ) &
  cron_supervisor_pid="$!"
  printf '%s\n' "$cron_supervisor_pid" > /run/onecomputer/cron-supervisor.pid
  sleep 0.2
  kill -0 "$cron_supervisor_pid"
else
  /usr/bin/crontab -u kasm-user -r 2>/dev/null || true
fi

[[ -z "$cron_supervisor_pid" ]] || kill -0 "$cron_supervisor_pid"
touch /run/onecomputer/workspace-ready

exec setpriv --reuid=1000 --regid=1000 --init-groups \
  /dockerstartup/kasm_default_profile.sh \
  /dockerstartup/vnc_startup.sh \
  /dockerstartup/kasm_startup.sh "$@"
