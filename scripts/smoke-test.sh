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
    docker compose logs --tail=120 control agent >&2 || true
    exit 1
  fi
}

wait_deployment() {
  local deployment_id="$1" expected="$2" label="$3"
  for _ in $(seq 1 360); do
    curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/deployments > /tmp/deployments.json
    local state
    state="$(node -e 'const fs=require("fs");const id=process.argv[1];const x=JSON.parse(fs.readFileSync("/tmp/deployments.json","utf8")).find(d=>d.id===id);process.stdout.write(x?.status||"missing")' "$deployment_id")"
    if [ "$state" = "$expected" ]; then
      return 0
    fi
    case "$state" in
      BUILD_FAILED|DEPLOY_FAILED|CANCELLED)
        if [ "$expected" != "$state" ]; then
          echo "Deployment $deployment_id failed during $label with state $state" >&2
          curl -fsS -b /tmp/cookies.txt "http://127.0.0.1:8080/api/deployments/$deployment_id/logs" >&2 || true
          docker compose logs --tail=180 worker agent control >&2 || true
          exit 1
        fi
        ;;
    esac
    sleep 2
  done
  echo "Timed out waiting for deployment $deployment_id to reach $expected during $label" >&2
  curl -fsS -b /tmp/cookies.txt "http://127.0.0.1:8080/api/deployments/$deployment_id/logs" >&2 || true
  docker compose logs --tail=180 worker agent control >&2 || true
  exit 1
}

wait_command() {
  local command_id="$1" label="$2"
  for _ in $(seq 1 180); do
    curl -fsS -b /tmp/cookies.txt "http://127.0.0.1:8080/api/commands/$command_id" > /tmp/command.json
    local state
    state="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/command.json","utf8")).status)')"
    if [ "$state" = "completed" ]; then return 0; fi
    if [ "$state" = "failed" ]; then
      echo "Agent command failed during $label" >&2
      cat /tmp/command.json >&2
      docker compose logs --tail=160 agent control >&2 || true
      exit 1
    fi
    sleep 1
  done
  echo "Timed out waiting for agent command during $label" >&2
  docker compose logs --tail=160 agent control >&2 || true
  exit 1
}

cd "$(dirname "$0")/.."

cleanup() {
  docker ps -aq --filter label=myrailway.service | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker ps -aq --filter label=myrailway.database | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter name=mr-db- | xargs -r docker volume rm -f >/dev/null 2>&1 || true
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
ADMIN_BOOTSTRAP_TOKEN=ci-bootstrap-token-0123456789abcdef0123456789abcdef
GITHUB_WEBHOOK_SECRET=ci-webhook-secret
GITHUB_TOKEN=
AGENT_TOKEN=$AGENT_TOKEN
CONTROL_PLANE_URL=http://control:8080
SERVER_ID=local-runtime-01
SERVER_NAME=CI Runtime
REGISTRY_URL=local
PLATFORM_NETWORK=myrailway
HOST_PROJECT_DIR=$(pwd)
PLATFORM_UPDATER_URL=http://updater:8090
PLATFORM_UPDATER_TOKEN=$(openssl rand -hex 32)
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
ALERT_WEBHOOK_URL=
ACME_EMAIL=ci@example.com
RESTIC_REPOSITORY=
RESTIC_PASSWORD=
EOF

mkdir -p data/routes
touch data/acme.json
chmod 600 data/acme.json

docker compose up -d --no-build postgres redis updater control worker agent platform-backup

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/healthz >/tmp/myrailway-health.json 2>/dev/null; then break; fi
  sleep 1
done

grep -q '"status":"ok"' /tmp/myrailway-health.json || {
  docker compose logs control postgres redis
  echo "control plane did not become healthy"
  exit 1
}

STATUS="$(curl -sS -o /tmp/bootstrap-bad-token.json -w '%{http_code}' -H 'content-type: application/json' -d '{"email":"ci@example.com","password":"ci-password-123456","setupToken":"wrong-token"}' http://127.0.0.1:8080/api/auth/bootstrap)"
expect_status "$STATUS" "401" "reject invalid bootstrap token" /tmp/bootstrap-bad-token.json

STATUS="$(curl -sS -o /tmp/bootstrap.json -w '%{http_code}' -H 'content-type: application/json' -d '{"email":"ci@example.com","password":"ci-password-123456","setupToken":"ci-bootstrap-token-0123456789abcdef0123456789abcdef"}' http://127.0.0.1:8080/api/auth/bootstrap)"
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

checkpoint "control-plane backup restore drill"
docker compose exec -T platform-backup /app/scripts/backup-platform.sh > /tmp/platform-backup.log
PLATFORM_BACKUP_FILE="$(docker run --rm -v myrailway-backups:/backup alpine:3.20 sh -lc "ls -1t /backup/platform/control-*.sql.gz | head -1")"
test -n "$PLATFORM_BACKUP_FILE"
PLATFORM_BACKUP_SUM="$(basename "$PLATFORM_BACKUP_FILE").sha256"
docker run --rm -v myrailway-backups:/backup alpine:3.20 sh -lc "cd /backup/platform && sha256sum -c '$PLATFORM_BACKUP_SUM'" | grep -q ': OK'

docker compose exec -T postgres dropdb -U myrailway --if-exists myrailway_restore_test
docker compose exec -T postgres createdb -U myrailway -O myrailway myrailway_restore_test

docker run --rm -v myrailway-backups:/backup alpine:3.20 sh -lc "gzip -dc '$PLATFORM_BACKUP_FILE'"   | docker compose exec -T postgres psql -U myrailway -d myrailway_restore_test -v ON_ERROR_STOP=1 >/tmp/control-restore.log

test "$(docker compose exec -T postgres psql -U myrailway -d myrailway_restore_test -Atqc "SELECT count(*) FROM users WHERE email='ci@example.com'")" = "1"
test "$(docker compose exec -T postgres psql -U myrailway -d myrailway_restore_test -Atqc "SELECT count(*) FROM projects WHERE name='Smoke App'")" = "1"
MIGRATION_COUNT="$(docker compose exec -T postgres psql -U myrailway -d myrailway_restore_test -Atqc "SELECT count(*) FROM schema_migrations")"
test "$MIGRATION_COUNT" -gt 0
docker compose exec -T postgres dropdb -U myrailway myrailway_restore_test


# The independent updater must be reachable only through authenticated control-plane proxying.
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/platform-update-info.json -w '%{http_code}'   http://127.0.0.1:8080/api/platform/update/info)"
test "$STATUS" = "200"
grep -q '"updateAvailable":false' /tmp/platform-update-info.json

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/platform-update-status.json -w '%{http_code}'   http://127.0.0.1:8080/api/platform/update/status)"
test "$STATUS" = "200"

# In CI the configured channel is this exact main commit, so update is a safe no-op.
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/platform-update-noop.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{}'   http://127.0.0.1:8080/api/platform/update)"
test "$STATUS" = "202"
grep -Eq '"status":"(up_to_date|running)"' /tmp/platform-update-noop.json

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
node -e 'require("fs").writeFileSync("/tmp/totp-body.json",JSON.stringify({token:process.argv[1]}))' "$TOTP_CODE"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/totp-confirm.json -w '%{http_code}' -H 'content-type: application/json' --data-binary @/tmp/totp-body.json http://127.0.0.1:8080/api/auth/totp/confirm)"
expect_status "$STATUS" "200" "TOTP confirmation" /tmp/totp-confirm.json
RECOVERY_CODE="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/totp-confirm.json","utf8")).recoveryCodes[0])')"

