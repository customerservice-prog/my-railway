#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

cleanup() {
  set +e
  if [ -n "${ORIGINAL_ORIGIN:-}" ]; then git remote set-url origin "$ORIGINAL_ORIGIN" >/dev/null 2>&1 || true; fi
  if [ -n "${BASE_SHA:-}" ]; then git checkout -B main "$BASE_SHA" >/dev/null 2>&1 || true; fi
  git update-ref -d refs/heads/ci-self-update >/dev/null 2>&1 || true
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

BASE_SHA="$(git rev-parse HEAD)"
ORIGINAL_ORIGIN="$(git remote get-url origin)"
ROOT="$(pwd)"
LOCAL_REMOTE="$ROOT/data/self-update-origin.git"
mkdir -p "$ROOT/data"

git config user.name "My Railway CI"
git config user.email "ci@my-railway.local"

# Build a second immutable commit without moving the current checkout.
TMP_INDEX="$(mktemp)"
rm -f "$TMP_INDEX"
BLOB="$(printf 'self-update-integration-ok\n' | git hash-object -w --stdin)"
GIT_INDEX_FILE="$TMP_INDEX" git read-tree "$BASE_SHA^{tree}"
GIT_INDEX_FILE="$TMP_INDEX" git update-index --add --cacheinfo "100644,$BLOB,SELF_UPDATE_INTEGRATION_MARKER"
TARGET_TREE="$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)"
TARGET_SHA="$(printf 'test: synthetic self-update target\n' | git commit-tree "$TARGET_TREE" -p "$BASE_SHA")"
rm -f "$TMP_INDEX"

git update-ref refs/heads/ci-self-update "$TARGET_SHA"
rm -rf "$LOCAL_REMOTE"
git clone --bare . "$LOCAL_REMOTE" >/dev/null
git remote set-url origin "file://$LOCAL_REMOTE"

SESSION_SECRET="$(openssl rand -hex 48)"
SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32 | tr -d '\n')"
AGENT_TOKEN="$(openssl rand -hex 32)"
UPDATER_TOKEN="$(openssl rand -hex 32)"
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"

cat > .env <<EOF
PORT=8080
NODE_ENV=production
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
COOKIE_SECURE=false
DATABASE_URL=postgresql://myrailway:$POSTGRES_PASSWORD@postgres:5432/myrailway
REDIS_URL=redis://redis:6379
SESSION_SECRET=$SESSION_SECRET
SECRET_ENCRYPTION_KEY=$SECRET_ENCRYPTION_KEY
ADMIN_BOOTSTRAP_PASSWORD=
ADMIN_BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN
GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)
GITHUB_TOKEN=
AGENT_TOKEN=$AGENT_TOKEN
CONTROL_PLANE_URL=http://control:8080
SERVER_ID=local-runtime-01
SERVER_NAME=Self Update CI Runtime
REGISTRY_URL=local
PLATFORM_NETWORK=myrailway
HOST_PROJECT_DIR=$ROOT
PLATFORM_UPDATER_URL=http://updater:8090
PLATFORM_UPDATER_TOKEN=$UPDATER_TOKEN
PLATFORM_UPDATE_REF=ci-self-update
TRAEFIK_ROUTES_DIR=/var/lib/myrailway/routes
BACKUP_DIR=/var/lib/myrailway/backups
BACKUP_VOLUME_NAME=myrailway-backups
PUBLIC_IP=
PLATFORM_HOST=
DEPLOY_GRACE_SECONDS=1
DEPLOY_HEALTH_RETRIES=6
DEPLOY_HEALTH_INTERVAL_MS=500
AUTO_MIGRATE=true
AUTO_ROLLBACK=false
AUTO_BACKUPS=false
ALERT_WEBHOOK_URL=
ACME_EMAIL=ci@example.com
RESTIC_REPOSITORY=
RESTIC_PASSWORD=
EOF

docker compose up -d --no-build postgres redis updater control platform-backup

for _ in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8080/healthz >/dev/null

STATUS="$(curl -sS -o /tmp/selfupd-bootstrap.json -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d "{\"email\":\"update-ci@example.com\",\"password\":\"update-ci-password-123456\",\"setupToken\":\"$BOOTSTRAP_TOKEN\"}" \
  http://127.0.0.1:8080/api/auth/bootstrap)"
test "$STATUS" = "201"

STATUS="$(curl -sS -c /tmp/selfupd-cookies.txt -o /tmp/selfupd-login.json -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d '{"email":"update-ci@example.com","password":"update-ci-password-123456"}' \
  http://127.0.0.1:8080/api/auth/login)"
test "$STATUS" = "200"

curl -fsS -b /tmp/selfupd-cookies.txt http://127.0.0.1:8080/api/platform/update/info >/tmp/selfupd-info.json
grep -q "$BASE_SHA" /tmp/selfupd-info.json
grep -q "$TARGET_SHA" /tmp/selfupd-info.json
grep -q '"updateAvailable":true' /tmp/selfupd-info.json

STATUS="$(curl -sS -b /tmp/selfupd-cookies.txt -o /tmp/selfupd-start.json -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d '{}' \
  http://127.0.0.1:8080/api/platform/update)"
test "$STATUS" = "202"

COMPLETED=false
for _ in $(seq 1 240); do
  BODY="$(curl -sS -b /tmp/selfupd-cookies.txt http://127.0.0.1:8080/api/platform/update/status 2>/dev/null || true)"
  if printf '%s' "$BODY" | grep -q '"status":"completed"'; then
    COMPLETED=true
    printf '%s\n' "$BODY" >/tmp/selfupd-final.json
    break
  fi
  if printf '%s' "$BODY" | grep -q '"status":"failed"'; then
    printf '%s\n' "$BODY" >&2
    exit 1
  fi
  sleep 2
done

if [ "$COMPLETED" != true ]; then
  echo "Timed out waiting for actual platform self-update." >&2
  docker compose logs --tail=200 updater control >&2 || true
  exit 1
fi

test "$(git rev-parse HEAD)" = "$TARGET_SHA"
test -f SELF_UPDATE_INTEGRATION_MARKER
grep -q 'self-update-integration-ok' SELF_UPDATE_INTEGRATION_MARKER
curl -fsS http://127.0.0.1:8080/healthz >/dev/null

# The updater itself is replaced last; give the helper time to complete.
sleep 8
docker compose ps updater | grep -q 'Up'

echo "My Railway actual self-update integration test passed: $BASE_SHA -> $TARGET_SHA"
