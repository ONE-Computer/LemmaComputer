#!/usr/bin/env bash
set -euo pipefail

workspace_home="${1:-/home/kasm-user}"
workspace_uid="${2:-1000}"
workspace_gid="${3:-1000}"

[[ "$workspace_uid" =~ ^[0-9]+$ && "$workspace_gid" =~ ^[0-9]+$ ]] || {
  echo "invalid workspace home ownership contract" >&2
  exit 78
}
[[ -d "$workspace_home" && ! -L "$workspace_home" ]] || {
  echo "workspace home must be a directory, not a symbolic link" >&2
  exit 78
}

# Docker creates a new named-volume root as root:root. Change only that mount
# point so Kasm can initialize it as the workspace user. Never recurse into the
# persistent home: existing application state and user files are not startup
# migration targets.
if [[ "$(stat -c %u "$workspace_home")" != "$workspace_uid" \
  || "$(stat -c %g "$workspace_home")" != "$workspace_gid" ]]; then
  chown "${workspace_uid}:${workspace_gid}" "$workspace_home"
fi
