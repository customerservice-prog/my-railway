#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

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
test "$STATUS" = "201"

STATUS="$(curl -sS -o /tmp/bootstrap2.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{"email":"other@example.com","password":"another-password-123456"}'   http://127.0.0.1:8080/api/auth/bootstrap)"
test "$STATUS" = "409"

STATUS="$(curl -sS -o /tmp/unauth.json -w '%{http_code}' http://127.0.0.1:8080/api/overview)"
test "$STATUS" = "401"

STATUS="$(curl -sS -c /tmp/cookies.txt -o /tmp/login.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{"email":"ci@example.com","password":"ci-password-123456"}'   http://127.0.0.1:8080/api/auth/login)"
test "$STATUS" = "200"

curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/auth/me > /tmp/me.json
grep -q 'ci@example.com' /tmp/me.json

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/project.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{"name":"Smoke App","repoFullName":"octocat/Hello-World","branch":"master","kind":"web","buildType":"auto","internalPort":3000,"healthPath":"/"}'   http://127.0.0.1:8080/api/projects)"
test "$STATUS" = "201"

curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/projects > /tmp/projects.json
grep -q 'Smoke App' /tmp/projects.json

STATUS="$(curl -sS -o /tmp/webhook.json -w '%{http_code}'   -H 'content-type: application/json'   -H 'x-github-delivery: ci-invalid'   -H 'x-github-event: push'   -H 'x-hub-signature-256: sha256=invalid'   -d '{"ref":"refs/heads/main"}'   http://127.0.0.1:8080/api/webhooks/github)"
test "$STATUS" = "401"

curl -sSI http://127.0.0.1:8080/ | tr -d '\r' > /tmp/headers.txt
grep -qi '^x-frame-options: DENY$' /tmp/headers.txt
grep -qi '^x-content-type-options: nosniff$' /tmp/headers.txt
grep -qi '^content-security-policy:' /tmp/headers.txt

echo "My Railway smoke test passed."
