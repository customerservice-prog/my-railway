#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0
WARN=0

pass(){ printf 'PASS  %s\n' "$1"; }
warn(){ printf 'WARN  %s\n' "$1"; WARN=$((WARN+1)); }
fail(){ printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }

get_env() {
  local key="$1"
  if [ -f .env ]; then
    grep -E "^${key}=" .env | tail -n1 | cut -d= -f2- || true
  fi
}

echo "My Railway doctor"
echo "================="

command -v docker >/dev/null 2>&1 && pass "Docker is installed" || fail "Docker is not installed"
docker info >/dev/null 2>&1 && pass "Docker daemon is reachable" || fail "Docker daemon is not reachable"
docker compose version >/dev/null 2>&1 && pass "Docker Compose v2 is available" || fail "Docker Compose v2 is unavailable"
[ -f .env ] && pass ".env exists" || fail ".env is missing"
docker compose config --quiet >/dev/null 2>&1 && pass "docker-compose.yml validates" || fail "docker-compose.yml does not validate"

SESSION_SECRET="$(get_env SESSION_SECRET)"
ENC_KEY="$(get_env SECRET_ENCRYPTION_KEY)"
AGENT_TOKEN="$(get_env AGENT_TOKEN)"
PG_PASS="$(get_env POSTGRES_PASSWORD)"
WEBHOOK_SECRET="$(get_env GITHUB_WEBHOOK_SECRET)"
BOOTSTRAP_TOKEN="$(get_env ADMIN_BOOTSTRAP_TOKEN)"
PLATFORM_HOST="$(get_env PLATFORM_HOST)"
PUBLIC_IP="$(get_env PUBLIC_IP)"
COOKIE_SECURE="$(get_env COOKIE_SECURE)"
ACME_EMAIL="$(get_env ACME_EMAIL)"
RESTIC_REPOSITORY="$(get_env RESTIC_REPOSITORY)"
RESTIC_PASSWORD="$(get_env RESTIC_PASSWORD)"

[ "${#SESSION_SECRET}" -ge 32 ] && [[ "$SESSION_SECRET" != replace-* ]] \
  && pass "SESSION_SECRET is populated" || fail "SESSION_SECRET is missing/placeholder/too short"

if [ -n "$ENC_KEY" ]; then
  KEY_BYTES="$(printf '%s' "$ENC_KEY" | base64 -d 2>/dev/null | wc -c | tr -d ' ' || true)"
else
  KEY_BYTES=0
fi
[ "$KEY_BYTES" = "32" ] && pass "SECRET_ENCRYPTION_KEY decodes to 32 bytes" \
  || fail "SECRET_ENCRYPTION_KEY must be exactly 32 decoded bytes"

[ "${#AGENT_TOKEN}" -ge 32 ] && [[ "$AGENT_TOKEN" != replace-* ]] \
  && pass "AGENT_TOKEN is populated" || fail "AGENT_TOKEN is missing/placeholder/too short"

[ "${#PG_PASS}" -ge 20 ] && pass "POSTGRES_PASSWORD is populated" \
  || fail "POSTGRES_PASSWORD is missing or too short"

[ "${#WEBHOOK_SECRET}" -ge 32 ] && [ "$WEBHOOK_SECRET" != "replace-me" ] \
  && pass "GITHUB_WEBHOOK_SECRET is populated" || fail "GITHUB_WEBHOOK_SECRET is missing/placeholder/too short"

[ "${#BOOTSTRAP_TOKEN}" -ge 32 ] && [[ "$BOOTSTRAP_TOKEN" != replace-* ]] \
  && pass "ADMIN_BOOTSTRAP_TOKEN is populated" || fail "ADMIN_BOOTSTRAP_TOKEN is missing/placeholder/too short"

if [ -n "$PLATFORM_HOST" ]; then
  pass "PLATFORM_HOST is configured: $PLATFORM_HOST"
  [ "$COOKIE_SECURE" = "true" ] && pass "COOKIE_SECURE is enabled" || fail "COOKIE_SECURE should be true with PLATFORM_HOST"
