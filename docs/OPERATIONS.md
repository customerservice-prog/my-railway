# Operations and recovery runbook

This runbook is for the private single-host release of My Railway.

## Normal health

Platform:

```bash
docker compose ps
```

Expected core services:

- postgres: healthy
- redis: healthy
- control: running
- worker: running
- agent: running
- traefik: running
- maintenance: running
- platform-backup: running

Quick operator command:

```bash
./scripts/emergency.sh status
```

Control-plane health:

```bash
curl -fsS http://127.0.0.1:8080/healthz
```

Expected:

```json
{"status":"ok","component":"control-plane"}
```

## Platform logs

```bash
./scripts/emergency.sh logs
```

Or by service:

```bash
docker compose logs --tail=300 control
docker compose logs --tail=300 worker
docker compose logs --tail=300 agent
docker compose logs --tail=300 traefik
```

## Restart management components

Restart control/worker/agent without intentionally touching running application containers:

```bash
./scripts/emergency.sh restart-platform
```

Because application containers run directly under the host Docker daemon, restarting the management containers does not automatically stop deployed applications.

## Run the platform self-test

Dashboard:

**Run self-test**

It verifies Docker, networking, route storage, backup storage, disposable containers, and Docker-volume lifecycle.

Run this after:

- platform installation
- Docker upgrade
- host reboot
- storage migration
- major My Railway update

## Application deployment failure

1. Open Deployments.
2. Open the failed deployment logs.
3. Identify the phase.
4. Do **not** delete the previous deployment.

Common phases:

### CLONING

Check:

- GitHub App installation
- App permissions
- installation ID
- private key
- repository spelling
- branch spelling

### BUILDING

Check:

- Dockerfile
- package install
- language version
- build command
- root directory

### PROVISIONING / agent timeout

Check:

```bash
docker compose ps agent
docker compose logs --tail=300 agent
```

Verify dashboard Servers page shows the runtime online.

### Health failure

The candidate should have been removed and the previous route should remain active.

Check the application's configured:

- internal port
- health path
- startup time
- required environment variables

## Roll back an application

Dashboard:

1. Open Deployments.
2. Find a previous known-good deployment.
3. Click **Rollback here**.
4. Observe the new deployment.

Rollback uses the retained image and its recorded runtime metadata.

Do not assume the database schema was rolled back.

## Stop a broken application immediately

Dashboard:

Project -> **Stop**

Emergency shell:

```bash
./scripts/emergency.sh stop-service SERVICE_ID
```

This removes managed application containers for the service and removes its route file.

## Runtime agent offline

Symptoms:

- critical server-offline alert
- no new deployments complete
- existing applications may still continue running

Check:

```bash
docker compose ps agent
docker compose logs --tail=300 agent
```

Restart:

```bash
docker compose restart agent
```

Existing application traffic does not require the agent continuously; Traefik talks directly to application containers.

## Control plane offline

Existing applications may continue running because Traefik route files and application containers are independent of the dashboard.

Check:

```bash
docker compose ps control postgres redis
docker compose logs --tail=300 control postgres redis
```

Restart:

```bash
docker compose restart postgres redis control worker agent
```

## Redis failure

Redis contains deployment queue state, not the primary platform database.

Check:

```bash
docker compose logs --tail=300 redis
docker compose restart redis
```

Queued jobs may need to be re-created if Redis data is unrecoverable.

Do not treat Redis as the only record of a deployment; PostgreSQL contains deployment history.

## Control PostgreSQL failure

Do not initialize a fresh database until you have checked backups.

Backup files live in:

```text
Docker volume: myrailway-backups
platform/control-*.sql.gz
```

Inspect:

```bash
docker run --rm -v myrailway-backups:/backups alpine:3.20 find /backups -maxdepth 3 -type f -print
```

## Manual platform database backup

```bash
./scripts/emergency.sh backup
```

## Restore the control-plane PostgreSQL database

Use a maintenance window.

1. Back up the current state even if it is suspected bad.
2. Stop control/worker/agent.
3. Choose the backup.
4. Recreate/clean the target database.
5. restore.
6. restart.

