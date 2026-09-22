#!/usr/bin/env bash
set -euo pipefail

checkpoint() { printf '\n[smoke] %s\n' "$1"; }
expect_status() {
  local actual="$1" expected="$2" label="$3" body_file="${4:-}"
  if [ "$actual" != "$expected" ]; then
    echo "Smoke assertion failed: $label (expected $expected, got $actual)" >&2
    if [ -n "$body_file" ] && [ -f "$body_file" ]; then
      echo "--- response body ---" >&2
      cat "$body_file" >&2 || true
      echo >&2
    fi
    docker compose logs --tail=120 control >&2 || true
    exit 1
  fi
}

cd "$(dirname "$0")/..

cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

SESSION_SECRET="$(openssl rand -hex 48)"
SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32 | tr -d '\n')"
AGENT_TOKEN="$(openssl rand -hex 32)"
POSTGRES_PASSWORD="$(openssl rand -hex 24)"

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
GITHUB_WEBHOOK_SECRET=ci-webhook-secret
GITHUB_TOKEN=
AGENT_TOKEN=$AGENT_TOKEN
CONTROL_PLANE_URL=http://control:8080
SERVER_ID=local-runtime-01
SERVER_NAME=CI Runtime
REGISTRY_URL=local
PLATFORM_NETWORK=myrailway
TRAEFIK_ROUTES_DIR=/var/lib/myrailway/routes
BACKUP_DIR=/var/lib/myrailway/backups
BACKUP_VOLUME_NAME=myrailway-backups
PUBLIC_IP=
PLATFORM_HOST=
DEPLOY_GRACE_SECONDS=1
DEPLOY_HEALTH_RETRIES=3
DEPLOY_HEALTH_INTERVAL_MS=500
AUTO_MIGRATE=true
AUTO_ROLLBACK=false
AUTO_BACKUPS=false
ALERT_WEBHOOK_URL=
ACME_EMAIL=ci@example.com
RESTIC_REPOSITORY=
RESTIC_PASSWORD=
EOF

docker compose up -d --no-build postgres redis control

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/healthz >/tmp/myrailway-health.json 2>/dev/null; then break; fi
  sleep 1
done

grep -q '"status":"ok"' /tmp/myrailway-health.json || {
  docker compose logs control postgres redis
  echo "control plane did not become healthy"
  exit 1
}

STATUS="$(curl -sS -o /tmp/bootstrap.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{"email":"ci@example.com","password":"ci-password-123456"}'   http://127.0.0.1:8080/api/auth/bootstrap)"
expect_status "$STATUS" "201" "bootstrap first administrator" /tmp/bootstrap.json

STATUS="$(curl -sS -o /tmp/bootstrap2.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{"email":"other@example.com","password":"another-password-123456"}'   http://127.0.0.1:8080/api/auth/bootstrap)"
expect_status "$STATUS" "409" "reject second bootstrap" /tmp/bootstrap2.json

STATUS="$(curl -sS -o /tmp/unauth.json -w '%{http_code}' http://127.0.0.1:8080/api/overview)"
expect_status "$STATUS" "401" "unauthorized/rejected request" /tmp/unauth.json

checkpoint "password login"
STATUS="$(curl -sS -c /tmp/cookies.txt -o /tmp/login.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{"email":"ci@example.com","password":"ci-password-123456"}'   http://127.0.0.1:8080/api/auth/login)"
expect_status "$STATUS" "200" "password login" /tmp/login.json

curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/auth/me > /tmp/me.json
grep -q 'ci@example.com' /tmp/me.json

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/project.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{"name":"Smoke App","repoFullName":"octocat/Hello-World","branch":"master","kind":"web","buildType":"auto","internalPort":3000,"healthPath":"/"}'   http://127.0.0.1:8080/api/projects)"
expect_status "$STATUS" "201" "create project" /tmp/project.json

curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/projects > /tmp/projects.json
grep -q 'Smoke App' /tmp/projects.json

# Cross-site state-changing browser requests must be rejected.
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/cross-site.json -w '%{http_code}'   -H 'content-type: application/json'   -H 'Origin: https://evil.example'   -H 'Sec-Fetch-Site: cross-site'   -d '{"name":"Cross Site","repoFullName":"octocat/Hello-World","branch":"master","kind":"web","buildType":"auto","internalPort":3000,"healthPath":"/"}'   http://127.0.0.1:8080/api/projects)"
expect_status "$STATUS" "403" "cross-site mutation rejection" /tmp/cross-site.json

