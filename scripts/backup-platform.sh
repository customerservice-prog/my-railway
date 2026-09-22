#!/usr/bin/env bash
set -euo pipefail
umask 077
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="${BACKUP_DIR:-/var/lib/myrailway/backups}/platform"
mkdir -p "$DIR"
HOST="${DATABASE_HOST:-postgres}"
DB="${DATABASE_NAME:-myrailway}"
USER="${DATABASE_USER:-myrailway}"
OUT="$DIR/control-${STAMP}.sql.gz"
pg_dump -h "$HOST" -U "$USER" -d "$DB" --no-owner --no-acl | gzip -9 > "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
find "$DIR" -type f -name 'control-*.sql.gz' -mtime +30 -delete
find "$DIR" -type f -name 'control-*.sql.gz.sha256' -mtime +30 -delete
RETENTION="${BACKUP_RETENTION_DAYS:-30}"
find "${BACKUP_DIR:-/var/lib/myrailway/backups}" -maxdepth 1 -type f \( -name 'bak_*.tar.gz' -o -name 'bak_*.dump' -o -name 'bak_*.rdb' \) -mtime "+$RETENTION" -delete
echo "Platform backup created: $OUT"
if [ -n "${RESTIC_REPOSITORY:-}" ] && command -v restic >/dev/null 2>&1; then restic backup "$DIR"; fi