Example:

```bash
docker compose stop control worker agent

# Locate a backup:
docker run --rm -v myrailway-backups:/backups alpine:3.20 find /backups/platform -type f -name 'control-*.sql.gz' -print

# Example restore:
docker run --rm   --network myrailway   -v myrailway-backups:/backups:ro   -e PGPASSWORD="$POSTGRES_PASSWORD"   postgres:17-alpine   sh -lc 'gzip -dc /backups/platform/control-YYYYMMDDTHHMMSSZ.sql.gz | psql -h postgres -U myrailway -d myrailway'

docker compose start control worker agent
```

For a full clean restore, recreate the `myrailway` database before loading the dump.

## Application volume restore

Use the dashboard Backups page.

The restore action:

- requires explicit confirmation
- stops the attached service
- replaces the persistent volume contents

After restore, redeploy the application.

Before a real restore, run **Test restore** on the backup.

## Managed PostgreSQL restore

Use Backups -> Restore on a completed database backup.

The attached application is stopped first.

After restore:

1. redeploy the application
2. run application smoke tests
3. confirm database migrations are consistent with that release

## Managed Redis restore

Restore stops Redis, replaces `dump.rdb`, then starts Redis again.

If an application is attached, it is stopped first.

Redeploy/restart the application afterward.

## Disk pressure

Disk alerts begin when less than 10% remains.

Check:

```bash
df -h
docker system df
docker volume ls
```

Safe cleanup:

```bash
./scripts/maintenance.sh
```

Do not casually run:

```bash
docker system prune -a --volumes
```

That can destroy rollback images or application data.

## Docker host reboot

Docker restart policies should bring core/platform and managed resources back.

After reboot:

```bash
docker compose up -d
./scripts/emergency.sh status
```

Then run the dashboard self-test.

## Certificate problems

Check Traefik:

```bash
docker compose logs --tail=300 traefik
```

Verify:

- DNS points at the public IP
- ports 80/443 are open
- another process is not using 80/443
- ACME email is configured
- `data/acme.json` is mode 600

Do not repeatedly delete ACME state while debugging; certificate authorities enforce rate limits.

## GitHub webhooks not deploying

Verify:

- GitHub App webhook URL
- webhook secret
- push event subscription
- service Auto Deploy enabled
- repository full name matches
- branch matches

GitHub redeliveries are safe because delivery IDs are deduplicated.

## Secret-encryption key loss

`SECRET_ENCRYPTION_KEY` is not recoverable from the database.

If it is lost, encrypted application secrets, GitHub-sensitive queued payloads, and managed database passwords may no longer be decryptable.

Keep an offline protected copy.

If compromise is suspected:

1. rotate application secrets
2. generate a new encryption key
3. re-save every secret using the new key
4. rotate database credentials
5. rotate GitHub App material if needed

Do not simply change the encryption key while old encrypted rows still exist.

## Offsite backup verification

Restic:

```bash
restic snapshots
restic check
```

At least quarterly, restore a copy onto a separate machine rather than only running `restic check`.

## Entire-host loss

Required material:

- source repo for My Railway
- fresh Linux/Docker host
- `.env` values or securely stored equivalents
- `SECRET_ENCRYPTION_KEY`
- offsite restic repository
- DNS access
- GitHub App configuration

High-level recovery:

1. provision fresh Linux host
2. install Docker + Compose
3. clone My Railway
4. recreate `.env`
5. run bootstrap
6. start PostgreSQL/Redis/control
7. restore the control-plane DB
8. restore backup data from restic to `myrailway-backups`
9. start worker/agent/Traefik
10. redeploy stateless applications from immutable images or Git
11. restore stateful volumes/databases
12. repoint DNS if the IP changed
13. run platform self-test
14. run application smoke tests

## Upgrade procedure

Before platform upgrade:

```bash
./scripts/emergency.sh backup
git fetch origin
git log --oneline HEAD..origin/main
```

Then:

```bash
git pull --ff-only
docker compose build
docker compose up -d
```

The control plane automatically applies ordered SQL migrations.

After upgrade:

