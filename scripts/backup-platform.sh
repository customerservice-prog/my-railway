#!/usr/bin/env bash
set -euo pipefail
umask 077

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${BACKUP_DIR:-/var/lib/myrailway/backups}"
DIR="$BACKUP_ROOT/platform"
RETENTION="${BACKUP_RETENTION_DAYS:-30}"
mkdir -p "$DIR"

HOST="${DATABASE_HOST:-postgres}"
DB="${DATABASE_NAME:-myrailway}"
USER="${DATABASE_USER:-myrailway}"
OUT="$DIR/control-${STAMP}.sql.gz"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DB_CONTAINER="$(docker ps --filter label=com.docker.compose.service=postgres --filter status=running --format '{{.ID}}' | head -n1)"
  if [ -z "$DB_CONTAINER" ]; then
    echo "Unable to locate the running PostgreSQL container for a version-matched backup." >&2
    exit 1
  fi
  docker exec -e "PGPASSWORD=$PGPASSWORD" "$DB_CONTAINER" \
    pg_dump -U "$USER" -d "$DB" --no-owner --no-acl | gzip -9 > "$OUT"
else
  pg_dump -h "$HOST" -U "$USER" -d "$DB" --no-owner --no-acl | gzip -9 > "$OUT"
fi
(
  cd "$DIR"
  sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256"
)

find "$DIR" -type f -name 'control-*.sql.gz' -mtime "+$RETENTION" -delete
find "$DIR" -type f -name 'control-*.sql.gz.sha256' -mtime "+$RETENTION" -delete
find "$BACKUP_ROOT" -maxdepth 1 -type f \( -name 'bak_*.tar.gz' -o -name 'bak_*.dump' -o -name 'bak_*.rdb' \) -mtime "+$RETENTION" -delete

BACKUP_ID="bak_platform_${STAMP//[^a-zA-Z0-9]/}"
BACKUP_SIZE="$(stat -c '%s' "$OUT")"
BACKUP_LOCATION="/var/lib/myrailway/backups/platform/$(basename "$OUT")"

record_backup() {
  local sql
  sql="INSERT INTO backups(id,service_id,server_id,kind,location,status,size_bytes,created_at,completed_at)
       VALUES('$BACKUP_ID',NULL,NULL,'platform','$BACKUP_LOCATION','completed',$BACKUP_SIZE,now(),now())
       ON CONFLICT(id) DO UPDATE SET location=excluded.location,status='completed',size_bytes=excluded.size_bytes,completed_at=now();"

  if [ -n "${DB_CONTAINER:-}" ]; then
    docker exec -e "PGPASSWORD=$PGPASSWORD" "$DB_CONTAINER" \
      psql -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 -c "$sql" >/dev/null 2>&1
  else
    PGPASSWORD="$PGPASSWORD" psql -h "$HOST" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 -c "$sql" >/dev/null 2>&1
  fi
}

if ! record_backup; then
  echo "Warning: backup file was created, but its metadata could not be recorded yet (the control-plane schema may still be initializing)." >&2
fi

echo "Platform backup created: $OUT"

if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  if [ -z "${RESTIC_PASSWORD:-}" ]; then
    echo "RESTIC_REPOSITORY is configured but RESTIC_PASSWORD is blank." >&2
    exit 1
  fi
  restic backup "$BACKUP_ROOT"
  restic forget \
    --keep-daily "${RESTIC_KEEP_DAILY:-30}" \
    --keep-weekly "${RESTIC_KEEP_WEEKLY:-8}" \
    --keep-monthly "${RESTIC_KEEP_MONTHLY:-12}" \
    --prune
fi
