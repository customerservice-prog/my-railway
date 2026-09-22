#!/usr/bin/env bash
set -euo pipefail
echo "Pruning builder cache older than 7 days..."
docker builder prune -af --filter "until=168h" || true
echo "Pruning dangling image layers older than 7 days (retained release images are preserved)..."
docker image prune -f --filter "until=168h" || true
echo "Pruning stopped containers..."
docker container prune -f --filter "until=24h" || true
docker system df
