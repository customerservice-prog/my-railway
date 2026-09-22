#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required."
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required."
  exit 1
fi

if [ ! -f .env ]; then cp .env.example .env; fi

replace_env() {
  local key="$1" value="$2"
  if grep -q "^$key=" .env; then sed -i "s|^$key=.*|$key=$value|" .env
  else printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

current_secret="$(grep '^SESSION_SECRET=' .env | cut -d= -f2- || true)"
if [ -z "$current_secret" ] || [[ "$current_secret" == replace-* ]]; then replace_env SESSION_SECRET "$(openssl rand -base64 48 | tr -d '\n')"; fi
current_enc="$(grep '^SECRET_ENCRYPTION_KEY=' .env | cut -d= -f2- || true)"
if [ -z "$current_enc" ] || [[ "$current_enc" == replace-* ]]; then replace_env SECRET_ENCRYPTION_KEY "$(openssl rand -base64 32 | tr -d '\n')"; fi
current_agent="$(grep '^AGENT_TOKEN=' .env | cut -d= -f2- || true)"
if [ -z "$current_agent" ] || [[ "$current_agent" == replace-* ]]; then replace_env AGENT_TOKEN "$(openssl rand -hex 32)"; fi

current_updater="$(grep '^PLATFORM_UPDATER_TOKEN=' .env | cut -d= -f2- || true)"
if [ -z "$current_updater" ] || [[ "$current_updater" == replace-* ]]; then
  replace_env PLATFORM_UPDATER_TOKEN "$(openssl rand -hex 32)"
fi

current_root="$(grep '^HOST_PROJECT_DIR=' .env | cut -d= -f2- || true)"
if [ -z "$current_root" ]; then
  replace_env HOST_PROJECT_DIR "$(pwd)"
fi

current_update_ref="$(grep '^PLATFORM_UPDATE_REF=' .env | cut -d= -f2- || true)"
if [ -z "$current_update_ref" ]; then
  replace_env PLATFORM_UPDATE_REF "release/private-v1-rc1"
fi

current_pg="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2- || true)"
if [ -z "$current_pg" ]; then replace_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"; fi

current_bootstrap="$(grep '^ADMIN_BOOTSTRAP_TOKEN=' .env | cut -d= -f2- || true)"
if [ -z "$current_bootstrap" ] || [[ "$current_bootstrap" == replace-* ]]; then
  replace_env ADMIN_BOOTSTRAP_TOKEN "$(openssl rand -hex 32)"
fi

mkdir -p data/routes data/backups
touch data/acme.json
chmod 600 data/acme.json

get_env() {
  local key="$1"
  grep -E "^$key=" .env | tail -n1 | cut -d= -f2- || true
}

configured_acme_email="$(get_env ACME_EMAIL)"
configured_platform_host="$(get_env PLATFORM_HOST)"

if [ -n "$configured_platform_host" ]; then
  replace_env COOKIE_SECURE true
  cat > data/routes/control.yml <<EOF
http:
  routers:
    control:
      rule: "Host(\`$configured_platform_host\`)"
      entryPoints: [websecure]
      service: control
      tls:
        certResolver: letsencrypt
  services:
    control:
      loadBalancer:
        servers:
          - url: "http://control:8080"
EOF
  echo "Control plane route prepared for https://$configured_platform_host"
else
  echo "PLATFORM_HOST is blank; control plane will only listen on localhost:8080."
fi

echo
echo "Review .env, especially GITHUB_WEBHOOK_SECRET, PUBLIC_IP/PLATFORM_HOST, and ADMIN_BOOTSTRAP_PASSWORD."
echo "Then run: docker compose up -d --build"
