#!/usr/bin/env bash
set -euo pipefail

: "${LEMMACOMPUTER_ENABLED_AGENTS=claude-desktop}"
: "${LEMMACOMPUTER_ENABLED_APPLICATIONS=firefox}"
: "${LEMMACOMPUTER_EXECUTION_MODE:=managed}"
: "${LEMMACOMPUTER_EGRESS_MODE:=restricted}"
: "${LEMMACOMPUTER_TIME_ZONE:=}"
: "${LEMMACOMPUTER_CLIPBOARD_ENABLED:=true}"
: "${LEMMACOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE:=true}"
: "${LEMMACOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL:=true}"
: "${LEMMACOMPUTER_CLIPBOARD_MAX_BYTES:=65536}"
: "${LEMMACOMPUTER_COWORK_ENABLED:=false}"
: "${LEMMACOMPUTER_ELECTRON_SANDBOX_ENABLED:=false}"
: "${LEMMACOMPUTER_SIGNED_POLICY_B64:?Signed LemmaComputer policy projection is required}"
: "${LEMMACOMPUTER_POLICY_VERIFICATION_KEYS_B64:?Policy verification keys are required}"

[[ "$LEMMACOMPUTER_EXECUTION_MODE" == "managed" || "$LEMMACOMPUTER_EXECUTION_MODE" == "disposable-open" ]] || {
  echo "invalid execution mode" >&2
  exit 78
}
if [[ "$LEMMACOMPUTER_EXECUTION_MODE" == "disposable-open" ]]; then
  [[ "$LEMMACOMPUTER_EGRESS_MODE" == "full-web" ]] || {
    echo "disposable-open requires full-web egress" >&2
    exit 78
  }
else
  [[ "$LEMMACOMPUTER_EGRESS_MODE" == "restricted" ]] || {
    echo "managed workspaces require restricted egress" >&2
    exit 78
  }
fi

claude_code_version="2.1.215"
claude_code_checksum="7ff9594e53cd89d1af9ceb3c18d3d70be1a5c6d27475e31ee2bed65d748f18c0"
claude_code_source="/opt/lemmacomputer/claude-code/${claude_code_version}/claude"
claude_code_dir="/home/kasm-user/.config/Claude-3p/claude-code/${claude_code_version}"
claude_code_binary="${claude_code_dir}/claude"
claude_code_marker="${claude_code_dir}/.verified"
launcher_dir="/usr/local/share/lemmacomputer/applications"
startup_phase_name=""
startup_phase_started_ms=0

startup_now_ms() {
  date +%s%3N
}

startup_phase_begin() {
  startup_phase_name="$1"
  startup_phase_started_ms="$(startup_now_ms)"
  printf '{"event":"workspace_startup_phase","phase":"%s","status":"begin"}\n' "$startup_phase_name"
}

startup_phase_finish() {
  local status="$1"
  local finished_ms
  local duration_ms
  finished_ms="$(startup_now_ms)"
  duration_ms=$((finished_ms - startup_phase_started_ms))
  printf '{"event":"workspace_startup_phase","phase":"%s","status":"%s","durationMs":%d}\n' \
    "$startup_phase_name" "$status" "$duration_ms"
  startup_phase_name=""
  startup_phase_started_ms=0
}

agent_enabled() {
  [[ ",${LEMMACOMPUTER_ENABLED_AGENTS}," == *",$1,"* ]]
}

