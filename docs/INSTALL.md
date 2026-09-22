# Fresh host installation

This is the recommended path for a new private My Railway server.

## Supported hosts

The automated installer currently supports:

- Ubuntu
- Debian

The machine needs a public IPv4 address and DNS you control.

Recommended starting point for several modest applications:

- 4+ CPU cores
- 8+ GB RAM
- SSD storage
- 80/tcp and 443/tcp reachable from the Internet

## Install

On a fresh host:

```bash
git clone --branch release/private-v1-rc1 https://github.com/customerservice-prog/my-railway.git
cd my-railway

sudo ./scripts/install-host.sh \
  --branch release/private-v1-rc1 \
  --domain cloud.example.com \
  --public-ip 203.0.113.10 \
  --email you@example.com
```

For production testing, the release branch above is preferred over a moving `main`. Use `main` only when you intentionally want the newest development changes.

The installer:

- installs Docker Engine/Compose when missing
- generates required platform secrets
- configures the public control-plane hostname
- prepares Traefik/ACME storage
- builds the platform
- starts the stack
- creates a systemd unit
- verifies the local control-plane health endpoint
- runs the doctor preflight

Firewall changes are intentionally **not automatic**.

If the host uses the default OpenSSH firewall profile and you explicitly want the installer to enable UFW:

```bash
sudo ./scripts/install-host.sh \
  --domain cloud.example.com \
  --public-ip 203.0.113.10 \
  --email you@example.com \
  --configure-firewall
```

Do not use that flag blindly on a server with a custom SSH port or custom firewall policy.

## DNS

Create:

```text
cloud.example.com  A  YOUR_SERVER_IP
```

After DNS propagates:

```text
https://cloud.example.com
```

Create the first administrator from the browser and enable TOTP immediately.

## Preflight / doctor

Run:

```bash
sudo ./scripts/doctor.sh
```

It checks:

- Docker / Compose
- environment-secret presence
- AES key length
- webhook secret
- secure cookies
- DNS
- ACME file permissions
- disk space
- private Docker network
- backup volume
- local control-plane health
- offsite-restic configuration

Failures return non-zero. Warnings indicate items that should be reviewed but may be expected before DNS or offsite backup setup.

## GitHub App

Create a GitHub App and configure:

```dotenv
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY_BASE64=
GITHUB_WEBHOOK_SECRET=
```

Webhook:

```text
https://cloud.example.com/api/webhooks/github
```

Subscribe to push events and grant repository Contents read access.

## Encrypted recovery bundle

After setup and after major changes:

```bash
sudo ./scripts/export-recovery.sh
```

For the complete My Railway backup volume:

```bash
sudo ./scripts/export-recovery.sh --full
```

The script creates an AES-256 encrypted archive containing recovery-critical configuration and backup material.

For unattended use:

```bash
sudo RECOVERY_BUNDLE_PASSWORD='a-long-unique-secret' ./scripts/export-recovery.sh --full
```

Store the resulting encrypted archive and checksum outside the server.

## Upgrades

Use:

```bash
sudo ./scripts/upgrade.sh
```

The upgrade helper:

1. refuses local dirty source changes;
2. creates a control-plane database backup;
3. fetches the new main branch;
4. validates scripts/Compose;
5. builds the candidate image;
6. retains the prior platform image;
7. restarts the management stack;
8. waits for health;
9. restores the previous code image if health fails;
10. runs the doctor check.

Database migrations are not automatically reversed. The pre-upgrade database backup exists for manual recovery if a migration itself must be undone.

## First production workload

Do not begin with your most important application.

Use a disposable or lower-risk project and complete the production checklist in:

```text
docs/PRODUCTION_CHECKLIST.md
```

Only after deploy, rollback, backup/restore, host reboot, agent failure, and health-alert drills succeed should you migrate a business-critical application.
