# My Railway

My Railway is a private, self-hosted application deployment platform for deploying your own Git repositories to infrastructure you control.

The first release is deliberately **private-operator first**: it is designed to run your own applications safely before attempting to become a public hosting product for untrusted customers.

## What is implemented

- Web control plane with projects, services, deployments, servers, databases, backups, alerts, audit history, and security controls.
- GitHub push auto-deploys with signed webhook verification and delivery deduplication.
- GitHub App authentication using short-lived installation tokens. A static token remains available as a fallback.
- Dockerfile, Node.js, Python, and static-site build detection.
- Immutable Docker releases with health-gated cutover and exact-image rollback.
- Deployment serialization and superseding so rapid pushes cannot accidentally put an older commit back into production.
- Separate control-plane, deployment-worker, and runtime-agent processes.
- Runtime CPU, memory, and PID limits.
- Traefik routing with automatic HTTPS through Let's Encrypt.
- DNS verification before an application domain becomes active.
- AES-256-GCM encrypted application secrets.
- Sensitive agent command payload encryption at rest.
- Persistent Docker volumes with manual and automatic backups.
- Managed PostgreSQL 17 and Redis 7 with generated encrypted credentials and automatic service environment-variable attachment.
- Database backup, backup validation, and explicit destructive restore paths.
- Pre-deploy commands for migrations.
- Scheduled cron jobs using timezone/DST-aware expressions, immutable release images, one-off resource-limited containers, run history, manual run-now, timeout handling, logs, and alerts.
- Live runtime log capture with known application secrets redacted.
- Continuous application health probing.
- Server CPU, memory, disk, load, container count, and heartbeat monitoring.
- Alerts for application health, low disk, offline runtimes, and backup failure.
- Optional automatic application rollback after repeated health failures.
- Daily automatic database and volume backup scheduling.
- Optional restic offsite backup replication.
- Automatic safe Docker cleanup that preserves retained rollback images.
- Administrator password login, login throttling, HTTP-only sessions, strict security headers, and TOTP 2FA.
- Audit history for operator actions.
- Emergency command-line recovery tools.
- Infrastructure self-test from the dashboard.
- CI checks for TypeScript, browser JavaScript syntax, tests, Compose validity, and complete Docker-image construction.

## Scope

The current architecture is intended for a **single trusted Docker host** running your own projects. That is a useful production architecture for a private cloud and is much safer to prove before adding arbitrary third-party workloads.

Do not expose this release as a public Railway replacement for untrusted customers. A public platform additionally needs hardened build sandboxes/VMs, tenant-level network isolation, billing, abuse controls, quotas, organization permissions, and multi-region scheduling.

## Architecture

```text
GitHub
   |
   | signed push webhook
   v
+----------------------+        +------------------+
| Control Plane        |------->| PostgreSQL       |
| dashboard + API      |        | platform state   |
+----------+-----------+        +------------------+
           |
           +-------------------> Redis / BullMQ
           |                         |
           |                         v
           |                  +--------------+
           |                  | Build Worker |
           |                  +------+-------+
           |                         |
           |                         | Docker build
           |                         v
           |                  immutable image
           |
           v
+----------------------+
| Runtime Agent        |
| health + operations  |
+----------+-----------+
           |
           v
       Docker host
        /      \
       /        \
applications   PostgreSQL/Redis
       |
       v
    Traefik
       |
       v
custom domains + HTTPS
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed trust boundaries and deployment lifecycle.

## Requirements

A fresh Linux server with:

- Docker Engine
- Docker Compose v2
- Git
- OpenSSL
- ports 80 and 443 reachable from the Internet
- enough RAM/disk for your applications and databases
- a domain/subdomain for the control plane, recommended: `cloud.example.com`

For initial private use, 4 CPU cores, 8 GB RAM, and SSD storage is a reasonable minimum. Size the machine for the actual workloads you move onto it.

## Fresh-host automation

For a new Ubuntu/Debian server, see [docs/INSTALL.md](docs/INSTALL.md).

The production installer can install Docker, generate platform secrets, configure the dashboard hostname, create a systemd boot unit, start the stack, and run the doctor preflight:

```bash
sudo ./scripts/install-host.sh \
  --domain cloud.example.com \
  --public-ip 203.0.113.10 \
  --email you@example.com
