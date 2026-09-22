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

pg_dump -h "$HOST" -U "$USER" -d "$DB" --no-owner --no-acl | gzip -9 > "$OUT"
sha256sum "$OUT" > "$OUT.sha256"

find "$DIR" -type f -name 'control-*.sql.gz' -mtime "+$RETENTION" -delete
find "$DIR" -type f -name 'control-*.sql.gz.sha256' -mtime "+$RETENTION" -delete
find "$BACKUP_ROOT" -maxdepth 1 -type f \( -name 'bak_*.tar.gz' -o -name 'bak_*.dump' -o -name 'bak_*.rdb' \) -mtime "+$RETENTION" -delete

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