# A recovery code authenticates exactly once.
checkpoint "one-time recovery login"
node -e 'require("fs").writeFileSync("/tmp/recovery-login.json",JSON.stringify({email:"ci@example.com",password:"ci-password-123456",recoveryCode:process.argv[1]}))' "$RECOVERY_CODE"
STATUS="$(curl -sS -c /tmp/cookies-recovery.txt -o /tmp/login-recovery.json -w '%{http_code}' -H 'content-type: application/json' --data-binary @/tmp/recovery-login.json http://127.0.0.1:8080/api/auth/login)"
expect_status "$STATUS" "200" "recovery-code login" /tmp/login-recovery.json

STATUS="$(curl -sS -o /tmp/login-recovery-reuse.json -w '%{http_code}' -H 'content-type: application/json' --data-binary @/tmp/recovery-login.json http://127.0.0.1:8080/api/auth/login)"
expect_status "$STATUS" "401" "recovery code cannot be reused" /tmp/login-recovery-reuse.json

# Revoking sessions invalidates every older cookie while reissuing this verified session.
TOTP_CODE="$(node --input-type=module -e 'import { authenticator } from "otplib"; process.stdout.write(authenticator.generate(process.argv[1]))' "$TOTP_SECRET")"
checkpoint "session revocation"
node -e 'require("fs").writeFileSync("/tmp/revoke-body.json",JSON.stringify({password:"ci-password-123456",totp:process.argv[1]}))' "$TOTP_CODE"
STATUS="$(curl -sS -b /tmp/cookies.txt -c /tmp/cookies.txt -o /tmp/revoke.json -w '%{http_code}' -H 'content-type: application/json' --data-binary @/tmp/revoke-body.json http://127.0.0.1:8080/api/auth/sessions/revoke)"
expect_status "$STATUS" "200" "session revocation" /tmp/revoke.json

STATUS="$(curl -sS -b /tmp/cookies-old.txt -o /tmp/old-session.json -w '%{http_code}' http://127.0.0.1:8080/api/overview)"
expect_status "$STATUS" "401" "old session rejected after revoke" /tmp/old-session.json
curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/overview >/tmp/current-session.json

checkpoint "runtime agent heartbeat"
for _ in $(seq 1 60); do
  curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/servers > /tmp/servers.json
  if node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/servers.json","utf8"));process.exit(x.some(s=>s.id==="local-runtime-01"&&s.online)?0:1)' 2>/dev/null; then
    break
  fi
  sleep 1
done
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/servers.json","utf8"));if(!x.some(s=>s.id==="local-runtime-01"&&s.online))process.exit(1)'

checkpoint "launch readiness assessment"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/readiness.json -w '%{http_code}' http://127.0.0.1:8080/api/platform/readiness)"
expect_status "$STATUS" "200" "platform readiness endpoint" /tmp/readiness.json
node - <<'NODE'
const fs=require("fs");
const r=JSON.parse(fs.readFileSync("/tmp/readiness.json","utf8"));
if(!Array.isArray(r.checks) || !r.checks.length) process.exit(1);
const byId=Object.fromEntries(r.checks.map(c=>[c.id,c]));
for(const id of ["admin","totp","core-secrets","runtime","updater","github-source","offsite-backup"]) {
  if(!byId[id]) process.exit(1);
}
if(byId.admin.status!=="pass") process.exit(1);
if(byId.totp.status!=="pass") process.exit(1);
if(byId.runtime.status!=="pass") process.exit(1);
if(byId.updater.status!=="pass") process.exit(1);
if(byId["github-source"].status!=="blocker") process.exit(1);
if(byId["offsite-backup"].status!=="warning") process.exit(1);
if(r.ready!==false || Number(r.blockers)<1) process.exit(1);
NODE

checkpoint "platform agent self-test"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/self-test.json -w '%{http_code}' -H 'content-type: application/json' -d '{}' http://127.0.0.1:8080/api/platform/self-test)"
expect_status "$STATUS" "202" "queue platform self-test" /tmp/self-test.json
SELF_TEST_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/self-test.json","utf8")).commandId)')"
wait_command "$SELF_TEST_COMMAND" "platform self-test"
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/command.json","utf8"));if(!x.result?.ok)process.exit(1)'

