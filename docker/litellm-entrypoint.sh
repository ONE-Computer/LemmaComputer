#!/bin/sh
set -eu

# sitecustomize installs the patch in every Python process. Run the same check
# explicitly here because Python reports a sitecustomize import error but may
# otherwise continue starting the application.
python /app/lemmacomputer_remote_mcp_egress.py
exec /app/docker/prod_entrypoint.sh "$@"
