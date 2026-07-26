#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
image_name=${ONECOMPUTER_WORKSPACE_IMAGE_NAME:-onecomputer/workspace:dev}

docker build --file "$repo_dir/docker/Dockerfile.workspace" --tag "$image_name" "$repo_dir"
image_id=$(docker image inspect "$image_name" --format '{{.Id}}')
printf '%s\n' "Built $image_name"
printf '%s\n' "Pin ONECOMPUTER_WORKSPACE_IMAGE=$image_id"