PROJECT_ID="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/project.json","utf8")).id)')"
SERVICE_ID="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/project.json","utf8")).serviceId)')"

checkpoint "full deploy engine"
DEPLOY_COMMIT="$(git rev-parse HEAD)"

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/deploy-project.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{"name":"Deploy Engine Fixture","repoFullName":"customerservice-prog/my-railway","branch":"main","kind":"web","buildType":"node","internalPort":3000,"healthPath":"/healthz"}'   http://127.0.0.1:8080/api/projects)"
expect_status "$STATUS" "201" "create deploy-engine fixture project" /tmp/deploy-project.json

DEPLOY_PROJECT_ID="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/deploy-project.json","utf8"));process.stdout.write(x.id)')"
DEPLOY_SERVICE_ID="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/deploy-project.json","utf8"));process.stdout.write(x.serviceId)')"

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/deploy-service-config.json -w '%{http_code}'   -X PATCH -H 'content-type: application/json'   -d '{"rootDirectory":"fixtures/deploy-good","memoryMb":256,"cpuLimit":0.5,"healthPath":"/healthz","predeployCommand":"node -p 1","autoDeploy":false}'   "http://127.0.0.1:8080/api/services/$DEPLOY_SERVICE_ID")"
expect_status "$STATUS" "200" "configure deploy-engine fixture service" /tmp/deploy-service-config.json

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/deploy-secret.json -w '%{http_code}'   -X PUT -H 'content-type: application/json'   -d '{"value":"encrypted-fixture-secret"}'   "http://127.0.0.1:8080/api/services/$DEPLOY_SERVICE_ID/variables/DEPLOY_FIXTURE_VALUE")"
expect_status "$STATUS" "200" "set deploy fixture encrypted secret" /tmp/deploy-secret.json

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/deploy-volume.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{"name":"Deploy Data","mountPath":"/app/data","readOnly":false}'   "http://127.0.0.1:8080/api/services/$DEPLOY_SERVICE_ID/volumes")"
expect_status "$STATUS" "201" "create deploy fixture persistent volume" /tmp/deploy-volume.json
DEPLOY_VOLUME_NAME="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/deploy-volume.json","utf8"));process.stdout.write(x.dockerVolumeName)')"
docker volume create "$DEPLOY_VOLUME_NAME" >/dev/null
docker run --rm -v "$DEPLOY_VOLUME_NAME:/data" alpine:3.20 sh -lc 'echo mounted-fixture-volume >/data/proof.txt'

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/deploy-domain.json -w '%{http_code}'   -H 'content-type: application/json'   -d '{"hostname":"deploy-smoke.example.com"}'   "http://127.0.0.1:8080/api/services/$DEPLOY_SERVICE_ID/domains")"
expect_status "$STATUS" "201" "create deploy fixture domain" /tmp/deploy-domain.json
DEPLOY_DOMAIN_ID="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/deploy-domain.json","utf8"));process.stdout.write(x.id)')"
docker compose exec -T postgres psql -U myrailway -d myrailway -v ON_ERROR_STOP=1 -c   "UPDATE domains SET verified=true,verified_at=now() WHERE id='$DEPLOY_DOMAIN_ID';" >/dev/null

node -e 'require("fs").writeFileSync("/tmp/exact-deploy.json",JSON.stringify({commitSha:process.argv[1]}))' "$DEPLOY_COMMIT"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/deploy-start.json -w '%{http_code}'   -H 'content-type: application/json' --data-binary @/tmp/exact-deploy.json   "http://127.0.0.1:8080/api/services/$DEPLOY_SERVICE_ID/deploy")"
expect_status "$STATUS" "202" "queue exact-commit good deployment" /tmp/deploy-start.json
GOOD_DEPLOY_ID="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/deploy-start.json","utf8")).deploymentId)')"
wait_deployment "$GOOD_DEPLOY_ID" "RUNNING" "good exact-commit deployment"

curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/deployments > /tmp/deployments-good.json
node - <<'NODE' "$GOOD_DEPLOY_ID" "$DEPLOY_COMMIT"
const fs=require("fs");
const [id,sha]=process.argv.slice(2);
const d=JSON.parse(fs.readFileSync("/tmp/deployments-good.json","utf8")).find(x=>x.id===id);
if(!d || d.status!=="RUNNING" || d.commit_sha!==sha || !d.image_ref || d.server_id!=="local-runtime-01") process.exit(1);
NODE
GOOD_IMAGE="$(node -e 'const fs=require("fs");const id=process.argv[1];const d=JSON.parse(fs.readFileSync("/tmp/deployments-good.json","utf8")).find(x=>x.id===id);process.stdout.write(d.image_ref)' "$GOOD_DEPLOY_ID")"
GOOD_CONTAINER="$(docker ps --filter "label=myrailway.deployment=$GOOD_DEPLOY_ID" --format '{{.Names}}' | head -1)"
test -n "$GOOD_CONTAINER"

docker run --rm --network myrailway curlimages/curl:8.10.1 -fsS "http://$GOOD_CONTAINER:3000/healthz" | grep -q 'healthy-good-release'
docker run --rm --network myrailway curlimages/curl:8.10.1 -fsS "http://$GOOD_CONTAINER:3000/env" | grep -q 'encrypted-fixture-secret'
docker run --rm --network myrailway curlimages/curl:8.10.1 -fsS "http://$GOOD_CONTAINER:3000/volume" | grep -q 'mounted-fixture-volume'
SAFE_DEPLOY_SERVICE_ID="$(printf '%s' "$DEPLOY_SERVICE_ID" | tr '_' '-')"
test -f "data/routes/$SAFE_DEPLOY_SERVICE_ID.yml"
grep -q 'deploy-smoke.example.com' "data/routes/$SAFE_DEPLOY_SERVICE_ID.yml"