else
  warn "PLATFORM_HOST is blank; dashboard is localhost-only"
fi

[ -n "$PUBLIC_IP" ] && pass "PUBLIC_IP is configured: $PUBLIC_IP" || warn "PUBLIC_IP is blank; A-record verification will not work"
[ -n "$ACME_EMAIL" ] && [ "$ACME_EMAIL" != "admin@example.com" ] \
  && pass "ACME_EMAIL is configured" || warn "ACME_EMAIL is still blank/default"

if [ -f data/acme.json ]; then
  MODE="$(stat -c '%a' data/acme.json 2>/dev/null || true)"
  [ "$MODE" = "600" ] && pass "ACME storage is mode 600" || fail "data/acme.json should be mode 600 (found ${MODE:-unknown})"
else
  fail "data/acme.json is missing"
fi

if [ -n "$PLATFORM_HOST" ] && [ -n "$PUBLIC_IP" ]; then
  RESOLVED="$(dig +short A "$PLATFORM_HOST" 2>/dev/null | tail -n1 || true)"
  if [ "$RESOLVED" = "$PUBLIC_IP" ]; then
    pass "Control-plane DNS resolves to PUBLIC_IP"
  elif [ -z "$RESOLVED" ]; then
    warn "Control-plane DNS has no A record yet"
  else
    warn "Control-plane DNS resolves to $RESOLVED, expected $PUBLIC_IP"
  fi
fi

ROOT_AVAIL_KB="$(df -Pk / | awk 'NR==2 {print $4}')"
if [ "${ROOT_AVAIL_KB:-0}" -ge 10485760 ]; then
  pass "At least 10 GB disk space is free"
else
  warn "Less than 10 GB disk space is free"
fi

docker network inspect myrailway >/dev/null 2>&1 \
  && pass "Private Docker network exists" || warn "Private Docker network does not exist yet (normal before first compose up)"

docker volume inspect myrailway-backups >/dev/null 2>&1 \
  && pass "Backup Docker volume exists" || warn "Backup Docker volume does not exist yet"

curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 \
  && pass "Control plane health endpoint is OK" || warn "Control plane is not currently healthy on localhost:8080"

if [ -n "$RESTIC_REPOSITORY" ]; then
  if [ -z "$RESTIC_PASSWORD" ]; then
    fail "RESTIC_REPOSITORY is set but RESTIC_PASSWORD is blank"
  elif docker image inspect my-railway:local >/dev/null 2>&1; then
    if docker run --rm my-railway:local restic version >/dev/null 2>&1; then
      pass "Restic is available inside the My Railway backup image"
    else
      fail "My Railway image does not provide a working restic binary"
    fi
  else
    warn "Cannot verify restic yet because my-railway:local has not been built"
  fi
else
  warn "No offsite restic repository is configured"
fi

if docker volume inspect myrailway-backups >/dev/null 2>&1; then
  LATEST_BACKUP="$(docker run --rm -v myrailway-backups:/backups:ro alpine:3.20 sh -lc "find /backups/platform -type f -name 'control-*.sql.gz' -printf '%T@\n' 2>/dev/null | sort -nr | head -1" || true)"
  if [ -n "$LATEST_BACKUP" ]; then
    NOW="$(date +%s)"
    AGE_HOURS="$(( (NOW - ${LATEST_BACKUP%.*}) / 3600 ))"
    if [ "$AGE_HOURS" -le 48 ]; then
      pass "Latest control-plane backup is $AGE_HOURS hour(s) old"
    else
      warn "Latest control-plane backup is $AGE_HOURS hour(s) old"
    fi
  else
    warn "No control-plane backup file was found in myrailway-backups"
  fi
fi

echo
echo "Result: $FAIL failure(s), $WARN warning(s)"
[ "$FAIL" -eq 0 ]
