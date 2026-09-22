#!/usr/bin/env bash
set -euo pipefail

IMAGE_RETENTION_HOURS="${IMAGE_RETENTION_HOURS:-720}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/myrailway/backups}"

echo "Pruning builder cache older than 7 days..."
docker builder prune -af --filter "until=168h" || true

echo "Pruning dangling image layers older than 7 days..."
docker image prune -f --filter "until=168h" || true

echo "Pruning unused My Railway release images older than ${IMAGE_RETENTION_HOURS} hours..."
docker image prune -af   --filter "until=${IMAGE_RETENTION_HOURS}h"   --filter "label=myrailway.managed=true" || true

echo "Pruning stopped containers older than 24 hours..."
docker container prune -f --filter "until=24h" || true

if [ -d "$BACKUP_DIR" ]; then
  echo "Deleting local backup files older than ${BACKUP_RETENTION_DAYS} days..."
  find "$BACKUP_DIR" -type f -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete || true
fi

docker system df