# A normal deploy with a pre-deploy command must create a recovery backup before migration.
curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/backups > /tmp/predeploy-backups.json
node - <<'NODE' "$DEPLOY_SERVICE_ID"
const fs=require("fs");
const serviceId=process.argv[2];
const rows=JSON.parse(fs.readFileSync("/tmp/predeploy-backups.json","utf8"));
const backup=rows.find(x=>x.service_id===serviceId && x.kind==="volume" && x.status==="completed");
if(!backup || !backup.location || Number(backup.size_bytes||0)<=0) process.exit(1);
NODE

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/deploy-bad-config.json -w '%{http_code}'   -X PATCH -H 'content-type: application/json'   -d '{"rootDirectory":"fixtures/deploy-bad"}'   "http://127.0.0.1:8080/api/services/$DEPLOY_SERVICE_ID")"
expect_status "$STATUS" "200" "switch fixture source to intentionally unhealthy app" /tmp/deploy-bad-config.json

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/deploy-bad-start.json -w '%{http_code}'   -H 'content-type: application/json' --data-binary @/tmp/exact-deploy.json   "http://127.0.0.1:8080/api/services/$DEPLOY_SERVICE_ID/deploy")"
expect_status "$STATUS" "202" "queue intentionally unhealthy release" /tmp/deploy-bad-start.json
BAD_DEPLOY_ID="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/deploy-bad-start.json","utf8")).deploymentId)')"
wait_deployment "$BAD_DEPLOY_ID" "DEPLOY_FAILED" "bad release protection"

# The failed candidate must be removed and the previous release must still be live and healthy.
test -z "$(docker ps -aq --filter "label=myrailway.deployment=$BAD_DEPLOY_ID")"
docker ps -q --filter "label=myrailway.deployment=$GOOD_DEPLOY_ID" | grep -q .
docker run --rm --network myrailway curlimages/curl:8.10.1 -fsS "http://$GOOD_CONTAINER:3000/healthz" | grep -q 'healthy-good-release'
curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/deployments > /tmp/deployments-after-bad.json
node - <<'NODE' "$GOOD_DEPLOY_ID" "$BAD_DEPLOY_ID"
const fs=require("fs");
const [good,bad]=process.argv.slice(2);
const rows=JSON.parse(fs.readFileSync("/tmp/deployments-after-bad.json","utf8"));
if(rows.find(x=>x.id===good)?.status!=="RUNNING") process.exit(1);
if(rows.find(x=>x.id===bad)?.status!=="DEPLOY_FAILED") process.exit(1);
NODE

# Make the current migration command intentionally fail. Rollback must ignore it and reuse
# the retained release image without rerunning migrations.
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/rollback-migration-guard.json -w '%{http_code}'   -X PATCH -H 'content-type: application/json'   -d '{"predeployCommand":"exit 42"}'   "http://127.0.0.1:8080/api/services/$DEPLOY_SERVICE_ID")"
expect_status "$STATUS" "200" "set failing migration command before rollback" /tmp/rollback-migration-guard.json

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/deploy-rollback.json -w '%{http_code}'   -H 'content-type: application/json' -d '{}'   "http://127.0.0.1:8080/api/deployments/$GOOD_DEPLOY_ID/rollback")"
expect_status "$STATUS" "202" "queue exact-image rollback" /tmp/deploy-rollback.json
ROLLBACK_DEPLOY_ID="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/deploy-rollback.json","utf8")).deploymentId)')"
wait_deployment "$ROLLBACK_DEPLOY_ID" "RUNNING" "exact-image rollback"

curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/deployments > /tmp/deployments-rollback.json
node - <<'NODE' "$ROLLBACK_DEPLOY_ID" "$GOOD_DEPLOY_ID" "$GOOD_IMAGE"
const fs=require("fs");
const [rollback,original,image]=process.argv.slice(2);
const d=JSON.parse(fs.readFileSync("/tmp/deployments-rollback.json","utf8")).find(x=>x.id===rollback);
if(!d || d.status!=="RUNNING" || d.rollback_of!==original || d.image_ref!==image) process.exit(1);
NODE
ROLLBACK_CONTAINER="$(docker ps --filter "label=myrailway.deployment=$ROLLBACK_DEPLOY_ID" --format '{{.Names}}' | head -1)"
test -n "$ROLLBACK_CONTAINER"
docker run --rm --network myrailway curlimages/curl:8.10.1 -fsS "http://$ROLLBACK_CONTAINER:3000/healthz" | grep -q 'healthy-good-release'
docker run --rm --network myrailway curlimages/curl:8.10.1 -fsS "http://$ROLLBACK_CONTAINER:3000/env" | grep -q 'encrypted-fixture-secret'
docker run --rm --network myrailway curlimages/curl:8.10.1 -fsS "http://$ROLLBACK_CONTAINER:3000/volume" | grep -q 'mounted-fixture-volume'

checkpoint "service settings binding"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/service-update.json -w '%{http_code}' -X PATCH -H 'content-type: application/json' -d '{"memoryMb":768,"healthPath":"/"}' "http://127.0.0.1:8080/api/services/$SERVICE_ID")"
expect_status "$STATUS" "200" "update service settings" /tmp/service-update.json
curl -fsS -b /tmp/cookies.txt "http://127.0.0.1:8080/api/projects/$PROJECT_ID" > /tmp/project-detail.json
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/project-detail.json","utf8")).services[0];if(Number(x.memory_mb)!==768)process.exit(1)'

