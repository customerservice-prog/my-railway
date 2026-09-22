#!/usr/bin/env bash
set -euo pipefail
echo "Pruning builder cache older than 7 days..."
docker builder prune -af --filter "until=168h" || true
echo "Pruning unused images older than 7 days..."
docker image prune -af --filter "until=168h" || true
echo "Pruning stopped containers..."
docker container prune -f || true
docker system df