# Keep a second session so session-version revocation can be verified later.
STATUS="$(curl -sS -c /tmp/cookies-old.txt -o /tmp/login-old.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{"email":"ci@example.com","password":"ci-password-123456"}'   http://127.0.0.1:8080/api/auth/login)"
expect_status "$STATUS" "200" "second session login" /tmp/login-old.json

# Enable TOTP and obtain high-entropy one-time recovery codes.
curl -fsS -b /tmp/cookies.txt -H 'content-type: application/json' -X POST   http://127.0.0.1:8080/api/auth/totp/enroll > /tmp/totp-enroll.json
TOTP_SECRET="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/totp-enroll.json","utf8")).secret)')"
TOTP_CODE="$(node --input-type=module -e 'import { authenticator } from "otplib"; process.stdout.write(authenticator.generate(process.argv[1]))' "$TOTP_SECRET")"

checkpoint "TOTP confirmation"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/totp-confirm.json -w '%{http_code}'   -H 'content-type: application/json'   -d "$(printf '{"token":"%s"}' "$TOTP_CODE")"   http://127.0.0.1:8080/api/auth/totp/confirm)"
expect_status "$STATUS" "200" "TOTP confirmation" /tmp/totp-confirm.json
RECOVERY_CODE="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/totp-confirm.json","utf8")).recoveryCodes[0])')"

# A recovery code authenticates exactly once.
checkpoint "one-time recovery login"
STATUS="$(curl -sS -c /tmp/cookies-recovery.txt -o /tmp/login-recovery.json -w '%{http_code}'   -H 'content-type: application/json'   -d "$(printf '{"email":"ci@example.com","password":"ci-password-123456","recoveryCode":"%s"}' "$RECOVERY_CODE")"   http://127.0.0.1:8080/api/auth/login)"
expect_status "$STATUS" "200" "recovery-code login" /tmp/login-recovery.json

STATUS="$(curl -sS -o /tmp/login-recovery-reuse.json -w '%{http_code}'   -H 'content-type: application/json'   -d "$(printf '{"email":"ci@example.com","password":"ci-password-123456","recoveryCode":"%s"}' "$RECOVERY_CODE")"   http://127.0.0.1:8080/api/auth/login)"
expect_status "$STATUS" "401" "recovery code cannot be reused" /tmp/login-recovery-reuse.json

# Revoking sessions invalidates every older cookie while reissuing this verified session.
TOTP_CODE="$(node --input-type=module -e 'import { authenticator } from "otplib"; process.stdout.write(authenticator.generate(process.argv[1]))' "$TOTP_SECRET")"
checkpoint "session revocation"
STATUS="$(curl -sS -b /tmp/cookies.txt -c /tmp/cookies.txt -o /tmp/revoke.json -w '%{http_code}'   -H 'content-type: application/json'   -d "$(printf '{"password":"ci-password-123456","totp":"%s"}' "$TOTP_CODE")"   http://127.0.0.1:8080/api/auth/sessions/revoke)"
expect_status "$STATUS" "200" "session revocation" /tmp/revoke.json

STATUS="$(curl -sS -b /tmp/cookies-old.txt -o /tmp/old-session.json -w '%{http_code}' http://127.0.0.1:8080/api/overview)"
expect_status "$STATUS" "401" "old session rejected after revoke" /tmp/old-session.json
curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/overview >/tmp/current-session.json

STATUS="$(curl -sS -o /tmp/webhook.json -w '%{http_code}'   -H 'content-type: application/json'   -H 'x-github-delivery: ci-invalid'   -H 'x-github-event: push'   -H 'x-hub-signature-256: sha256=invalid'   -d '{"ref":"refs/heads/main"}'   http://127.0.0.1:8080/api/webhooks/github)"
expect_status "$STATUS" "401" "invalid webhook signature rejected" /tmp/webhook.json

curl -sSI http://127.0.0.1:8080/ | tr -d '\r' > /tmp/headers.txt
grep -qi '^x-frame-options: DENY$' /tmp/headers.txt
grep -qi '^x-content-type-options: nosniff$' /tmp/headers.txt
grep -qi '^content-security-policy:' /tmp/headers.txt

echo "My Railway smoke test passed."