checkpoint "maintenance mode"
docker rm -f mr-smoke-app >/dev/null 2>&1 || true
docker run -d   --name mr-smoke-app   --network myrailway   --restart unless-stopped   --label "myrailway.service=$SERVICE_ID"   --label "myrailway.deployment=dep-smoke-maint"   --label "myrailway.kind=web"   --label "myrailway.port=3000"   --label "myrailway.healthPath=/"   my-railway:local   node -e 'require("http").createServer((q,r)=>{r.end("ok")}).listen(3000,"0.0.0.0")' >/dev/null

docker compose exec -T postgres psql -U myrailway -d myrailway -v ON_ERROR_STOP=1 -c   "INSERT INTO deployments(id,service_id,source,status,server_id,created_at,completed_at) VALUES('dep-smoke-maint','$SERVICE_ID','smoke','RUNNING','local-runtime-01',now(),now()) ON CONFLICT (id) DO UPDATE SET status='RUNNING',server_id='local-runtime-01';" >/dev/null

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/maintenance-enable.json -w '%{http_code}' -H 'content-type: application/json' -d '{"enabled":true,"message":"Smoke maintenance"}' "http://127.0.0.1:8080/api/services/$SERVICE_ID/maintenance")"
expect_status "$STATUS" "202" "enable maintenance" /tmp/maintenance-enable.json
MAINT_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/maintenance-enable.json","utf8")).commandId)')"
wait_command "$MAINT_COMMAND" "enable maintenance"
MAINT_CONTAINER="$(docker ps --filter "label=myrailway.maintenance.service=$SERVICE_ID" --format '{{.Names}}' | head -1)"
test -n "$MAINT_CONTAINER"
STATUS="$(docker run --rm --network myrailway curlimages/curl:8.10.1 -sS -o /dev/null -w '%{http_code}' "http://$MAINT_CONTAINER:3000/")"
expect_status "$STATUS" "503" "maintenance responder status"
MAINT_BODY="$(docker run --rm --network myrailway curlimages/curl:8.10.1 -sS "http://$MAINT_CONTAINER:3000/")"
printf '%s' "$MAINT_BODY" | grep -q 'Smoke maintenance'

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/maintenance-disable.json -w '%{http_code}' -H 'content-type: application/json' -d '{"enabled":false}' "http://127.0.0.1:8080/api/services/$SERVICE_ID/maintenance")"
expect_status "$STATUS" "202" "disable maintenance" /tmp/maintenance-disable.json
MAINT_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/maintenance-disable.json","utf8")).commandId)')"
wait_command "$MAINT_COMMAND" "disable maintenance"
test -z "$(docker ps -q --filter "label=myrailway.maintenance.service=$SERVICE_ID")"

checkpoint "persistent volume lifecycle"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/volume-create.json -w '%{http_code}' -H 'content-type: application/json' -d '{"name":"Smoke Uploads","mountPath":"/app/uploads","readOnly":false}' "http://127.0.0.1:8080/api/services/$SERVICE_ID/volumes")"
expect_status "$STATUS" "201" "create persistent volume metadata" /tmp/volume-create.json
VOLUME_ID="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/volume-create.json","utf8"));process.stdout.write(x.id)')"
VOLUME_NAME="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/volume-create.json","utf8"));process.stdout.write(x.dockerVolumeName)')"
docker volume create "$VOLUME_NAME" >/dev/null
docker run --rm -v "$VOLUME_NAME:/data" alpine:3.20 sh -lc 'echo retained >/data/proof.txt'

checkpoint "persistent volume backup and destructive restore"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/volume-backup.json -w '%{http_code}'   -H 'content-type: application/json' -d '{}'   "http://127.0.0.1:8080/api/volumes/$VOLUME_ID/backup")"
expect_status "$STATUS" "202" "queue persistent volume backup" /tmp/volume-backup.json
VOLUME_BACKUP_ID="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/volume-backup.json","utf8"));process.stdout.write(x.backupId)')"
VOLUME_COMMAND="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/volume-backup.json","utf8"));process.stdout.write(x.commandId)')"
wait_command "$VOLUME_COMMAND" "persistent volume backup"

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/volume-backup-test.json -w '%{http_code}'   -H 'content-type: application/json' -d '{}'   "http://127.0.0.1:8080/api/backups/$VOLUME_BACKUP_ID/test")"
expect_status "$STATUS" "202" "queue persistent volume backup validation" /tmp/volume-backup-test.json
VOLUME_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/volume-backup-test.json","utf8")).commandId)')"
wait_command "$VOLUME_COMMAND" "persistent volume backup validation"

