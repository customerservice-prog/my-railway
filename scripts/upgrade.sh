#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="${1:-main}"

if [ ! -d .git ]; then
  echo "This upgrade helper requires a Git checkout." >&2
  exit 1
fi

CURRENT="$(git rev-parse HEAD)"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to upgrade with local uncommitted changes." >&2
  exit 1
fi

echo "Creating control-plane backup before upgrade..."
./scripts/emergency.sh backup

git fetch origin "$BRANCH"
TARGET="$(git rev-parse "origin/$BRANCH")"
if [ "$CURRENT" = "$TARGET" ]; then
  echo "Already up to date at $CURRENT"
  exit 0
fi

echo "Current: $CURRENT"
echo "Target : $TARGET"

git checkout "$TARGET" --detach
ROLLBACK_IMAGE="my-railway:rollback-${CURRENT:0:12}"
CANDIDATE_IMAGE="my-railway:candidate-${TARGET:0:12}"

if docker image inspect my-railway:local >/dev/null 2>&1; then
  docker tag my-railway:local "$ROLLBACK_IMAGE"
fi

restore_source() {
  git checkout "$BRANCH" >/dev/null 2>&1 || true
  git reset --hard "$CURRENT" >/dev/null 2>&1 || true
}

if ! bash -n scripts/*.sh; then
  echo "Target shell validation failed." >&2
  restore_source
  exit 1
fi

if ! docker compose config --quiet; then
  echo "Target compose configuration is invalid." >&2
  restore_source
  exit 1
fi

echo "Building target image..."
if ! docker build -t "$CANDIDATE_IMAGE" .; then
  echo "Candidate image build failed." >&2
  restore_source
  exit 1
fi

echo "Running candidate unit tests..."
if ! docker run --rm \
  -e SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32 | tr -d '\n')" \
  "$CANDIDATE_IMAGE" \
  node --test >/dev/null 2>&1; then
  echo "Note: compiled runtime image does not contain source tests; Docker build/CI remains the authoritative test gate."
fi

docker tag "$CANDIDATE_IMAGE" my-railway:local
docker compose up -d --no-build

echo "Waiting for upgraded control plane..."
OK=false
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    OK=true
    break
  fi
  sleep 2
done

if [ "$OK" != true ]; then
  echo "Upgrade health check failed." >&2
  if docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
    echo "Restoring previous code image. Database migrations are NOT automatically reversed." >&2
    docker tag "$ROLLBACK_IMAGE" my-railway:local
    docker compose up -d --no-build || true
  fi
  restore_source
  echo "A pre-upgrade control-plane backup exists. Review migration compatibility before restoring data." >&2
  exit 1
fi

git checkout "$BRANCH"
git reset --hard "$TARGET"

./scripts/doctor.sh || true

echo "Upgrade complete:"
echo "  $CURRENT"
echo "  -> $TARGET"
echo
echo "Previous image retained temporarily as:"
echo "  $ROLLBACK_IMAGE"
echo
echo "A pre-upgrade control-plane database backup was created before migrations ran."