```

Firewall changes require the explicit `--configure-firewall` option.

Useful host tools:

```bash
./scripts/doctor.sh
./scripts/export-recovery.sh --full
./scripts/upgrade.sh
```

## First installation

```bash
git clone https://github.com/customerservice-prog/my-railway.git
cd my-railway
./scripts/bootstrap.sh
```

The bootstrap script creates `.env` if it does not exist and generates:

- session signing secret
- AES secret-encryption key
- runtime-agent token
- PostgreSQL password

Keep a protected offline copy of **SECRET_ENCRYPTION_KEY**. Losing it means encrypted application secrets cannot be recovered from the control-plane database.

Edit `.env` before launch:

```bash
nano .env
```

At minimum set:

```dotenv
PLATFORM_HOST=cloud.example.com
PUBLIC_IP=203.0.113.10
ACME_EMAIL=you@example.com
GITHUB_WEBHOOK_SECRET=a-long-random-secret
```

Run bootstrap again after setting the hostname so it writes the control-plane Traefik route and enables secure cookies:

```bash
./scripts/bootstrap.sh
docker compose up -d --build
```

Point the control-plane hostname at the server:

```text
cloud.example.com  A  YOUR_SERVER_IP
```

Then open:

```text
https://cloud.example.com
```

If you have not configured public DNS yet, port 8080 is bound only to localhost. Use an SSH tunnel instead of exposing it:

```bash
ssh -L 8080:127.0.0.1:8080 user@your-server
```

Then open `http://localhost:8080`.

## First administrator

You have two options.

### Browser bootstrap

Open the first-time setup section on the login page and create the first administrator. Once a user exists, that bootstrap endpoint refuses additional initialization.

### Environment bootstrap

Set a temporary strong value:

```dotenv
ADMIN_BOOTSTRAP_PASSWORD=replace-this-with-a-long-random-password
```

Start the platform. It creates `admin@localhost` only if the users table is empty. Remove the environment value afterward.

After logging in, open **Security** and enable authenticator-based 2FA. Save the generated one-time recovery codes outside this server. The Security page also supports password rotation, recovery-code regeneration, and revoking older administrator sessions.

## Connect GitHub securely

### Recommended: GitHub App

Create a GitHub App for this platform.

Set the webhook URL to:

```text
https://cloud.example.com/api/webhooks/github
```

Use the same random secret as `GITHUB_WEBHOOK_SECRET`.

The application needs repository metadata and repository contents read access and should subscribe to push events. Install the App on the repositories you want My Railway to deploy.

Base64-encode the GitHub App private key and configure:

```dotenv
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY_BASE64=
```

The build worker creates a short-lived installation token only when it needs repository access. Git credentials are passed to Git through an environment-backed HTTP header instead of being placed in the clone URL.

### PAT fallback

For a private personal installation you can instead set:

```dotenv
GITHUB_TOKEN=
```

The GitHub App method is preferred because it avoids a permanent broadly scoped token.

## Create a project

From the dashboard choose **New project** and enter:

- project name
- GitHub repository in `owner/repository` form
- branch
- optional domain
- build type or Auto Detect
- internal port
- health path

A deployment runs this lifecycle:

```text
QUEUED
  -> CLONING
  -> BUILDING
  -> optional image push
  -> PROVISIONING
  -> pre-deploy migration
  -> candidate container
  -> health check
  -> Traefik cutover
  -> grace period
  -> old container removal
  -> RUNNING
```

If the candidate cannot pass its health check, the existing route remains on the previous running release.