docker run --rm -v "$VOLUME_NAME:/data" alpine:3.20 sh -lc 'echo corrupted >/data/proof.txt'
docker run --rm -v "$VOLUME_NAME:/data:ro" alpine:3.20 grep -q corrupted /data/proof.txt

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/volume-restore.json -w '%{http_code}'   -H 'content-type: application/json' -d '{"confirm":"RESTORE"}'   "http://127.0.0.1:8080/api/backups/$VOLUME_BACKUP_ID/restore")"
expect_status "$STATUS" "202" "queue persistent volume destructive restore" /tmp/volume-restore.json
VOLUME_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/volume-restore.json","utf8")).commandId)')"
wait_command "$VOLUME_COMMAND" "persistent volume destructive restore"
docker run --rm -v "$VOLUME_NAME:/data:ro" alpine:3.20 grep -q retained /data/proof.txt

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/volume-detach.json -w '%{http_code}' -X DELETE -H 'content-type: application/json' -d '{"confirm":"KEEP_DATA"}' "http://127.0.0.1:8080/api/volumes/$VOLUME_ID")"
expect_status "$STATUS" "202" "queue persistent volume detach" /tmp/volume-detach.json
VOLUME_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/volume-detach.json","utf8")).commandId)')"
wait_command "$VOLUME_COMMAND" "persistent volume detach"
docker volume inspect "$VOLUME_NAME" >/dev/null
docker run --rm -v "$VOLUME_NAME:/data:ro" alpine:3.20 grep -q retained /data/proof.txt
curl -fsS -b /tmp/cookies.txt "http://127.0.0.1:8080/api/projects/$PROJECT_ID" > /tmp/project-volume-detached.json
node -e 'const fs=require("fs");const id=process.argv[1];const p=JSON.parse(fs.readFileSync("/tmp/project-volume-detached.json","utf8"));const v=p.services[0].volumes.find(x=>x.id===id);if(!v||v.status!=="detached")process.exit(1)' "$VOLUME_ID"

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/volume-reattach.json -w '%{http_code}' -H 'content-type: application/json' -d '{}' "http://127.0.0.1:8080/api/volumes/$VOLUME_ID/reattach")"
expect_status "$STATUS" "200" "reattach retained persistent volume" /tmp/volume-reattach.json
curl -fsS -b /tmp/cookies.txt "http://127.0.0.1:8080/api/projects/$PROJECT_ID" > /tmp/project-volume-attached.json
node -e 'const fs=require("fs");const id=process.argv[1];const p=JSON.parse(fs.readFileSync("/tmp/project-volume-attached.json","utf8"));const v=p.services[0].volumes.find(x=>x.id===id);if(!v||v.status!=="attached")process.exit(1)' "$VOLUME_ID"

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/volume-delete.json -w '%{http_code}' -X DELETE -H 'content-type: application/json' -d '{"confirm":"DELETE_DATA"}' "http://127.0.0.1:8080/api/volumes/$VOLUME_ID")"
expect_status "$STATUS" "202" "queue permanent persistent volume deletion" /tmp/volume-delete.json
VOLUME_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/volume-delete.json","utf8")).commandId)')"
wait_command "$VOLUME_COMMAND" "persistent volume deletion"
if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  echo "Persistent volume still exists after DELETE_DATA" >&2
  exit 1
fi
curl -fsS -b /tmp/cookies.txt "http://127.0.0.1:8080/api/projects/$PROJECT_ID" > /tmp/project-volume-deleted.json
node -e 'const fs=require("fs");const id=process.argv[1];const p=JSON.parse(fs.readFileSync("/tmp/project-volume-deleted.json","utf8"));if(p.services[0].volumes.some(x=>x.id===id))process.exit(1)' "$VOLUME_ID"

checkpoint "multi-service project"
node -e 'require("fs").writeFileSync("/tmp/service-create.json",JSON.stringify({name:"Smoke Worker",repoFullName:"octocat/Hello-World",branch:"master",kind:"worker",buildType:"auto",internalPort:3000,healthPath:"/"}))'
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/service-create-response.json -w '%{http_code}' -H 'content-type: application/json' --data-binary @/tmp/service-create.json "http://127.0.0.1:8080/api/projects/$PROJECT_ID/services")"
expect_status "$STATUS" "201" "create sibling worker service" /tmp/service-create-response.json
SIBLING_SERVICE_ID="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/service-create-response.json","utf8")).id)')"

curl -fsS -b /tmp/cookies.txt "http://127.0.0.1:8080/api/projects/$PROJECT_ID" > /tmp/project-multi.json
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/project-multi.json","utf8"));if(x.services.length!==2||!x.services.some(s=>s.id===process.argv[1])||!x.services.some(s=>s.id===process.argv[2]))process.exit(1)' "$SERVICE_ID" "$SIBLING_SERVICE_ID"

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/service-delete.json -w '%{http_code}' -X DELETE "http://127.0.0.1:8080/api/services/$SIBLING_SERVICE_ID")"
expect_status "$STATUS" "200" "delete sibling stateless service" /tmp/service-delete.json
curl -fsS -b /tmp/cookies.txt "http://127.0.0.1:8080/api/projects/$PROJECT_ID" > /tmp/project-after-service-delete.json
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/project-after-service-delete.json","utf8"));if(x.services.length!==1||x.services[0].id!==process.argv[1])process.exit(1)' "$SERVICE_ID"

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/last-service-delete.json -w '%{http_code}' -X DELETE "http://127.0.0.1:8080/api/services/$SERVICE_ID")"
expect_status "$STATUS" "409" "protect last service from standalone deletion" /tmp/last-service-delete.json

checkpoint "managed Redis provision"
node -e 'require("fs").writeFileSync("/tmp/database-create.json",JSON.stringify({kind:"redis",name:"Smoke Redis",serviceId:process.argv[1],variableKey:"SMOKE_REDIS_URL"}))' "$SERVICE_ID"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/database-create-response.json -w '%{http_code}' -H 'content-type: application/json' --data-binary @/tmp/database-create.json "http://127.0.0.1:8080/api/projects/$PROJECT_ID/databases")"
expect_status "$STATUS" "202" "queue managed Redis provision" /tmp/database-create-response.json
DATABASE_ID="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/database-create-response.json","utf8"));process.stdout.write(x.databaseId)')"
DATABASE_COMMAND="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/database-create-response.json","utf8"));process.stdout.write(x.commandId)')"
wait_command "$DATABASE_COMMAND" "managed Redis provision"
curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/databases > /tmp/databases.json
node -e 'const fs=require("fs");const id=process.argv[1];const x=JSON.parse(fs.readFileSync("/tmp/databases.json","utf8")).find(d=>d.id===id);if(!x||x.status!=="running")process.exit(1)' "$DATABASE_ID"

