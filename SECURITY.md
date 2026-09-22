# Security model

My Railway is private-first. The initial release assumes trusted repositories controlled by the operator.

## Trust boundaries

- The control plane never mounts the Docker socket.
- The worker and runtime agent do mount a Docker socket and must run on machines treated as privileged infrastructure.
- Build code executes only on builder infrastructure. Before accepting untrusted customer code, replace the Docker-socket builder with isolated ephemeral VMs or another hardened sandbox.
- Production secrets are AES-256-GCM encrypted at rest and are only decrypted for the runtime assignment that needs them.
- GitHub webhook requests require HMAC SHA-256 verification and delivery IDs are deduplicated.
- Runtime containers receive CPU, memory, and PID limits and are not published directly to host ports.
- Public ingress is through Traefik only. Databases and Redis remain on the private network.

## Required production settings

1. Use a long random SESSION_SECRET.
2. Generate SECRET_ENCRYPTION_KEY with openssl rand -base64 32 and store a protected offline copy.
3. Generate a long random AGENT_TOKEN.
4. Configure a GitHub webhook secret.
5. Enable TOTP for the administrator.
6. Put the control plane behind HTTPS; do not expose port 8080 publicly.
7. Firewall PostgreSQL, Redis and any registry from the public Internet.
8. Send backups to a second machine/provider using restic or equivalent.
9. Protect the Docker host and Docker socket as root-equivalent access.
10. Test restoration before migrating a critical production workload.

## Public SaaS warning

Do not expose this release as a public build platform for arbitrary users. Untrusted builds require substantially stronger isolation, per-tenant authorization, quotas, abuse controls, billing, and network egress policy.


## Administrator session security

The administrator session uses a signed HTTP-only SameSite=Strict cookie plus a database-backed session version. Password changes and explicit session revocation increment that version so older cookies immediately stop authorizing requests.

State-changing authenticated browser requests reject cross-site `Origin` / `Sec-Fetch-Site` contexts.

### Two-factor recovery

Enabling TOTP generates ten one-time recovery codes. Only SHA-256 hashes of those high-entropy codes are stored. A recovery code is consumed atomically at login.

Generating a new recovery-code set requires:
- the current password
- a valid authenticator code

Old recovery codes become invalid immediately.

## Agent command confidentiality

Sensitive agent command payloads and raw command results are AES-256-GCM encrypted in PostgreSQL. Only redacted/public command summaries remain in normal JSON columns.

Runtime/cron logs are redacted against:
- configured service secret values
- attached managed-database passwords

Completed agent commands are deleted according to `COMMAND_RETENTION_DAYS`.

## Retention

Production defaults are intentionally bounded:

- deployment logs: `LOG_RETENTION_DAYS`
- completed agent commands: `COMMAND_RETENTION_DAYS`
- webhook deliveries: `WEBHOOK_RETENTION_DAYS`
- cron run history: `CRON_RUN_RETENTION_DAYS`
- audit/resolved alerts: `AUDIT_RETENTION_DAYS`
- local backup files: `BACKUP_RETENTION_DAYS`
- unused labeled release images: `IMAGE_RETENTION_HOURS`

My Railway release images are labeled at build time so cleanup targets only platform-managed images.


## Database command credential handling

Managed Redis credentials are not passed through `redis-cli -a <password>` command-line arguments. Runtime health, backup, and restore operations use the container's `REDISCLI_AUTH` environment instead.

Managed PostgreSQL operations run inside the database container using its own environment and local client tools, avoiding cross-version backup clients and unnecessary credential exposure in external process arguments.
