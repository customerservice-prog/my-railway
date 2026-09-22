#!/usr/bin/env bash
set -euo pipefail
ACTION="${1:-status}"
case "$ACTION" in
  status)
    docker compose ps
    echo
    docker ps --filter label=myrailway.service --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
    ;;
  logs)
    docker compose logs --tail=200 control worker agent
    ;;
  backup)
    docker compose exec platform-backup /app/scripts/backup-platform.sh
    ;;
  stop-service)
    SERVICE="${2:?usage: scripts/emergency.sh stop-service SERVICE_ID}"
    docker ps -aq --filter "label=myrailway.service=$SERVICE" | xargs -r docker rm -f
    SAFE_SERVICE="$(printf '%s' "$SERVICE" | tr '[:upper:]_' '[:lower:]-')"
    rm -f "data/routes/${SAFE_SERVICE}.yml"
    ;;
  restart-platform)
    docker compose restart control worker agent
    ;;
  *)
    echo "Usage: $0 {status|logs|backup|stop-service SERVICE_ID|restart-platform}"
    exit 2
    ;;
esac