checkpoint "managed Redis backup and destructive restore"
curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/databases > /tmp/databases.json
REDIS_DOCKER_NAME="$(node -e 'const fs=require("fs");const id=process.argv[1];const x=JSON.parse(fs.readFileSync("/tmp/databases.json","utf8")).find(d=>d.id===id);process.stdout.write(x.docker_name)' "$DATABASE_ID")"
docker exec "$REDIS_DOCKER_NAME" sh -lc 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SET myrailway_restore_key before >/dev/null'
docker exec "$REDIS_DOCKER_NAME" sh -lc 'test "$(REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli GET myrailway_restore_key 2>/dev/null)" = before'

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/redis-backup.json -w '%{http_code}'   -H 'content-type: application/json' -d '{}'   "http://127.0.0.1:8080/api/databases/$DATABASE_ID/backup")"
expect_status "$STATUS" "202" "queue Redis backup" /tmp/redis-backup.json
REDIS_BACKUP_ID="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/redis-backup.json","utf8"));process.stdout.write(x.backupId)')"
DATABASE_COMMAND="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/redis-backup.json","utf8"));process.stdout.write(x.commandId)')"
wait_command "$DATABASE_COMMAND" "Redis backup"

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/redis-backup-test.json -w '%{http_code}'   -H 'content-type: application/json' -d '{}'   "http://127.0.0.1:8080/api/backups/$REDIS_BACKUP_ID/test")"
expect_status "$STATUS" "202" "queue Redis backup validation" /tmp/redis-backup-test.json
DATABASE_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/redis-backup-test.json","utf8")).commandId)')"
wait_command "$DATABASE_COMMAND" "Redis backup validation"

docker exec "$REDIS_DOCKER_NAME" sh -lc 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SET myrailway_restore_key after >/dev/null'
docker exec "$REDIS_DOCKER_NAME" sh -lc 'test "$(REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli GET myrailway_restore_key 2>/dev/null)" = after'

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/redis-restore.json -w '%{http_code}'   -H 'content-type: application/json' -d '{"confirm":"RESTORE_DATABASE"}'   "http://127.0.0.1:8080/api/backups/$REDIS_BACKUP_ID/restore-database")"
expect_status "$STATUS" "202" "queue Redis destructive restore" /tmp/redis-restore.json
DATABASE_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/redis-restore.json","utf8")).commandId)')"
wait_command "$DATABASE_COMMAND" "Redis destructive restore"
docker exec "$REDIS_DOCKER_NAME" sh -lc 'test "$(REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli GET myrailway_restore_key 2>/dev/null)" = before'

checkpoint "stateful project deletion guard"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/project-delete-blocked.json -w '%{http_code}' -X DELETE "http://127.0.0.1:8080/api/projects/$PROJECT_ID")"
expect_status "$STATUS" "409" "block project deletion while managed database exists" /tmp/project-delete-blocked.json

checkpoint "managed Redis detach with data retained"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/database-detach.json -w '%{http_code}' -X DELETE -H 'content-type: application/json' -d '{"confirm":"KEEP_DATA"}' "http://127.0.0.1:8080/api/databases/$DATABASE_ID")"
expect_status "$STATUS" "202" "queue database detach" /tmp/database-detach.json
DATABASE_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/database-detach.json","utf8")).commandId)')"
wait_command "$DATABASE_COMMAND" "managed Redis detach"
curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/databases > /tmp/databases.json
node -e 'const fs=require("fs");const id=process.argv[1];const x=JSON.parse(fs.readFileSync("/tmp/databases.json","utf8")).find(d=>d.id===id);if(!x||x.status!=="detached")process.exit(1)' "$DATABASE_ID"
docker volume inspect "$(node -e 'const fs=require("fs");const id=process.argv[1];const x=JSON.parse(fs.readFileSync("/tmp/databases.json","utf8")).find(d=>d.id===id);process.stdout.write(x.volume_name)' "$DATABASE_ID")" >/dev/null

checkpoint "managed Redis reattach"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/database-reattach.json -w '%{http_code}' -H 'content-type: application/json' -d '{}' "http://127.0.0.1:8080/api/databases/$DATABASE_ID/reattach")"
expect_status "$STATUS" "202" "queue database reattach" /tmp/database-reattach.json
DATABASE_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/database-reattach.json","utf8")).commandId)')"
wait_command "$DATABASE_COMMAND" "managed Redis reattach"
curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/databases > /tmp/databases.json
node -e 'const fs=require("fs");const id=process.argv[1];const x=JSON.parse(fs.readFileSync("/tmp/databases.json","utf8")).find(d=>d.id===id);if(!x||x.status!=="running")process.exit(1)' "$DATABASE_ID"

checkpoint "managed PostgreSQL provision, backup, and destructive restore"
node -e 'require("fs").writeFileSync("/tmp/postgres-create.json",JSON.stringify({kind:"postgres",name:"Smoke Postgres",serviceId:process.argv[1],variableKey:"SMOKE_DATABASE_URL"}))' "$SERVICE_ID"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/postgres-create-response.json -w '%{http_code}'   -H 'content-type: application/json' --data-binary @/tmp/postgres-create.json   "http://127.0.0.1:8080/api/projects/$PROJECT_ID/databases")"
expect_status "$STATUS" "202" "queue managed PostgreSQL provision" /tmp/postgres-create-response.json
POSTGRES_RESOURCE_ID="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/postgres-create-response.json","utf8"));process.stdout.write(x.databaseId)')"
DATABASE_COMMAND="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/postgres-create-response.json","utf8"));process.stdout.write(x.commandId)')"
wait_command "$DATABASE_COMMAND" "managed PostgreSQL provision"

curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/databases > /tmp/databases.json
POSTGRES_DOCKER_NAME="$(node -e 'const fs=require("fs");const id=process.argv[1];const x=JSON.parse(fs.readFileSync("/tmp/databases.json","utf8")).find(d=>d.id===id);if(!x||x.status!=="running")process.exit(1);process.stdout.write(x.docker_name)' "$POSTGRES_RESOURCE_ID")"
POSTGRES_USERNAME="$(node -e 'const fs=require("fs");const id=process.argv[1];const x=JSON.parse(fs.readFileSync("/tmp/databases.json","utf8")).find(d=>d.id===id);process.stdout.write(x.username)' "$POSTGRES_RESOURCE_ID")"
POSTGRES_DATABASE_NAME="$(node -e 'const fs=require("fs");const id=process.argv[1];const x=JSON.parse(fs.readFileSync("/tmp/databases.json","utf8")).find(d=>d.id===id);process.stdout.write(x.database_name)' "$POSTGRES_RESOURCE_ID")"

