# My Railway architecture

## Goal

My Railway is a private application platform for trusted repositories owned by the operator. Its job is to turn an exact Git commit into a reproducible container release, verify that release before traffic cutover, operate the resulting service, and preserve enough history and state to recover when something fails.

The private-first architecture deliberately avoids pretending that a single Docker host is a public multi-tenant cloud. The current release has strong operational boundaries for one trusted operator and trusted source repositories.

## Components

### Control plane

The control plane is the only browser-facing management service.

Responsibilities:

- administrator authentication and TOTP enrollment
- project/service configuration
- encrypted environment variables
- domain state and DNS verification
- deployment history
- database/volume metadata
- backup metadata
- runtime/server inventory
- health history and alerts
- audit history
- GitHub webhook verification
- command dispatch to agents

The control plane does **not** mount the Docker socket.

### PostgreSQL

Stores durable platform state:

- users
- projects
- services
- variables
- domains
- deployments
- deployment logs
- servers
- commands
- backups
- database resources
- health state
- alerts
- audit events
- webhook delivery IDs

Sensitive service variables and sensitive agent-command payloads are encrypted before storage.

### Redis / BullMQ

Redis carries deployment jobs between the control plane and deployment worker.

This queue is for orchestration. PostgreSQL remains the source of truth for deployment state.

### Deployment worker

The worker performs source and build operations:

1. obtains a short-lived GitHub App token when configured
2. clones the configured branch
3. checks out the exact requested commit SHA
4. detects the build method
5. builds an immutable Docker image
6. records the image/runtime metadata
7. chooses a healthy runtime
8. assembles the encrypted agent command
9. waits for the agent to finish the cutover
10. marks the deployment active

The worker has Docker-socket access and therefore belongs in the privileged/trusted infrastructure tier.

### Runtime agent

The runtime agent is the host-side execution component.

It:

- reports server health/capacity
- executes deployment commands
- runs pre-deploy migration commands
- starts candidate containers
- probes candidate health
- switches Traefik routing only after health succeeds
- removes previous containers after the grace period
- continuously probes managed services
- performs service stop/restart operations
- provisions managed PostgreSQL/Redis
- manages volume/database backups
- runs restore tests and explicit restores
- collects runtime logs
- executes platform self-tests

Agent API authentication uses a long random bearer token.

### Traefik

Traefik is the only normal public ingress path.

It:

- listens on 80/443
- redirects HTTP to HTTPS
- watches dynamic route files
- obtains and renews ACME certificates
- maps verified hostnames to the active service container

Application containers do not publish their internal web ports to the host.

### Managed application resources

Applications may have:

- an immutable image
- a running container
- encrypted environment variables
- verified domains
- persistent volumes
- managed PostgreSQL
- managed Redis

Databases and Redis stay on the private Docker network.

## Trust boundaries

```text
                     UNTRUSTED INTERNET
                            |
                      80 / 443 only
                            |
                         Traefik
                            |
                 +----------+----------+
                 |                     |
             Control UI            Applications
                 |                     |
                 +----------+----------+
                            |
                    private Docker net
                            |
             +--------------+--------------+
             |              |              |
          PostgreSQL       Redis        Databases

PRIVILEGED HOST BOUNDARY
  - deployment worker -> Docker socket
  - runtime agent     -> Docker socket
  - maintenance       -> Docker socket
```

The browser never talks directly to Docker.

## Deployment state machine

Normal deployment:

```text
QUEUED
  |
CLONING
  |
BUILDING
  |
PUSHING_IMAGE (external registry mode only)
  |
PROVISIONING
  |
agent:
  pre-deploy command
  candidate start
  readiness/health probe
  route switch
  grace period
  previous release removal
  |
RUNNING
```

Failure states include:

- BUILD_FAILED
- DEPLOY_FAILED
- SUPERSEDED
- CANCELLED
- UNHEALTHY (used by the recovery design when a live release degrades)

A failed candidate never receives the public route.

## Rapid-push behavior

Each service has a deployment lock.

When several commits arrive close together:

- older queued work can be marked superseded
- only one deployment for a service may perform the critical release transition at once
- each deployment remains historically visible

The deployment lock must remain valid for the entire deployment. See the operational checklist for a lock-expiration test before high-concurrency use.

## Blue/green-style cutover

The existing container is left running while the candidate starts.

```text
old container -----------------------------> running
new container -> start -> health -> ready
                                |
                                +-> Traefik route switched
                                      |
                                      +-> grace period
                                            |
                                            +-> old container removed
```

This is service-level blue/green behavior on a single Docker host.

## Rollback model

A successful deployment stores:

