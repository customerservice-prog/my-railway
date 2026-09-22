#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${HOST_PROJECT_DIR:-$SCRIPT_ROOT}"
LOG="$ROOT/data/platform-settings.log"
STATE="$ROOT/data/platform-settings-state.json"
PREVIOUS_ENV="$ROOT/data/platform-settings-previous.env"
JOB_ID="${1:-settings}"
cd "$ROOT"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"
}

write_state() {
  local status="$1" error="${2:-}"
  node - "$STATE" "$status" "$JOB_ID" "$error" <<'NODE'
const fs=require("fs");
const [file,status,jobId,error]=process.argv.slice(2);
let previous={};
try{previous=JSON.parse(fs.readFileSync(file,"utf8"));}catch{}
const next={
  ...previous,
  status,
  jobId,
  startedAt: previous.startedAt || new Date().toISOString(),
  finishedAt: ["completed","failed"].includes(status) ? new Date().toISOString() : null,
  error: error || null
};
const tmp=file+".tmp";
fs.writeFileSync(tmp,JSON.stringify(next,null,2),{mode:0o600});
fs.renameSync(tmp,file);
NODE
}

fail() {
  local code="$?"
  local message="Platform settings apply failed (exit $code)"
  trap - ERR
  set +e
  log "$message"

  if [ -f "$PREVIOUS_ENV" ]; then
    log "Restoring last-known-good platform environment."
    cp "$PREVIOUS_ENV" "$ROOT/.env"
    chmod 600 "$ROOT/.env"

    if bash "$ROOT/scripts/bootstrap.sh"; then
      log "Recreating management services with restored settings."
      docker compose -f "$ROOT/docker-compose.yml" --project-directory "$ROOT" up -d --no-build --force-recreate         traefik control worker agent maintenance platform-backup || true

      RESTORED_CONTROL=""
      for _ in $(seq 1 60); do
        RESTORED_CONTROL="$(docker compose -f "$ROOT/docker-compose.yml" --project-directory "$ROOT" ps -q control 2>/dev/null || true)"
        if [ -n "$RESTORED_CONTROL" ] && docker exec "$RESTORED_CONTROL" curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
          log "Last-known-good control plane is healthy again."
          break
        fi
        sleep 2
      done
    fi
  fi

  write_state failed "$message"
  exit "$code"
}
trap fail ERR

: > "$LOG"
write_state running
log "Applying platform settings from $ROOT/.env"

bash "$ROOT/scripts/bootstrap.sh"
docker compose -f "$ROOT/docker-compose.yml" --project-directory "$ROOT" config --quiet

log "Recreating management services with updated settings."
docker compose -f "$ROOT/docker-compose.yml" --project-directory "$ROOT" up -d --no-build --force-recreate \
  traefik control worker agent maintenance platform-backup

CONTROL=""
for _ in $(seq 1 90); do
  CONTROL="$(docker compose -f "$ROOT/docker-compose.yml" --project-directory "$ROOT" ps -q control 2>/dev/null || true)"
  if [ -n "$CONTROL" ] && docker exec "$CONTROL" curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if [ -z "$CONTROL" ] || ! docker exec "$CONTROL" curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
  log "Updated control plane did not become healthy."
  exit 1
fi

log "Control plane is healthy. Scheduling updater restart last."
HELPER="mr-settings-restart-${JOB_ID//[^a-zA-Z0-9_.-]/-}"
docker rm -f "$HELPER" >/dev/null 2>&1 || true
docker run -d --rm \
  --name "$HELPER" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$ROOT:$ROOT" \
  -w "$ROOT" \
  my-railway-updater:local \
  sh -lc "sleep 5; docker compose -f '$ROOT/docker-compose.yml' --project-directory '$ROOT' up -d --no-build --force-recreate updater" >/dev/null

rm -f "$PREVIOUS_ENV"
write_state completed
log "Platform settings applied successfully."