docker exec "$POSTGRES_DOCKER_NAME" psql -U "$POSTGRES_USERNAME" -d "$POSTGRES_DATABASE_NAME" -v ON_ERROR_STOP=1 -c "CREATE TABLE restore_probe(value text NOT NULL); INSERT INTO restore_probe(value) VALUES ('before');" >/dev/null
test "$(docker exec "$POSTGRES_DOCKER_NAME" psql -U "$POSTGRES_USERNAME" -d "$POSTGRES_DATABASE_NAME" -Atqc "SELECT value FROM restore_probe LIMIT 1")" = before

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/postgres-backup.json -w '%{http_code}'   -H 'content-type: application/json' -d '{}'   "http://127.0.0.1:8080/api/databases/$POSTGRES_RESOURCE_ID/backup")"
expect_status "$STATUS" "202" "queue PostgreSQL backup" /tmp/postgres-backup.json
POSTGRES_BACKUP_ID="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/postgres-backup.json","utf8"));process.stdout.write(x.backupId)')"
DATABASE_COMMAND="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/postgres-backup.json","utf8"));process.stdout.write(x.commandId)')"
wait_command "$DATABASE_COMMAND" "PostgreSQL backup"

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/postgres-backup-test.json -w '%{http_code}'   -H 'content-type: application/json' -d '{}'   "http://127.0.0.1:8080/api/backups/$POSTGRES_BACKUP_ID/test")"
expect_status "$STATUS" "202" "queue PostgreSQL backup validation" /tmp/postgres-backup-test.json
DATABASE_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/postgres-backup-test.json","utf8")).commandId)')"
wait_command "$DATABASE_COMMAND" "PostgreSQL backup validation"

docker exec "$POSTGRES_DOCKER_NAME" psql -U "$POSTGRES_USERNAME" -d "$POSTGRES_DATABASE_NAME" -v ON_ERROR_STOP=1 -c "UPDATE restore_probe SET value='after';" >/dev/null
test "$(docker exec "$POSTGRES_DOCKER_NAME" psql -U "$POSTGRES_USERNAME" -d "$POSTGRES_DATABASE_NAME" -Atqc "SELECT value FROM restore_probe LIMIT 1")" = after

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/postgres-restore.json -w '%{http_code}'   -H 'content-type: application/json' -d '{"confirm":"RESTORE_DATABASE"}'   "http://127.0.0.1:8080/api/backups/$POSTGRES_BACKUP_ID/restore-database")"
expect_status "$STATUS" "202" "queue PostgreSQL destructive restore" /tmp/postgres-restore.json
DATABASE_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/postgres-restore.json","utf8")).commandId)')"
wait_command "$DATABASE_COMMAND" "PostgreSQL destructive restore"
test "$(docker exec "$POSTGRES_DOCKER_NAME" psql -U "$POSTGRES_USERNAME" -d "$POSTGRES_DATABASE_NAME" -Atqc "SELECT value FROM restore_probe LIMIT 1")" = before

STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/postgres-delete.json -w '%{http_code}'   -X DELETE -H 'content-type: application/json' -d '{"confirm":"DELETE_DATA"}'   "http://127.0.0.1:8080/api/databases/$POSTGRES_RESOURCE_ID")"
expect_status "$STATUS" "202" "queue PostgreSQL permanent deletion" /tmp/postgres-delete.json
DATABASE_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/postgres-delete.json","utf8")).commandId)')"
wait_command "$DATABASE_COMMAND" "PostgreSQL permanent deletion"

checkpoint "managed Redis permanent deletion"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/database-delete.json -w '%{http_code}' -X DELETE -H 'content-type: application/json' -d '{"confirm":"DELETE_DATA"}' "http://127.0.0.1:8080/api/databases/$DATABASE_ID")"
expect_status "$STATUS" "202" "queue permanent database deletion" /tmp/database-delete.json
DATABASE_COMMAND="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync("/tmp/database-delete.json","utf8")).commandId)')"
wait_command "$DATABASE_COMMAND" "managed Redis permanent deletion"
curl -fsS -b /tmp/cookies.txt http://127.0.0.1:8080/api/databases > /tmp/databases.json
node -e 'const fs=require("fs");const id=process.argv[1];const x=JSON.parse(fs.readFileSync("/tmp/databases.json","utf8"));if(x.some(d=>d.id===id))process.exit(1)' "$DATABASE_ID"

checkpoint "stateless project deletion"
STATUS="$(curl -sS -b /tmp/cookies.txt -o /tmp/project-delete.json -w '%{http_code}' -X DELETE "http://127.0.0.1:8080/api/projects/$PROJECT_ID")"
expect_status "$STATUS" "200" "delete project after stateful resources are removed" /tmp/project-delete.json

STATUS="$(curl -sS -o /tmp/webhook.json -w '%{http_code}'   -H 'content-type: application/json'   -H 'x-github-delivery: ci-invalid'   -H 'x-github-event: push'   -H 'x-hub-signature-256: sha256=invalid'   -d '{"ref":"refs/heads/main"}'   http://127.0.0.1:8080/api/webhooks/github)"
expect_status "$STATUS" "401" "invalid webhook signature rejected" /tmp/webhook.json

curl -sSI http://127.0.0.1:8080/ | tr -d '\r' > /tmp/headers.txt
grep -qi '^x-frame-options: DENY$' /tmp/headers.txt
grep -qi '^x-content-type-options: nosniff$' /tmp/headers.txt
grep -qi '^content-security-policy:' /tmp/headers.txt

echo "My Railway smoke test passed."
