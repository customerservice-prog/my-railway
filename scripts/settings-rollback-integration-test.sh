#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

cleanup() {
  set +e
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

SESSION_SECRET="$(openssl rand -hex 48)"
SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32 | tr -d '\n')"
AGENT_TOKEN="$(openssl rand -hex 32)"
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
UPDATER_TOKEN="$(openssl rand -hex 32)"
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
SERVER_NAME=Settings Rollback CI Runtime
REGISTRY_URL=local
PLATFORM_NETWORK=myrailway
HOST_PROJECT_DIR=$(pwd)
PLATFORM_UPDATER_URL=http://updater:8090
PLATFORM_UPDATER_TOKEN=$UPDATER_TOKEN
PLATFORM_UPDATE_REF=$(git rev-parse HEAD)
TRAEFIK_ROUTES_DIR=/var/lib/myrailway/routes
BACKUP_DIR=/var/lib/myrailway/backups
BACKUP_VOLUME_NAME=myrailway-backups
PUBLIC_IP=
PLATFORM_HOST=
DEPLOY_GRACE_SECONDS=1
DEPLOY_HEALTH_RETRIES=3
DEPLOY_HEALTH_INTERVAL_MS=500
GIT_TIMEOUT_SECONDS=180
BUILD_TIMEOUT_SECONDS=600
AGENT_COMMAND_TIMEOUT_SECONDS=300
AUTO_PREDEPLOY_BACKUPS=true
AUTO_MIGRATE=true
AUTO_ROLLBACK=false
AUTO_BACKUPS=false
BACKUP_RETENTION_DAYS=30
IMAGE_RETENTION_HOURS=720
LOG_RETENTION_DAYS=30
COMMAND_RETENTION_DAYS=7
WEBHOOK_RETENTION_DAYS=30
CRON_RUN_RETENTION_DAYS=90
AUDIT_RETENTION_DAYS=365
ALERT_WEBHOOK_URL=
ACME_EMAIL=ci@example.com
RESTIC_REPOSITORY=
RESTIC_PASSWORD=
EOF

mkdir -p data/routes data
touch data/acme.json
chmod 600 data/acme.json

docker compose up -d --no-build postgres redis updater control worker agent

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8080/healthz >/dev/null

cp .env data/platform-settings-previous.env
chmod 600 data/platform-settings-previous.env

# Break only the management plane's DB credential. The existing PostgreSQL container retains
# the original password, so recreating control with this new value must fail.
python3 - <<'PY'
from pathlib import Path
p=Path(".env")
text=p.read_text()
lines=[]
for line in text.splitlines():
    if line.startswith("POSTGRES_PASSWORD="):
        lines.append("POSTGRES_PASSWORD=definitely-wrong-password")
    elif line.startswith("DATABASE_URL="):
        lines.append("DATABASE_URL=postgresql://myrailway:definitely-wrong-password@postgres:5432/myrailway")
    else:
        lines.append(line)
p.write_text("\n".join(lines)+"\n")
p.chmod(0o600)
PY

set +e
PLATFORM_SETTINGS_HEALTH_RETRIES=8 \
PLATFORM_SETTINGS_RESTORE_RETRIES=20 \
PLATFORM_SETTINGS_HEALTH_INTERVAL_SECONDS=1 \
bash scripts/platform-apply-settings.sh ci-rollback-test
APPLY_EXIT="$?"
set -e

test "$APPLY_EXIT" -ne 0

for _ in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8080/healthz >/dev/null

# The old environment must be restored exactly enough for the original DB password to return.
RESTORED_PASSWORD="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
test "$RESTORED_PASSWORD" = "$POSTGRES_PASSWORD"

node - <<'NODE'
const fs=require("fs");
const state=JSON.parse(fs.readFileSync("data/platform-settings-state.json","utf8"));
if(state.status!=="failed") process.exit(1);
if(!state.error) process.exit(1);
NODE

echo "My Railway transactional platform-settings rollback test passed."
