#!/usr/bin/env bash
set -euo pipefail

REF="${1:-${PLATFORM_UPDATE_REF:-release/private-v1-rc1}}"
JOB_ID="${2:-manual}"
ROOT="${HOST_PROJECT_DIR:-/opt/my-railway}"
LOCK_DIR="$ROOT/data/platform-update.lock"
WORKTREE=""
CANDIDATE_CONTROL=""
CURRENT_SHA=""
CURRENT_BRANCH=""
TARGET_SHA=""
SHORT=""
ROUTE_SWITCHED=false
REPO_SWITCHED=false

cd "$ROOT"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

write_control_route() {
  local target="$1"
  if [ -z "${PLATFORM_HOST:-}" ]; then return 0; fi
  mkdir -p "$ROOT/data/routes"
  cat >"$ROOT/data/routes/control.yml" <<EOF
http:
  routers:
    control:
      rule: "Host(\`${PLATFORM_HOST}\`)"
      entryPoints: [websecure]
      service: control
      tls:
        certResolver: letsencrypt
  services:
    control:
      loadBalancer:
        servers:
          - url: "http://$target:8080"
EOF
}

wait_control_container() {
  local name="$1"
  local tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    if docker exec "$name" curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_compose_control() {
  local container
  for _ in $(seq 1 60); do
    container="$(docker compose -f "$ROOT/docker-compose.yml" --project-directory "$ROOT" ps -q control 2>/dev/null || true)"
    if [ -n "$container" ] && docker exec "$container" curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback() {
  local code="$?"
  set +e
  log "Update failed; beginning code/image rollback (exit=$code)."

  if [ "$ROUTE_SWITCHED" = true ]; then
    write_control_route "control"
  fi

  [ -z "$CANDIDATE_CONTROL" ] || docker rm -f "$CANDIDATE_CONTROL" >/dev/null 2>&1 || true

  if [ "$REPO_SWITCHED" = true ] && [ -n "$CURRENT_SHA" ]; then
    git checkout -B "$CURRENT_BRANCH" "$CURRENT_SHA" >/dev/null 2>&1 || git reset --hard "$CURRENT_SHA" >/dev/null 2>&1 || true
  fi

  if [ -n "$CURRENT_SHA" ] && docker image inspect "my-railway:rollback-${CURRENT_SHA:0:12}" >/dev/null 2>&1; then
    docker tag "my-railway:rollback-${CURRENT_SHA:0:12}" my-railway:local || true
    docker compose -f "$ROOT/docker-compose.yml" --project-directory "$ROOT" up -d --no-build       postgres redis traefik control worker agent maintenance platform-backup || true
  fi

  log "Rollback attempt finished. Database migrations are never automatically reversed; use the pre-update backup if a migration itself must be restored."
  exit "$code"
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "Another platform update holds $LOCK_DIR"
  exit 75
fi
trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true; [ -z "$WORKTREE" ] || git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true' EXIT
trap rollback ERR

if ! git diff --quiet || ! git diff --cached --quiet; then
  log "Refusing self-update: tracked source files have local changes."
  exit 2
fi

CURRENT_SHA="$(git rev-parse HEAD)"
CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo main)"
log "Current platform: $CURRENT_SHA on $CURRENT_BRANCH"
log "Update channel: $REF"

git fetch --quiet origin "$REF"
TARGET_SHA="$(git rev-parse FETCH_HEAD)"
SHORT="${TARGET_SHA:0:12}"

if [ "$CURRENT_SHA" = "$TARGET_SHA" ]; then
  log "Platform is already up to date."
  exit 0
fi

WORKTREE="$ROOT/data/platform-update-worktree-$SHORT"
rm -rf "$WORKTREE"
git worktree prune
git worktree add --detach "$WORKTREE" "$TARGET_SHA"
cp "$ROOT/.env" "$WORKTREE/.env"

log "Creating pre-update platform backup."
docker compose -f "$ROOT/docker-compose.yml" --project-directory "$ROOT" exec -T platform-backup /app/scripts/backup-platform.sh

log "Validating target source."
(
  cd "$WORKTREE"
  bash -n scripts/*.sh
  docker compose config --quiet
)

log "Building candidate platform images."
docker build -t "my-railway:candidate-$SHORT" "$WORKTREE"
docker build -f "$WORKTREE/Dockerfile.updater" -t "my-railway-updater:candidate-$SHORT" "$WORKTREE"

docker tag my-railway:local "my-railway:rollback-${CURRENT_SHA:0:12}"
if docker image inspect my-railway-updater:local >/dev/null 2>&1; then
  docker tag my-railway-updater:local "my-railway-updater:rollback-${CURRENT_SHA:0:12}"
fi

set -a
source "$ROOT/.env"
set +a

CANDIDATE_CONTROL="mr-platform-control-candidate-$SHORT"
docker rm -f "$CANDIDATE_CONTROL" >/dev/null 2>&1 || true

log "Starting candidate control plane without changing public traffic."
docker run -d   --name "$CANDIDATE_CONTROL"   --network "${PLATFORM_NETWORK:-myrailway}"   --restart no   --env-file "$ROOT/.env"   -e "DATABASE_URL=postgresql://myrailway:${POSTGRES_PASSWORD}@postgres:5432/myrailway"   -e "REDIS_URL=redis://redis:6379"   "my-railway:candidate-$SHORT"   node dist/control/server.js >/dev/null

if ! wait_control_container "$CANDIDATE_CONTROL" 60; then
  log "Candidate control plane failed its health check."
  exit 1
fi

log "Candidate control plane is healthy."
if [ -n "${PLATFORM_HOST:-}" ]; then
  write_control_route "$CANDIDATE_CONTROL"
  ROUTE_SWITCHED=true
  log "Public control-plane traffic switched to the healthy candidate."
fi

log "Advancing host checkout to $TARGET_SHA."
git checkout -B "$REF" "$TARGET_SHA"
git branch --set-upstream-to="origin/$REF" "$REF" >/dev/null 2>&1 || true
REPO_SWITCHED=true

docker tag "my-railway:candidate-$SHORT" my-railway:local
docker tag "my-railway-updater:candidate-$SHORT" my-railway-updater:local

log "Recreating platform services from the new immutable image."
docker compose -f "$ROOT/docker-compose.yml" --project-directory "$ROOT" up -d --no-build   postgres redis traefik control worker agent maintenance platform-backup

if ! wait_compose_control; then
  log "Final control plane failed its health check."
  exit 1
fi

write_control_route "control"
ROUTE_SWITCHED=false
docker rm -f "$CANDIDATE_CONTROL" >/dev/null 2>&1 || true
CANDIDATE_CONTROL=""

log "New platform control plane is healthy at $TARGET_SHA."

log "Scheduling updater supervisor replacement last."
docker rm -f "mr-updater-restart-$SHORT" >/dev/null 2>&1 || true
docker run -d --rm   --name "mr-updater-restart-$SHORT"   -v /var/run/docker.sock:/var/run/docker.sock   -v "$ROOT:$ROOT"   -w "$ROOT"   docker:cli   sh -lc "sleep 5; docker compose -f '$ROOT/docker-compose.yml' --project-directory '$ROOT' up -d --no-build updater" >/dev/null

log "Self-update complete: $CURRENT_SHA -> $TARGET_SHA (job=$JOB_ID)."
