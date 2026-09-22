#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/customerservice-prog/my-railway.git"
INSTALL_DIR="/opt/my-railway"
PLATFORM_HOST=""
PUBLIC_IP=""
ACME_EMAIL=""
CONFIGURE_FIREWALL=false

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/install-host.sh --domain cloud.example.com --public-ip 203.0.113.10 --email you@example.com

Options:
  --domain HOST        Public hostname for the My Railway dashboard.
  --public-ip IP       Public IPv4 address application domains should point to.
  --email EMAIL        ACME/Let's Encrypt contact email.
  --repo URL           Git repository to install from.
  --dir PATH           Installation directory (default /opt/my-railway).
  --configure-firewall Configure UFW for OpenSSH, 80/tcp, and 443/tcp.
  -h, --help           Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain) PLATFORM_HOST="${2:-}"; shift 2 ;;
    --public-ip) PUBLIC_IP="${2:-}"; shift 2 ;;
    --email) ACME_EMAIL="${2:-}"; shift 2 ;;
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --configure-firewall) CONFIGURE_FIREWALL=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root (sudo)." >&2
  exit 1
fi

if [ -z "$PLATFORM_HOST" ] || [ -z "$PUBLIC_IP" ] || [ -z "$ACME_EMAIL" ]; then
  echo "--domain, --public-ip, and --email are required for a production install." >&2
  usage
  exit 2
fi

if ! [[ "$PUBLIC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "PUBLIC_IP does not look like an IPv4 address: $PUBLIC_IP" >&2
  exit 2
fi

if [ ! -r /etc/os-release ]; then
  echo "Unsupported host: /etc/os-release is missing." >&2
  exit 1
fi
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *)
    echo "This installer currently supports Ubuntu and Debian. Detected: ${ID:-unknown}" >&2
    exit 1
    ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git openssl ufw jq dnsutils

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  ARCH="$(dpkg --print-architecture)"
  CODENAME="${VERSION_CODENAME:-}"
  if [ -z "$CODENAME" ]; then
    echo "Unable to determine distribution codename." >&2
    exit 1
  fi
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required but unavailable." >&2
  exit 1
fi

if [ -e "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch origin main
  git -C "$INSTALL_DIR" checkout main
  git -C "$INSTALL_DIR" pull --ff-only origin main
else
  if [ -e "$INSTALL_DIR" ] && [ "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)" -gt 0 ]; then
    echo "Install directory exists and is not empty: $INSTALL_DIR" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch main "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
./scripts/bootstrap.sh

set_env() {
  local key="$1" value="$2"
  if grep -q "^$key=" .env; then
    sed -i "s|^$key=.*|$key=$value|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

set_env PLATFORM_HOST "$PLATFORM_HOST"
set_env PUBLIC_IP "$PUBLIC_IP"
set_env ACME_EMAIL "$ACME_EMAIL"
set_env COOKIE_SECURE "true"

if grep -q '^GITHUB_WEBHOOK_SECRET=replace-me$' .env || ! grep -q '^GITHUB_WEBHOOK_SECRET=' .env; then
  set_env GITHUB_WEBHOOK_SECRET "$(openssl rand -hex 32)"
fi

./scripts/bootstrap.sh

if [ "$CONFIGURE_FIREWALL" = true ]; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

docker compose config --quiet
docker compose build
docker compose up -d

cat >/etc/systemd/system/my-railway.service <<EOF
[Unit]
Description=My Railway private application cloud
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/docker compose up -d
ExecReload=/usr/bin/docker compose up -d --build
ExecStop=/usr/bin/docker compose stop
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable my-railway.service

echo "Waiting for the control plane..."
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
  echo "Control plane did not become healthy." >&2
  docker compose ps >&2 || true
  docker compose logs --tail=150 control postgres redis >&2 || true
  exit 1
fi

./scripts/doctor.sh || true

cat <<EOF

My Railway is installed.

Dashboard:
  https://$PLATFORM_HOST

DNS required:
  $PLATFORM_HOST  A  $PUBLIC_IP

Next:
  1. Point the DNS record above at this server.
  2. Open the dashboard and create the first administrator.
  3. Enable TOTP in Security.
  4. Configure the GitHub App and webhook.
  5. Configure an offsite restic repository.
  6. Run the dashboard platform self-test.

Install directory:
  $INSTALL_DIR
EOF