- verify CI for the commit is green
- check `docker compose ps`
- run platform self-test
- check Alerts
- deploy a non-critical test application

## Never do these casually

- delete `postgres-data`
- delete application Docker volumes
- remove `SECRET_ENCRYPTION_KEY`
- expose PostgreSQL/Redis to the Internet
- expose Docker TCP socket
- publish port 8080 publicly without the HTTPS proxy
- run arbitrary untrusted customer source builds
- use `docker system prune --volumes` on production
- disable backups because disk is full without replacing them with offsite retention


## Cron job failure

Cron releases are published like application releases, but scheduled executions are one-off containers.

If a cron run fails:

1. open the project and inspect Recent cron runs;
2. inspect exit code and redacted logs;
3. verify the published deployment is still RUNNING;
4. verify required secrets/volumes still exist;
5. use Run now after fixing the problem.

A timeout returns exit code 124.

If the runtime is offline or draining when a run becomes due, the run is marked failed and an alert is created instead of silently disappearing.

## Drain a runtime server

Dashboard -> Servers -> Drain.

Drain mode prevents new scheduling to that runtime. Existing containers keep running.

Before host maintenance:

1. Drain.
2. Confirm no deployment/build/database placement is being started on the host.
3. Perform maintenance.
4. Run platform self-test.
5. Resume scheduling.

## Removing domains

Removing a domain from the project screen immediately queues a live route refresh on the current runtime. If no running application container exists, the service route is removed.

## Cancelling deployments

Cancellation is intentionally limited to the QUEUED state. Once deployment work has started, use normal failure/rollback/stop controls rather than pretending an in-flight build or runtime transition was atomically cancelled.


## Maintenance mode

Use the project screen -> Maintenance mode for planned work.

Enable maintenance before a risky database or infrastructure operation.

Behavior:

1. My Railway saves maintenance state on the service.
2. The runtime starts a dedicated resource-limited responder.
3. Traefik switches verified domains to that responder.
4. The application container remains running on the private network.
5. Visitors receive HTTP 503.
6. Deployments may continue while maintenance remains active.
7. Disable maintenance to remove the responder and restore the current application route.

If disabling maintenance fails:

- check the runtime agent
- confirm the application container still exists/runs
- use **Refresh live logs**
- redeploy the current known-good release if needed
- the maintenance responder can be removed manually with:

```bash
docker ps -a --filter label=myrailway.maintenance.service=SERVICE_ID
docker rm -f CONTAINER_NAME
```

Then redeploy or use the domain route refresh path.


## Verified restore behavior

The CI recovery drill exercises destructive restore, not only archive-format validation.

### Persistent volume

1. Write known data.
2. Create backup.
3. Validate backup archive.
4. Corrupt/change live data.
5. Restore backup.
6. Verify original file contents return.

### Redis

Managed Redis runs with AOF enabled. A restored RDB must therefore be converted into a fresh AOF before normal activation.

Restore sequence:

1. stop managed Redis;
2. remove stale AOF files;
3. install backed-up `dump.rdb`;
4. start temporary Redis with AOF disabled so the RDB is loaded;
5. enable AOF from the restored in-memory dataset;
6. wait for AOF rewrite success;
7. stop temporary Redis;
8. start the normal managed Redis container;
9. require authenticated PONG;
10. verify original application data.

Redis authentication is passed with `REDISCLI_AUTH` rather than command-line `-a`, keeping passwords out of process arguments.

### PostgreSQL

1. Create known table/row.
2. Create custom-format dump.
3. Validate dump using `pg_restore --list`.
4. Change live row.
5. Restore with `pg_restore --clean --if-exists`.
6. Verify original row returns.

### My Railway control plane

The platform backup checksum records only the archive filename, not an absolute source path.

CI:

1. creates a real control-plane backup;
2. verifies the checksum after mounting the backup at a different path;
3. creates a fresh PostgreSQL database;
4. restores the dump into that fresh database;
5. verifies administrator data;
6. verifies project data;
7. verifies schema migration history;
8. drops the disposable restore database.

This is the minimum recovery proof required before moving a critical workload.