IFS=',' read -r -a enabled_agents <<< "$LEMMACOMPUTER_ENABLED_AGENTS"
(( ${#enabled_agents[@]} <= 5 )) || {
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
if (( ${#enabled_agents[@]} > 0 )); then
  [[ "$(printf '%s\n' "${enabled_agents[@]}" | sort -u | wc -l)" -eq "${#enabled_agents[@]}" ]] || {
    echo "duplicate agent selection" >&2
    exit 78
  }
fi

IFS=',' read -r -a enabled_applications <<< "$LEMMACOMPUTER_ENABLED_APPLICATIONS"
(( ${#enabled_applications[@]} <= 4 )) || {
  echo "invalid application selection" >&2
  exit 78
}
for enabled_application in "${enabled_applications[@]}"; do
  [[ "$enabled_application" == "firefox" || "$enabled_application" == "google-chrome" \
    || "$enabled_application" == "visual-studio-code" || "$enabled_application" == "obsidian" ]] || {
    echo "unrecognized application selection" >&2
    exit 78
  }
done
if (( ${#enabled_applications[@]} > 0 )); then
  [[ "$(printf '%s\n' "${enabled_applications[@]}" | sort -u | wc -l)" -eq "${#enabled_applications[@]}" ]] || {
    echo "duplicate application selection" >&2
    exit 78
  }
fi

application_enabled() {
  [[ ",${LEMMACOMPUTER_ENABLED_APPLICATIONS}," == *",$1,"* ]]
}

electron_sandbox_required=false
for electron_application in google-chrome visual-studio-code obsidian; do
  if application_enabled "$electron_application"; then
    electron_sandbox_required=true
    break
  fi
done
[[ "$LEMMACOMPUTER_ELECTRON_SANDBOX_ENABLED" == "true" || "$LEMMACOMPUTER_ELECTRON_SANDBOX_ENABLED" == "false" ]] || {
  echo "invalid Electron sandbox capability setting" >&2
  exit 78
}
[[ "$LEMMACOMPUTER_ELECTRON_SANDBOX_ENABLED" == "$electron_sandbox_required" ]] || {
  echo "Electron sandbox capability does not match the selected applications" >&2
  exit 78
}
if [[ "$electron_sandbox_required" == "true" ]]; then
  [[ "$(cat /proc/self/attr/current)" == "lemmacomputer-workspace-electron (enforce)" ]] || {
    echo "Electron applications require the enforced LemmaComputer AppArmor profile" >&2
    exit 78
  }
  setpriv --reuid=1000 --regid=1000 --init-groups \
    unshare --user --map-root-user true 2>/dev/null || {
      echo "Electron applications cannot create their user-namespace sandbox" >&2
      exit 78
    }
fi

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

[[ "$LEMMACOMPUTER_COWORK_ENABLED" == "true" || "$LEMMACOMPUTER_COWORK_ENABLED" == "false" ]] || {
  echo "invalid Cowork capability setting" >&2
  exit 78
}
if [[ "$LEMMACOMPUTER_COWORK_ENABLED" == "true" ]]; then
  agent_enabled claude-desktop || {
    echo "Cowork requires the Claude Desktop agent" >&2
    exit 78
  }
  grant_cowork_device_access /dev/kvm lemmacomputer-kvm
  grant_cowork_device_access /dev/vhost-vsock lemmacomputer-vhost-vsock
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

remove_stale_libreoffice_lock() {
  local office_profile="/home/kasm-user/.config/libreoffice/4"
  [[ -d "$office_profile" ]] || return 0
  if pgrep -u 1000 -f '/usr/lib/libreoffice/program/(oosplash|soffice\.bin)' >/dev/null; then
    return 0
  fi
  # The profile persists across workspace-container generations, but the
  # process named by this lock does not. LibreOffice otherwise opens a blank,
  # inaccessible recovery shell and every Office document joins that process.
  rm -f -- "$office_profile/.lock"
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

agent_enabled claude-desktop && require_agent_environment LEMMACOMPUTER "Claude Desktop"
agent_enabled claude-cli && require_agent_environment LEMMACOMPUTER_CLAUDE_CLI "Claude CLI"
agent_enabled codex-cli && require_agent_environment LEMMACOMPUTER_CODEX_CLI "Codex CLI"
agent_enabled hermes-claw && require_agent_environment LEMMACOMPUTER_HERMES "Hermes Agent CLI"
agent_enabled hermes-desktop && require_agent_environment LEMMACOMPUTER_HERMES_DESKTOP "Hermes Agent Desktop"
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
  claude_chat_api_key="${LEMMACOMPUTER_CLAUDE_CHAT_API_KEY:-}"
  [[ "${#claude_chat_api_key}" -ge 32 ]] || {
    echo "Claude Chat API configuration is required" >&2
    exit 78
  }
fi
if agent_enabled codex-cli; then
  codex_chat_api_key="${LEMMACOMPUTER_CODEX_CHAT_API_KEY:-}"
  [[ "${#codex_chat_api_key}" -ge 32 ]] || {
    echo "Codex Chat API configuration is required" >&2
    exit 78
  }
fi

# The Kasm base profile is the authoritative initializer for the persistent
# home. Run it to completion before LemmaComputer writes configuration or starts
# any agent process. Starting agents first lets them race Kasm's `cp -rp` over
# ~/.local and can restart the whole desktop nondeterministically.
startup_phase_begin persistent-home
if ! /usr/local/libexec/lemmacomputer-workspace-home-init /home/kasm-user 1000 1000; then
  startup_phase_finish failed
  echo "Persistent workspace home initialization failed" >&2
  exit 75
fi
startup_phase_finish complete

startup_phase_begin kasm-profile
if ! setpriv --reuid=1000 --regid=1000 --init-groups \
  /dockerstartup/kasm_default_profile.sh /bin/true; then
  startup_phase_finish failed
  echo "Kasm profile initialization failed" >&2
  exit 75
fi
startup_phase_finish complete
startup_phase_begin managed-configuration

for clipboard_boolean in \
  "$LEMMACOMPUTER_CLIPBOARD_ENABLED" \
  "$LEMMACOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE" \
  "$LEMMACOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL"; do
  [[ "$clipboard_boolean" == "true" || "$clipboard_boolean" == "false" ]] || {
    echo "invalid clipboard policy boolean" >&2
    exit 78
  }
done
[[ "$LEMMACOMPUTER_CLIPBOARD_MAX_BYTES" =~ ^[0-9]+$ ]] \
  && ((LEMMACOMPUTER_CLIPBOARD_MAX_BYTES >= 1 && LEMMACOMPUTER_CLIPBOARD_MAX_BYTES <= 1048576)) || {
    echo "invalid clipboard size policy" >&2
    exit 78
  }

clipboard_local_to_workspace="$LEMMACOMPUTER_CLIPBOARD_LOCAL_TO_WORKSPACE"
clipboard_workspace_to_local="$LEMMACOMPUTER_CLIPBOARD_WORKSPACE_TO_LOCAL"
if [[ "$LEMMACOMPUTER_CLIPBOARD_ENABLED" != "true" ]]; then
  clipboard_local_to_workspace=false
  clipboard_workspace_to_local=false
fi

if agent_enabled claude-desktop; then
  case "$LEMMACOMPUTER_MODEL_ALIAS" in
    lemmacomputer-claude|claude-sonnet-4-6) model_label="Claude — organization route" ;;
    lemmacomputer-openai|claude-opus-4-6) model_label="OpenAI — organization route" ;;
    lemmacomputer-glm|claude-sonnet-4-5) model_label="GLM — organization route" ;;
    lemmacomputer-auto|lemmacomputer-assistant) model_label="Standard organization route" ;;
    *) echo "unrecognized Claude model assignment" >&2; exit 78 ;;
  esac
fi

claude_code_for_desktop_enabled=false
if agent_enabled claude-desktop && agent_enabled claude-cli; then
  claude_code_for_desktop_enabled=true
fi
install -d -o root -g root -m 0755 /etc/claude-desktop /run/lemmacomputer
install -d -o root -g root -m 0755 /etc/lemmacomputer/policy
python3 - "$LEMMACOMPUTER_SIGNED_POLICY_B64" "$LEMMACOMPUTER_POLICY_VERIFICATION_KEYS_B64" <<'PY'
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
    or bundle.get("profile") != "lemmacomputer-effective-policy/v1"
    or bundle.get("canonicalization") != "RFC8785-JCS"
    or bundle.get("algorithm") != "Ed25519"
    or keys.get("profile") != "lemmacomputer-policy-key-set/v1"
):
    raise SystemExit("invalid signed policy projection")

files = {
    "/etc/lemmacomputer/policy/signed-policy.json": bundle_text,
    "/etc/lemmacomputer/policy/verification-keys.json": keys_text,
    "/etc/lemmacomputer/policy/README.txt": (
        "This is the transparent LemmaComputer policy projection. The workspace copy is not an "
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
unset LEMMACOMPUTER_SIGNED_POLICY_B64 LEMMACOMPUTER_POLICY_VERIFICATION_KEYS_B64
python3 - \
  "$clipboard_local_to_workspace" \
  "$clipboard_workspace_to_local" \
  "$LEMMACOMPUTER_CLIPBOARD_MAX_BYTES" <<'PY'
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
  /usr/local/libexec/lemmacomputer-claude-config \
    /etc/claude-desktop/managed-settings.json \
    "$LEMMACOMPUTER_MODEL_ALIAS" \
    "$LEMMACOMPUTER_TRANSPORT_MODEL_ALIAS" \
    "$LEMMACOMPUTER_REQUESTED_SERVICE_CLASS" \
    "$LEMMACOMPUTER_ALLOWED_SERVICE_CLASSES" \
    "$model_label" \
    "$LEMMACOMPUTER_COWORK_ENABLED" \
    "$claude_code_for_desktop_enabled"
fi

rm -f /etc/claude-desktop/code-model
if [[ "$claude_code_for_desktop_enabled" == "true" ]]; then
  printf '%s\n' "$LEMMACOMPUTER_CLAUDE_CLI_MODEL_ALIAS" > /etc/claude-desktop/code-model
  chown root:root /etc/claude-desktop/code-model
  chmod 0644 /etc/claude-desktop/code-model
fi

if agent_enabled claude-cli; then
  install -d -o 1000 -g 1000 -m 0700 /home/kasm-user/.claude-cli
python3 - "$LEMMACOMPUTER_CLAUDE_CLI_MODEL_ALIAS" <<'PY'
import json
import os
import sys

model = sys.argv[1]
with open("/home/kasm-user/.claude-cli/lemmacomputer.env", "w", encoding="utf-8") as output:
    output.write(f"LEMMACOMPUTER_MODEL_ALIAS={model}\n")
with open("/home/kasm-user/.claude-cli/mcp.json", "w", encoding="utf-8") as output:
    json.dump({
        "mcpServers": {
            "lemmacomputer_connectors": {
                "type": "stdio",
                "command": "/usr/local/libexec/lemmacomputer-connectors-stdio",
                "args": [],
                "env": {"LEMMACOMPUTER_CONNECTORS_BROKER": "http://127.0.0.1:4315"},
            },
        },
    }, output, separators=(",", ":"))
    output.write("\n")
for path in ["/home/kasm-user/.claude-cli/lemmacomputer.env", "/home/kasm-user/.claude-cli/mcp.json"]:
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
model_provider = "lemmacomputer"
approval_policy = "never"
sandbox_mode = {json.dumps(sandbox_mode)}
web_search = {json.dumps(web_search)}

[model_providers.lemmacomputer]
name = "LemmaComputer governed OpenAI"
base_url = "http://127.0.0.1:4317/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false
env_http_headers = { "x-lemmacomputer-agent-instance-id" = "LEMMACOMPUTER_AGENT_INSTANCE_ID" }

[analytics]
enabled = false

[mcp_servers.lemmacomputer_connectors]
command = "/usr/local/libexec/lemmacomputer-connectors-stdio"
args = []
default_tools_approval_mode = "approve"

[mcp_servers.lemmacomputer_connectors.env]
LEMMACOMPUTER_CONNECTORS_BROKER = "http://127.0.0.1:4317"
"""
path = os.path.join(home, "config.toml")
with open(path, "w", encoding="utf-8") as output:
    output.write(document)
os.chmod(path, 0o600)
os.chown(path, 1000, 1000)
PY
}

if agent_enabled codex-cli; then
  configure_codex /home/kasm-user/.codex-cli "$LEMMACOMPUTER_CODEX_CLI_MODEL_ALIAS" "$LEMMACOMPUTER_CODEX_CLI_ALLOWED_TOOLS" "$LEMMACOMPUTER_EXECUTION_MODE"
  configure_codex /home/kasm-user/.codex-chat-sdk "$LEMMACOMPUTER_CODEX_CLI_MODEL_ALIAS" "$LEMMACOMPUTER_CODEX_CLI_ALLOWED_TOOLS" "$LEMMACOMPUTER_EXECUTION_MODE"
fi

install_agent_skill() {
  local home="$1"
  local target="$home/skills/site"
  install -d -o 1000 -g 1000 -m 0700 "$home/skills"
  rm -rf -- "$home/skills/make-a-site" "$target"
  cp -a /opt/lemmacomputer/skills/site "$target"
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
  local service_class="$3"
  local allowed_tools="$4"
  local broker_port="$5"
  local execution_mode="$6"
  install -d -o 1000 -g 1000 -m 0700 "$home"
  /opt/lemmacomputer/hermes-venv/bin/python \
    /usr/local/libexec/lemmacomputer-hermes-config \
    "$home" "$model" "$service_class" "$allowed_tools" "$broker_port" "$execution_mode" \
    /opt/lemmacomputer/hermes-agent/skills
}

sync_hermes_skills() {
  local home="$1"
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env -i \
      PATH=/opt/lemmacomputer/hermes-office-venv/bin:/opt/lemmacomputer/hermes-venv/bin:/usr/local/bin:/usr/bin:/bin \
      HOME=/home/kasm-user \
      HERMES_HOME="$home" \
      HERMES_BUNDLED_SKILLS=/opt/lemmacomputer/hermes-agent/skills \
      /opt/lemmacomputer/hermes-venv/bin/python -c \
      'from tools.skills_sync import sync_skills; sync_skills(quiet=True)'
}

agent_enabled hermes-claw \
  && configure_hermes /home/kasm-user/.hermes "$LEMMACOMPUTER_HERMES_MODEL_ALIAS" "$LEMMACOMPUTER_HERMES_REQUESTED_SERVICE_CLASS" "$LEMMACOMPUTER_HERMES_ALLOWED_TOOLS" 4314 "$LEMMACOMPUTER_EXECUTION_MODE" \
  && sync_hermes_skills /home/kasm-user/.hermes \
  && install_agent_skill /home/kasm-user/.hermes
agent_enabled hermes-desktop \
  && configure_hermes /home/kasm-user/.hermes-desktop "$LEMMACOMPUTER_HERMES_DESKTOP_MODEL_ALIAS" "$LEMMACOMPUTER_HERMES_DESKTOP_REQUESTED_SERVICE_CLASS" "$LEMMACOMPUTER_HERMES_DESKTOP_ALLOWED_TOOLS" 4316 "$LEMMACOMPUTER_EXECUTION_MODE" \
  && sync_hermes_skills /home/kasm-user/.hermes-desktop \
  && install_agent_skill /home/kasm-user/.hermes-desktop

install -d -o 1000 -g 1000 -m 0755 /home/kasm-user/.config/autostart /home/kasm-user/Desktop
rm -f /home/kasm-user/.config/autostart/claude-desktop.desktop \
  /home/kasm-user/Desktop/Claude-Desktop.desktop \
  /home/kasm-user/Desktop/Claude-CLI.desktop \
  /home/kasm-user/Desktop/Codex-Desktop.desktop \
  /home/kasm-user/Desktop/Codex-CLI.desktop \
  /home/kasm-user/Desktop/LemmaComputer-Agent.desktop \
  /home/kasm-user/Desktop/Hermes-Claw.desktop \
  /home/kasm-user/Desktop/Hermes-CLI.desktop \
  /home/kasm-user/Desktop/Hermes-Agent-CLI.desktop \
  /home/kasm-user/Desktop/Hermes-Desktop.desktop \
  /home/kasm-user/Desktop/Hermes-Agent-Desktop.desktop \
  /home/kasm-user/Desktop/Firefox.desktop \
  /home/kasm-user/Desktop/Google-Chrome.desktop \
  /home/kasm-user/Desktop/Visual-Studio-Code.desktop \
  /home/kasm-user/Desktop/Obsidian.desktop
if agent_enabled claude-desktop; then
  chmod 0755 "$(command -v claude-desktop)"
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/lemmacomputer-claude-desktop.desktop" /home/kasm-user/.config/autostart/claude-desktop.desktop
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/lemmacomputer-claude-desktop.desktop" /home/kasm-user/Desktop/Claude-Desktop.desktop
else
  chmod 0700 "$(command -v claude-desktop)"
fi
if agent_enabled claude-cli; then
  chmod 0755 /usr/local/bin/lemmacomputer-claude
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/lemmacomputer-claude-cli.desktop" /home/kasm-user/Desktop/Claude-CLI.desktop
else
  chmod 0700 /usr/local/bin/lemmacomputer-claude
fi
if agent_enabled codex-cli; then
  chmod 0755 /usr/local/bin/lemmacomputer-codex /usr/local/libexec/lemmacomputer-codex-bin
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/lemmacomputer-codex-cli.desktop" /home/kasm-user/Desktop/Codex-CLI.desktop
else
  chmod 0700 /usr/local/bin/lemmacomputer-codex /usr/local/libexec/lemmacomputer-codex-bin
fi
if agent_enabled hermes-claw; then
  chmod 0755 /usr/local/bin/lemmacomputer-hermes
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/lemmacomputer-hermes-agent-cli.desktop" /home/kasm-user/Desktop/Hermes-Agent-CLI.desktop
else
  chmod 0700 /usr/local/bin/lemmacomputer-hermes
fi
if agent_enabled hermes-desktop; then
  chmod 0755 /usr/local/bin/lemmacomputer-hermes-desktop /opt/lemmacomputer/hermes-desktop/Hermes
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/lemmacomputer-hermes-desktop.desktop" /home/kasm-user/Desktop/Hermes-Agent-Desktop.desktop
else
  chmod 0700 /usr/local/bin/lemmacomputer-hermes-desktop /opt/lemmacomputer/hermes-desktop/Hermes
fi
if agent_enabled hermes-claw || agent_enabled hermes-desktop; then
  chmod 0755 /opt/lemmacomputer/hermes-venv/bin/hermes
else
  chmod 0700 /opt/lemmacomputer/hermes-venv/bin/hermes
fi
if application_enabled firefox; then
  chmod 0755 /opt/firefox/firefox
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/lemmacomputer-firefox.desktop" /home/kasm-user/Desktop/Firefox.desktop
else
  chmod 0700 /opt/firefox/firefox
fi
if application_enabled google-chrome; then
  remove_stale_chrome_singletons
  chmod 0755 /opt/google/chrome/google-chrome
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/lemmacomputer-google-chrome.desktop" /home/kasm-user/Desktop/Google-Chrome.desktop
else
  chmod 0700 /opt/google/chrome/google-chrome
fi
if application_enabled visual-studio-code; then
  chmod 0755 /usr/share/code/code
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/lemmacomputer-visual-studio-code.desktop" /home/kasm-user/Desktop/Visual-Studio-Code.desktop
else
  chmod 0700 /usr/share/code/code
fi
if application_enabled obsidian; then
  chmod 0755 /opt/Obsidian/obsidian
  install -o 1000 -g 1000 -m 0755 "$launcher_dir/lemmacomputer-obsidian.desktop" /home/kasm-user/Desktop/Obsidian.desktop
else
  chmod 0700 /opt/Obsidian/obsidian
fi
remove_stale_libreoffice_lock

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
  # Configuration writers explicitly own the files they replace and Hermes
  # writes runtime state as UID/GID 1000. Repair only the managed directory
  # boundary; sessions, logs, caches, and employee files remain untouched.
  chown 1000:1000 "$hermes_home"
  chmod 0700 "$hermes_home"
done
chown 1000:1000 /home/kasm-user/.config /home/kasm-user/Desktop
startup_phase_finish complete
startup_phase_begin agent-brokers

start_agent_broker() {
  local prefix="$1"
  local port="$2"
  local pid_name="$3"
  local infer_single_active_agent_instance=0
  local upstream_variable="${prefix}_GATEWAY_UPSTREAM"
  local credential_variable="${prefix}_GATEWAY_CREDENTIAL"
  local control_variable="${prefix}_CONTROL_UPSTREAM"
  local bridge_variable="${prefix}_AGENT_BRIDGE_TOKEN"
  local model_variable="${prefix}_MODEL_ALIAS"
  local transport_model_variable="${prefix}_TRANSPORT_MODEL_ALIAS"
  local service_class_variable="${prefix}_REQUESTED_SERVICE_CLASS"
  local allowed_service_classes_variable="${prefix}_ALLOWED_SERVICE_CLASSES"
  # Claude Desktop and Hermes do not consistently attach the wrapper-issued
  # process header to native inference requests. Their catalogue-scoped
  # brokers may therefore recover identity only when exactly one
  # Control-verified interactive process is active. CLI brokers stay
  # header-only.
  case "$port" in
    4312|4314|4316) infer_single_active_agent_instance=1 ;;
  esac
  env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LEMMACOMPUTER_GATEWAY_UPSTREAM="${!upstream_variable}" \
    LEMMACOMPUTER_GATEWAY_CREDENTIAL="${!credential_variable}" \
    LEMMACOMPUTER_MODEL_ALIAS="${!model_variable}" \
    LEMMACOMPUTER_TRANSPORT_MODEL_ALIAS="${!transport_model_variable}" \
    LEMMACOMPUTER_REQUESTED_SERVICE_CLASS="${!service_class_variable}" \
    LEMMACOMPUTER_ALLOWED_SERVICE_CLASSES="${!allowed_service_classes_variable}" \
    LEMMACOMPUTER_MODEL_LIMITS="${LEMMACOMPUTER_MODEL_LIMITS:-}" \
    LEMMACOMPUTER_CONTROL_UPSTREAM="${!control_variable}" \
    LEMMACOMPUTER_AGENT_BRIDGE_TOKEN="${!bridge_variable}" \
    LEMMACOMPUTER_GATEWAY_LISTEN_PORT="$port" \
    LEMMACOMPUTER_INFER_SINGLE_ACTIVE_AGENT_INSTANCE="$infer_single_active_agent_instance" \
    /usr/local/libexec/lemmacomputer-gateway-proxy &
  printf '%s\n' "$!" > "/run/lemmacomputer/${pid_name}.pid"
}

agent_enabled claude-desktop && start_agent_broker LEMMACOMPUTER 4312 gateway-proxy
agent_enabled hermes-claw && start_agent_broker LEMMACOMPUTER_HERMES 4314 hermes-gateway-proxy
agent_enabled claude-cli && start_agent_broker LEMMACOMPUTER_CLAUDE_CLI 4315 claude-cli-gateway-proxy
agent_enabled hermes-desktop && start_agent_broker LEMMACOMPUTER_HERMES_DESKTOP 4316 hermes-desktop-gateway-proxy
agent_enabled codex-cli && start_agent_broker LEMMACOMPUTER_CODEX_CLI 4317 codex-cli-gateway-proxy

for credential_variable in \
  LEMMACOMPUTER_GATEWAY_CREDENTIAL LEMMACOMPUTER_GATEWAY_UPSTREAM LEMMACOMPUTER_AGENT_BRIDGE_TOKEN LEMMACOMPUTER_CONTROL_UPSTREAM \
  LEMMACOMPUTER_HERMES_GATEWAY_CREDENTIAL LEMMACOMPUTER_HERMES_GATEWAY_UPSTREAM LEMMACOMPUTER_HERMES_AGENT_BRIDGE_TOKEN LEMMACOMPUTER_HERMES_CONTROL_UPSTREAM \
  LEMMACOMPUTER_CLAUDE_CLI_GATEWAY_CREDENTIAL LEMMACOMPUTER_CLAUDE_CLI_GATEWAY_UPSTREAM LEMMACOMPUTER_CLAUDE_CLI_AGENT_BRIDGE_TOKEN LEMMACOMPUTER_CLAUDE_CLI_CONTROL_UPSTREAM \
  LEMMACOMPUTER_HERMES_DESKTOP_GATEWAY_CREDENTIAL LEMMACOMPUTER_HERMES_DESKTOP_GATEWAY_UPSTREAM LEMMACOMPUTER_HERMES_DESKTOP_AGENT_BRIDGE_TOKEN LEMMACOMPUTER_HERMES_DESKTOP_CONTROL_UPSTREAM \
  LEMMACOMPUTER_CODEX_CLI_GATEWAY_CREDENTIAL LEMMACOMPUTER_CODEX_CLI_GATEWAY_UPSTREAM LEMMACOMPUTER_CODEX_CLI_AGENT_BRIDGE_TOKEN LEMMACOMPUTER_CODEX_CLI_CONTROL_UPSTREAM; do
  unset "$credential_variable"
done

if [[ -n "${HTTPS_PROXY:-}" ]]; then
  env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LEMMACOMPUTER_EGRESS_UPSTREAM="$HTTPS_PROXY" \
    /usr/local/libexec/lemmacomputer-egress-broker &
  egress_broker_pid=$!
  printf '%s\n' "$egress_broker_pid" > /run/lemmacomputer/egress-broker.pid
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
    if curl -fsS "http://127.0.0.1:${broker_port}/healthz" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  curl -fsS "http://127.0.0.1:${broker_port}/healthz" >/dev/null
done
startup_phase_finish complete
startup_phase_begin selected-agent-runtimes

if agent_enabled hermes-claw; then
  install -d -o 1000 -g 1000 -m 0700 /home/kasm-user/.hermes/logs
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env -i \
      PATH=/opt/lemmacomputer/hermes-office-venv/bin:/opt/lemmacomputer/hermes-venv/bin:/usr/local/bin:/usr/bin:/bin \
      HOME=/home/kasm-user \
      USER=kasm-user \
      HERMES_HOME=/home/kasm-user/.hermes \
      HERMES_BUNDLED_SKILLS=/opt/lemmacomputer/hermes-agent/skills \
      NODE_PATH=/opt/lemmacomputer/hermes-office-node/node_modules \
      TZ="${TZ:-Etc/UTC}" \
      LEMMACOMPUTER_TIME_ZONE="$LEMMACOMPUTER_TIME_ZONE" \
      OPENAI_API_KEY=lemmacomputer-loopback-broker \
      LEMMACOMPUTER_CONNECTORS_BROKER=http://127.0.0.1:4314 \
      LEMMACOMPUTER_SITES_BROKER=http://127.0.0.1:4314 \
      API_SERVER_ENABLED=true \
      API_SERVER_HOST=127.0.0.1 \
      API_SERVER_PORT=8652 \
      API_SERVER_KEY="$hermes_api_key" \
      HTTP_PROXY="${HTTP_PROXY:-}" \
      HTTPS_PROXY="${HTTPS_PROXY:-}" \
      http_proxy="${http_proxy:-}" \
      https_proxy="${https_proxy:-}" \
      NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,lemmacomputer-control,litellm}" \
      no_proxy="${no_proxy:-localhost,127.0.0.1,lemmacomputer-control,litellm}" \
      /opt/lemmacomputer/hermes-venv/bin/hermes gateway run \
      >>/run/lemmacomputer/hermes-gateway-bootstrap.log 2>&1 &
  printf '%s\n' "$!" > /run/lemmacomputer/hermes-gateway.pid
  # This probe covers only the Hermes runtime. Connector discovery is an
  # optional capability and must never participate in workspace bootstrap.
  for _ in $(seq 1 600); do
    if curl -fsS "http://127.0.0.1:8652/health" >/dev/null 2>&1; then break; fi
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
    "/home/kasm-user/.lemmacomputer-chat/${agent}" \
    /home/kasm-user/.claude-chat-sdk
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env -i \
      PATH=/opt/lemmacomputer/agent-chat-venv/bin:/usr/local/bin:/usr/bin:/bin \
      HOME=/home/kasm-user \
      USER=kasm-user \
      LEMMACOMPUTER_CHAT_AGENT="$agent" \
      LEMMACOMPUTER_CHAT_API_KEY="$api_key" \
      LEMMACOMPUTER_CHAT_MODEL_ALIAS="$model" \
      LEMMACOMPUTER_CHAT_ALLOWED_TOOLS="$allowed_tools" \
      LEMMACOMPUTER_EXECUTION_MODE="$LEMMACOMPUTER_EXECUTION_MODE" \
      TZ="${TZ:-Etc/UTC}" \
      LEMMACOMPUTER_TIME_ZONE="$LEMMACOMPUTER_TIME_ZONE" \
      LEMMACOMPUTER_CHAT_BROKER="http://127.0.0.1:${broker_port}" \
      LEMMACOMPUTER_SITES_BROKER="http://127.0.0.1:${broker_port}" \
      LEMMACOMPUTER_CHAT_PORT="$port" \
      LEMMACOMPUTER_HERMES_CHAT_URL="$hermes_url" \
      LEMMACOMPUTER_HERMES_CHAT_KEY="$hermes_key" \
      /opt/lemmacomputer/agent-chat-venv/bin/python \
      /usr/local/libexec/lemmacomputer-agent-chat \
      >>"/run/lemmacomputer/${agent}-chat.log" 2>&1 &
  printf '%s\n' "$!" > "/run/lemmacomputer/${agent}-chat.pid"
  for _ in $(seq 1 200); do
    if curl -fsS -H "authorization: Bearer ${api_key}" "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  curl -fsS -H "authorization: Bearer ${api_key}" "http://127.0.0.1:${port}/health" >/dev/null
}

if agent_enabled hermes-claw; then
  start_sdk_chat_adapter \
    hermes-claw 8642 4314 \
    "$LEMMACOMPUTER_HERMES_MODEL_ALIAS" \
    "$LEMMACOMPUTER_HERMES_ALLOWED_TOOLS" \
    "$hermes_api_key" \
    http://127.0.0.1:8652 \
    "$hermes_api_key"
  unset API_SERVER_KEY hermes_api_key
fi
if agent_enabled claude-cli; then
  start_sdk_chat_adapter \
    claude-cli 8643 4315 \
    "$LEMMACOMPUTER_CLAUDE_CLI_MODEL_ALIAS" \
    "$LEMMACOMPUTER_CLAUDE_CLI_ALLOWED_TOOLS" \
    "$claude_chat_api_key"
  unset LEMMACOMPUTER_CLAUDE_CHAT_API_KEY claude_chat_api_key
fi
if agent_enabled codex-cli; then
  start_sdk_chat_adapter \
    codex-cli 8644 4317 \
    "$LEMMACOMPUTER_CODEX_CLI_MODEL_ALIAS" \
    "$LEMMACOMPUTER_CODEX_CLI_ALLOWED_TOOLS" \
    "$codex_chat_api_key"
  unset LEMMACOMPUTER_CODEX_CHAT_API_KEY codex_chat_api_key
fi
startup_phase_finish complete
startup_phase_begin scheduling

cron_supervisor_pid=""
if [[ "$LEMMACOMPUTER_EXECUTION_MODE" == "disposable-open" ]]; then
  install -d -o 1000 -g 1000 -m 0700 \
    /home/kasm-user/.lemmacomputer \
    /home/kasm-user/.lemmacomputer/logs \
    /home/kasm-user/.lemmacomputer/locks \
    /home/kasm-user/.lemmacomputer/scripts \
    /home/kasm-user/.lemmacomputer/results
  install -o 1000 -g 1000 -m 0644 \
    /usr/local/share/lemmacomputer/SCHEDULING.md \
    /home/kasm-user/.lemmacomputer/SCHEDULING.md
  install -o 1000 -g 1000 -m 0600 /dev/null /run/lemmacomputer/cron-events.log
  canonical_crontab="/home/kasm-user/.lemmacomputer/crontab"
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
    printf '%s\n' '{"event":"crontab_restore","result":"installed"}' >> /run/lemmacomputer/cron-events.log
  else
    /usr/bin/crontab -u kasm-user -r 2>/dev/null || true
    printf '%s\n' '{"event":"crontab_restore","result":"empty"}' >> /run/lemmacomputer/cron-events.log
  fi
  (
    set +e
    /usr/sbin/cron -f -L 0 >>/run/lemmacomputer/cron-daemon.log 2>&1
    cron_status=$?
    rm -f /run/lemmacomputer/workspace-ready
    printf '{"event":"cron_daemon_exit","exitStatus":%d}\n' "$cron_status" >> /run/lemmacomputer/cron-events.log
    kill -TERM 1 2>/dev/null || true
    exit "$cron_status"
  ) &
  cron_supervisor_pid="$!"
  printf '%s\n' "$cron_supervisor_pid" > /run/lemmacomputer/cron-supervisor.pid
  sleep 0.2
  kill -0 "$cron_supervisor_pid"
else
  /usr/bin/crontab -u kasm-user -r 2>/dev/null || true
fi

[[ -z "$cron_supervisor_pid" ]] || kill -0 "$cron_supervisor_pid"
startup_phase_finish complete
startup_phase_begin desktop-runtime
touch /run/lemmacomputer/workspace-ready

exec setpriv --reuid=1000 --regid=1000 --init-groups \
  /dockerstartup/vnc_startup.sh \
  /dockerstartup/kasm_startup.sh "$@"
