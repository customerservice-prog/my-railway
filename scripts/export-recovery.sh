#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

FULL=false
OUTPUT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --full) FULL=true; shift ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--full] [--output FILE.enc]"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo ".env is required." >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon is required." >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT="${OUTPUT:-my-railway-recovery-${STAMP}.tar.gz.enc}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; unset RECOVERY_BUNDLE_PASSWORD' EXIT
mkdir -p "$TMP/bundle/backups"

echo "Creating fresh control-plane backup..."
./scripts/emergency.sh backup >/dev/null

cp .env "$TMP/bundle/.env"
chmod 600 "$TMP/bundle/.env"
[ -f data/acme.json ] && cp data/acme.json "$TMP/bundle/acme.json"
[ -d data/routes ] && cp -a data/routes "$TMP/bundle/routes"
git rev-parse HEAD > "$TMP/bundle/git-commit.txt"
docker compose config > "$TMP/bundle/docker-compose.resolved.yml"
date -u +%FT%TZ > "$TMP/bundle/exported-at.txt"

if [ "$FULL" = true ]; then
  echo "Copying complete backup volume..."
  docker run --rm \
    -v myrailway-backups:/source:ro \
    -v "$TMP/bundle/backups:/dest" \
    alpine:3.20 sh -lc 'cp -a /source/. /dest/'
else
  echo "Copying latest control-plane backup..."
  LATEST="$(
    docker run --rm -v myrailway-backups:/source:ro alpine:3.20 \
      sh -lc "find /source/platform -type f -name 'control-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-" \
      || true
  )"
  if [ -n "$LATEST" ]; then
    BASENAME="$(basename "$LATEST")"
    docker run --rm \
      -v myrailway-backups:/source:ro \
      -v "$TMP/bundle/backups:/dest" \
      alpine:3.20 sh -lc "cp '$LATEST' '/dest/$BASENAME'; [ ! -f '$LATEST.sha256' ] || cp '$LATEST.sha256' '/dest/$BASENAME.sha256'"
  else
    echo "Warning: no platform database backup was found." >&2
  fi
fi

cat >"$TMP/bundle/README-RECOVERY.txt" <<'EOF'
SECURITY-SENSITIVE RECOVERY BUNDLE

This archive can contain:
- production .env values
- SECRET_ENCRYPTION_KEY
- GitHub App credentials
- control-plane database backup
- ACME certificate state
- active routing configuration
- optional full application/database backup set

Keep the encrypted archive in a separate protected failure domain.
Never commit or share its decrypted contents.
EOF

tar -C "$TMP" -czf "$TMP/recovery.tar.gz" bundle

if [ -z "${RECOVERY_BUNDLE_PASSWORD:-}" ]; then
  if [ ! -t 0 ]; then
    echo "Set RECOVERY_BUNDLE_PASSWORD when running non-interactively." >&2
    exit 1
  fi
  read -rsp "Recovery bundle password: " PASS
  echo
  read -rsp "Confirm password: " PASS2
  echo
  [ "$PASS" = "$PASS2" ] || { echo "Passwords do not match." >&2; exit 1; }
  export RECOVERY_BUNDLE_PASSWORD="$PASS"
fi

[ "${#RECOVERY_BUNDLE_PASSWORD}" -ge 16 ] || {
  echo "Use a recovery password of at least 16 characters." >&2
  exit 1
}

openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$TMP/recovery.tar.gz" \
  -out "$OUTPUT" \
  -pass env:RECOVERY_BUNDLE_PASSWORD

chmod 600 "$OUTPUT"
sha256sum "$OUTPUT" > "$OUTPUT.sha256"

echo "Encrypted recovery bundle created:"
echo "  $OUTPUT"
echo "  $OUTPUT.sha256"
echo
echo "To decrypt later:"
echo "  RECOVERY_BUNDLE_PASSWORD='...' openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in '$OUTPUT' -out recovery.tar.gz -pass env:RECOVERY_BUNDLE_PASSWORD"