## Builds

Build precedence:

1. configured Docker build
2. repository Dockerfile when Auto Detect is selected
3. Node.js when `package.json` is present
4. Python when `requirements.txt` or `pyproject.toml` is present
5. static site when `index.html` is present

For anything unusual, add your own Dockerfile.

The default `REGISTRY_URL=local` is intentional for a single-host installation. Images stay on the Docker host, which avoids requiring an insecure local registry.

For cross-host deployment, use a proper TLS/authenticated OCI registry and set `REGISTRY_URL` to it. Cross-host ingress/overlay networking is outside the current single-host production scope.

## Domains and HTTPS

Add a domain to a service, point its DNS to `PUBLIC_IP`, and click **Verify**.

After verification, the deployment agent writes the service's Traefik route. Traefik obtains and renews the Let's Encrypt certificate automatically.

Application containers never publish their internal HTTP port directly to the Internet.

## Secrets

Environment values are encrypted with AES-256-GCM in PostgreSQL.

They are decrypted only when a deployment is being assembled for an authenticated runtime agent. The command payload is itself encrypted while queued.

Never commit `.env`, GitHub keys, Stripe keys, database credentials, or `SECRET_ENCRYPTION_KEY` to Git.

## Persistent volumes

Attach a volume from the project screen and specify an absolute mount path such as:

```text
/app/uploads
```

Volumes survive application-container replacement.

Backups can be created manually from the project screen and automatically by the backup scheduler.

## Managed PostgreSQL and Redis

Create PostgreSQL or Redis from the project screen.

If attached to a service, My Railway automatically creates or updates:

- `DATABASE_URL` for PostgreSQL
- `REDIS_URL` for Redis

Generated credentials are encrypted in the control plane.

Managed databases:

- run only on the private Docker network
- receive persistent storage
- have restart policies and resource limits
- receive readiness checks
- support backups
- support backup validation
- support explicit destructive restore

A restore stops the attached application first. Redeploy the application after restoration.

## Cron jobs

Create a service with type **Cron job** and configure:

- a standard cron expression such as `0 2 * * *`
- an IANA timezone such as `America/New_York`
- the command to execute
- a timeout in seconds

Deploy/publish the cron service once so My Railway has an immutable image. The scheduler stores the next due timestamp and runs each occurrence as a short-lived container with the service's encrypted environment variables, persistent volumes, CPU/RAM/PID limits, and timeout.

Cron runs record:

- scheduled time
- deployment/image used
- runtime server
- status
- exit code
- completion time
- redacted logs

Use **Run now** for a manual execution. A failed or timed-out cron run creates an alert; a later successful run resolves it.

## Rollbacks

Every successful release retains its immutable image reference and runtime metadata.

Choose **Rollback here** on a previous release to create a new deployment from that exact image without rebuilding source code.

Optional:

```dotenv
AUTO_ROLLBACK=true
```

With that enabled, three consecutive failed runtime probes create a critical alert and may trigger the most recent known-good release. Keep it disabled when your deployment process includes schema changes that cannot safely run with older application code.

## Backups

Automatic backups are enabled by default:

```dotenv
AUTO_BACKUPS=true
```

The control plane schedules managed database and attached volume backups if no recent backup exists.

The `platform-backup` service also performs a daily PostgreSQL dump of the My Railway control database.

To replicate backups off the host, configure restic:

```dotenv
RESTIC_REPOSITORY=
RESTIC_PASSWORD=
```

Use a repository on a different machine/provider. A backup stored only on the same physical disk is not disaster recovery.

Test restore paths from the **Backups** screen.

## Monitoring and alerts

The runtime agent reports:

- CPU count/load
- free/total memory
- free/total disk
- container count
- heartbeat
- individual service health
- HTTP status
- health latency

Alerts are generated for:

- repeated application-health failure
- low disk space
- missing runtime heartbeat
- backup failure

Set an optional webhook receiver:

```dotenv
ALERT_WEBHOOK_URL=https://...
```

## Runtime logs

Use **Refresh live logs** on a project.

The runtime agent collects the last 300 container-log lines and stores them with deployment logs. Known configured secret values are redacted before storage.

## Platform self-deployment

My Railway can deploy **itself** from the dashboard.

The **Platform** screen compares the running commit with the configured `PLATFORM_UPDATE_REF`. When a newer release is published, choose **Deploy platform update**.

Self-deployment is deliberately handled by a separate `updater` supervisor container rather than by the control-plane process that is about to be replaced.

Update flow:

```text
Dashboard
   |
   v
Control API
   |
   v
Independent updater supervisor
   |
   +--> mandatory control-plane DB backup
   +--> fetch configured release ref
   +--> build candidate platform image
   +--> build candidate updater image
   +--> start candidate control plane
   +--> candidate /healthz
   +--> switch public control-plane traffic when healthy
   +--> advance host checkout
   +--> recreate control/worker/agent/maintenance/backup services
   +--> final control-plane /healthz
   +--> switch route back to final control service
   +--> replace updater supervisor last
```

If candidate/final activation fails, the updater restores the previous checkout/image and keeps the pre-update database backup available. Database migrations are never blindly reversed.

Only the configured release channel is accepted by the updater. Production installs default to:

```dotenv
PLATFORM_UPDATE_REF=release/private-v1-rc1
```

CI includes a real self-update integration drill that creates a temporary second platform commit, asks the running control plane to self-update, and verifies the platform and updater return healthy on the new commit.

## Platform self-test

Choose **Run self-test**.

It validates:

- Docker daemon access
- private Docker network
- Traefik dynamic-route storage
- backup storage
- disposable container execution
- disposable volume create/write/read/remove lifecycle

Use this after installation and after infrastructure maintenance.

## Maintenance mode

Web services support non-destructive maintenance mode.

When enabled:

- the real application container keeps running privately
- public verified domains are switched to a small dedicated responder
- visitors receive HTTP 503 with `Retry-After: 300`
- the maintenance message is HTML-escaped
- a new deployment may still build/replace the private release
- the public route stays on maintenance until you explicitly disable it

Disabling maintenance removes the responder and restores the current application route without rebuilding the app.

## Operator safety controls

The dashboard supports:

- cancelling deployments that are still safely queued
- draining/resuming a runtime server so new work is not scheduled there
- removing a domain and immediately refreshing the active Traefik route
- removing a managed database while either retaining or explicitly deleting its Docker data volume
- stopping/restarting long-running services
- refreshing live runtime logs

Use server drain mode before host maintenance. Drain mode stops new scheduling; it does not silently terminate existing application containers.

## Safe maintenance

Automated maintenance runs every six hours.

It prunes:

- old builder cache
- old stopped containers
- dangling image layers

It deliberately does **not** run `docker image prune -a` or `docker volume prune`, because either could destroy rollback images or persistent data.

Manual status:

```bash
./scripts/emergency.sh status
```

Recent platform logs:

```bash
./scripts/emergency.sh logs
```

Force a platform database backup:

```bash
./scripts/emergency.sh backup
```

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for recovery procedures.

## Before migrating a critical site

Do not move a revenue-critical application merely because the containers start.

Complete [docs/PRODUCTION_CHECKLIST.md](docs/PRODUCTION_CHECKLIST.md), including a real restore drill and intentionally failed deployment.

## Public hosting

This code is not yet a safe public multi-tenant PaaS. In particular, the build worker has privileged access to the Docker host and therefore assumes trusted source repositories.

Before accepting arbitrary customer source code, move builds into disposable sandbox VMs/microVMs or another strong isolation boundary and add tenant RBAC, quotas, metering/billing, abuse controls, network egress policy, and a multi-host routing fabric.

That separation is intentional: first prove the private cloud with your own real applications, then harden a separate public-hosting mode.