- immutable image reference
- commit SHA
- detected build type
- actual runtime port
- previous deployment relationship

Rollback creates a **new deployment record** referencing the old image. It does not mutate history.

No rebuild is necessary.

Database state is not automatically reversed. Application rollback and database rollback are intentionally separate operations.

## Secrets model

Two classes of sensitive values exist.

### Long-lived application secrets

Saved in `variables.value_enc`.

Encryption:

- AES-256-GCM
- random nonce per encryption
- key supplied by `SECRET_ENCRYPTION_KEY`

### Short-lived agent payloads

Deployment commands can contain decrypted environment variables. Those payloads are re-encrypted before being written to PostgreSQL and decrypted only when the authenticated agent claims the command.

This prevents ordinary database inspection from exposing the application's environment.

## GitHub security

Recommended source authentication:

- GitHub App
- repository Contents: read
- Metadata: read
- Push webhook subscription
- installation only on allowed repositories

The worker signs a short-lived GitHub App JWT and exchanges it for an installation token.

Clone authentication is passed through Git's HTTP configuration, not embedded in the repository URL.

Webhook security:

- HMAC SHA-256 verification
- unique GitHub delivery ID storage
- duplicate delivery rejection
- asynchronous deployment processing

## Networking

Single-host private mode uses the explicit Docker network:

```text
myrailway
```

Managed service/container names provide internal DNS.

Example:

```text
web -> mr-db-abc123:5432
web -> mr-db-def456:6379
```

Only Traefik has public 80/443 listeners.

Control port 8080 is bound to localhost only.

## Domain lifecycle

```text
domain saved
   |
waiting for DNS
   |
operator points A/CNAME
   |
Verify
   |
verified=true
   |
next deployment writes Traefik route
   |
ACME certificate
   |
HTTPS active
```

## Storage

### Platform PostgreSQL

Docker volume:

```text
postgres-data
```

### Redis

Docker volume:

```text
redis-data
```

### Backup storage

Explicit volume:

```text
myrailway-backups
```

The runtime agent and platform-backup service mount the same volume. Child Docker backup jobs mount this volume by its explicit Docker name, avoiding path-namespace problems between containers and the host Docker daemon.

### Application volumes

Each application persistent volume has its own Docker volume name.

Deleting service metadata intentionally does not silently delete the underlying Docker volume.

## Backups

Three important backup classes exist.

### Control-plane database

`pg_dump` custom data compressed to the shared backup volume.

### Application volume

A read-only mount is archived to a tar.gz file.

### Managed database

PostgreSQL:

- `pg_dump -Fc`

Redis:

- SAVE
- copy RDB

Restore tests validate the backup format before a real restore is attempted.

Offsite replication is optional through restic.

## Observability

The agent reports every 10 seconds.

Server telemetry:

- heartbeat
- CPU count
- load average
- memory
- disk
- running container count

Service telemetry:

- running state
- HTTP result
- health status
- latency
- consecutive failures

Alerts:

- service unhealthy
- server offline
- disk low
- backup failed

An optional outbound webhook can deliver alerts elsewhere.

## Automatic rollback

`AUTO_ROLLBACK=false` by default.

When enabled, repeated runtime-health failures may deploy the previous known-good image.

Keep this disabled for applications with database migrations until the migration strategy is explicitly backward-compatible.

## Disaster-recovery boundary

The system is not disaster-resistant until the following are kept off-host:

- control-plane PostgreSQL backup
- application/database backups
- `SECRET_ENCRYPTION_KEY`
- GitHub App recovery material
- infrastructure/DNS knowledge

The Git repositories themselves remain in GitHub (and may later be mirrored to Forgejo).

## Why Kubernetes is not required for v1

The current goal is a private single-host platform.

Docker + Traefik + an explicit runtime agent already provides:

- isolation
- health gating
- service discovery
- restart policy
- resource limits
- ingress
- persistent volumes
- databases
- release history

Kubernetes becomes useful later if requirements include:

- multi-host service rescheduling
- replicas across machines
- cluster-native persistent storage
- multi-region orchestration
- large tenant counts

Adding it earlier would increase operational complexity without fixing the highest-risk private-cloud problems.

## Public multi-tenant future

Before accepting untrusted users, add:

- isolated ephemeral build VMs/microVMs
- per-tenant authorization and organizations
- quota enforcement
- usage metering
- billing
- abuse controls
- outbound network controls
- tenant-specific runtime isolation
- image-signing / provenance policy
- malware/crypto-mining controls
- multi-host routing
- registry authentication/TLS
- stronger key management/KMS
- support/audit retention policy

That should be a separate security milestone, not a toggle on the private v1.
