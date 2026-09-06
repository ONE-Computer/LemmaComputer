#!/usr/bin/env bash
set -euo pipefail

profile="${1:?Claude profile directory is required}"
uid="${2:-1000}"
gid="${3:-1000}"
[[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || exit 78

# install -d owns only its final component. Prepare both managed parents
# explicitly, including on cache hits, without traversing employee data.
for directory in "$profile" "$profile/claude-code"; do
  if [[ -L "$directory" || ( -e "$directory" && ! -d "$directory" ) ]]; then
    echo "Claude profile cache must use real directories" >&2
    exit 78
  fi
  if [[ ! -d "$directory" ]]; then
    install -d -o "$uid" -g "$gid" -m 0755 "$directory"
  elif [[ "$(stat -c %u "$directory")" != "$uid" || "$(stat -c %g "$directory")" != "$gid" ]]; then
    chown "$uid:$gid" "$directory"
  fi
done
