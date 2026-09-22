# Production launch checklist

Do not migrate a critical application until this checklist is completed on the actual server.

## Host

- [ ] Dedicated or appropriately isolated Linux host is provisioned.
- [ ] Docker Engine is current and supported.
- [ ] Docker Compose v2 is installed.
- [ ] Server has adequate SSD storage.
- [ ] Server has adequate CPU/RAM for expected peak workload.
- [ ] SSH key authentication is enabled.
- [ ] Password SSH login is disabled or strongly restricted.
- [ ] Root login policy is deliberate.
- [ ] Host firewall allows only required public ports.
- [ ] 80/tcp is open.
- [ ] 443/tcp is open.
- [ ] 8080 is **not** publicly exposed.
- [ ] PostgreSQL is not publicly exposed.
- [ ] Redis is not publicly exposed.
- [ ] Docker daemon TCP API is not publicly exposed.
- [ ] OS security updates are installed.
- [ ] Host time synchronization is correct.

## Bootstrap secrets

- [ ] `SESSION_SECRET` was generated randomly.
- [ ] `SECRET_ENCRYPTION_KEY` decodes to exactly 32 random bytes.
- [ ] Offline copy of `SECRET_ENCRYPTION_KEY` exists.
- [ ] `AGENT_TOKEN` is random and long.
- [ ] `POSTGRES_PASSWORD` is random.
- [ ] `GITHUB_WEBHOOK_SECRET` is random.
- [ ] No production secret is committed to Git.
- [ ] `.env` permissions are restricted.
- [ ] Temporary `ADMIN_BOOTSTRAP_PASSWORD` is removed after use.

## Administrator security

- [ ] First administrator exists.
- [ ] Strong password is used.
- [ ] TOTP is enabled.
- [ ] Login succeeds with TOTP.
- [ ] Login without TOTP fails after 2FA enablement.
- [ ] Repeated invalid password attempts trigger throttling.
- [ ] Session cookie is Secure when using the public hostname.

## GitHub

- [ ] GitHub App created.
- [ ] App installed only on intended repositories.
- [ ] Contents permission is read-only.
- [ ] Metadata permission is available.
- [ ] Push webhook is subscribed.
- [ ] Webhook URL points to the control-plane HTTPS hostname.
- [ ] Webhook secret matches.
- [ ] Short-lived App authentication works on a private test repository.
- [ ] Invalid webhook signature is rejected.
- [ ] Duplicate webhook delivery is ignored.

## Control plane

- [ ] `/healthz` returns OK.
- [ ] Dashboard works over HTTPS.
- [ ] Security headers are present.
- [ ] Platform self-test passes.
- [ ] PostgreSQL migrations complete without errors.
- [ ] Redis is healthy.
- [ ] Audit events appear after operator actions.
- [ ] Alerts page loads.
- [ ] Runtime server appears online.

## DNS and TLS

- [ ] Control-plane DNS points to the correct public IP.
- [ ] Application-domain DNS verification succeeds.
- [ ] HTTP redirects to HTTPS.
- [ ] Valid certificate is issued.
- [ ] Certificate storage file is protected.
- [ ] Traefik can restart without losing certificate state.
- [ ] Certificate renewal path has been reviewed.

## Deployment happy path

Use a disposable test repository.

- [ ] Create project.
- [ ] Manual deploy succeeds.
- [ ] Build logs are visible.
- [ ] Candidate health check succeeds.
- [ ] Domain becomes reachable.
- [ ] Application receives HTTPS traffic.
- [ ] Deployment becomes RUNNING.
- [ ] Server/container metrics update.
- [ ] Runtime live logs can be refreshed.
- [ ] Known secret values do not appear unredacted in saved runtime logs.

## Git auto-deploy

- [ ] Push a harmless test commit.
- [ ] Webhook creates deployment.
- [ ] Exact pushed SHA is checked out.
- [ ] New release becomes active.
- [ ] Old release becomes SUPERSEDED.
- [ ] No manual action is needed.

## Rapid-push test

Push at least three commits quickly.

- [ ] Platform does not end on an older commit.
- [ ] Only the intended latest deployment is active.
- [ ] No duplicate application containers remain.
- [ ] Deployment history remains understandable.
- [ ] Service lock does not expire during a deliberately slow build.

## Failed-build test

Push intentionally broken build code.

- [ ] Build becomes BUILD_FAILED.
- [ ] Existing production container remains running.
- [ ] Existing route is unchanged.
- [ ] Failure logs explain the problem.

## Failed-health test

Deploy code that starts but fails its configured health endpoint.

- [ ] Candidate container is started.
- [ ] Candidate fails health check.
- [ ] Candidate is removed.
- [ ] Existing production route remains active.
- [ ] Deployment becomes DEPLOY_FAILED.

## Rollback test

- [ ] Keep at least two successful release images.
- [ ] Roll back to the older one.
- [ ] Rollback does not rebuild source.
- [ ] Exact old runtime port is reused.
- [ ] Traffic switches to rollback release.
- [ ] Rollback release health succeeds.

## Restart/reboot test

- [ ] Restart control container.
- [ ] Existing app remains reachable.
- [ ] Restart worker.
- [ ] Existing app remains reachable.
- [ ] Restart agent.
- [ ] Existing app remains reachable.
- [ ] Reboot the Docker host.
- [ ] Platform containers return.
- [ ] Application containers return.
- [ ] Managed database containers return.
- [ ] Routes/certificates remain valid.
- [ ] Self-test passes after reboot.

## Agent failure test

- [ ] Stop runtime agent for >45 seconds.
- [ ] Existing application remains reachable.
- [ ] Server-offline alert appears.
- [ ] New deployment cannot incorrectly claim success.
- [ ] Start agent.
- [ ] Server returns online.

## Disk alert test

On a non-production test host or controlled filesystem:

- [ ] Simulate low free disk.
- [ ] Warning/critical disk alert appears.
- [ ] Alert resolves after space is recovered.

## Persistent volume

- [ ] Attach a test volume.
- [ ] Application writes test data.
- [ ] Redeploy application.
- [ ] Data remains.
- [ ] Manual volume backup completes.
- [ ] Backup file is present in `myrailway-backups`.
- [ ] Backup permissions are restrictive.
- [ ] Test restore passes.
- [ ] Real restore to a disposable test volume succeeds.

## Managed PostgreSQL

- [ ] Create PostgreSQL from project screen.
- [ ] Resource reaches running.
- [ ] `DATABASE_URL` is automatically attached.
- [ ] Application can connect.
- [ ] Database is not reachable from public Internet.
- [ ] Backup completes.
- [ ] Backup validation passes.
- [ ] Restore succeeds on test data.
- [ ] Attached application is stopped before destructive restore.
- [ ] Application is redeployed and reconnects after restore.

## Managed Redis

- [ ] Create Redis from project screen.
- [ ] `REDIS_URL` is attached.
- [ ] Application can authenticate.
- [ ] Redis is not public.
- [ ] Backup completes.
- [ ] RDB validation passes.
- [ ] Restore succeeds.

## Migrations

For applications using schema migrations:

- [ ] Pre-deploy command is configured.
- [ ] Migration failure prevents route cutover.
- [ ] Migration is backward-compatible with the previous application version, **or**
- [ ] auto rollback remains disabled.
- [ ] Database rollback procedure is documented separately.

## Automatic health monitoring

- [ ] Runtime health updates approximately every agent heartbeat.
- [ ] Three failed probes create a critical alert.
- [ ] Recovery resolves the health alert.
- [ ] Health path is cheap and does not mutate data.

## Automatic rollback

Only enable after migration safety has been proven.

- [ ] `AUTO_ROLLBACK=true` tested on a disposable app.
- [ ] Unhealthy release is not later treated as the known-good target.
- [ ] Previous release is restored correctly.
- [ ] Alert explains why rollback happened.

## Backups

- [ ] `AUTO_BACKUPS=true`.
- [ ] Application-volume backup is created automatically.
- [ ] Managed-database backup is created automatically.
- [ ] Control-plane database dump is created daily.
- [ ] Backup retention is configured.
- [ ] Expired files are cleaned.
- [ ] Backup disk usage is monitored.

## Offsite disaster recovery

- [ ] Restic repository is on a different failure domain.
- [ ] Restic password is stored safely.
- [ ] `restic snapshots` shows current backups.
- [ ] `restic check` succeeds.
- [ ] A backup has been restored to a second machine.
- [ ] Control-plane DB has been restored successfully.
- [ ] At least one application database has been restored.
- [ ] At least one persistent volume has been restored.
- [ ] Recovery does not depend on the original host disk.

## Alert delivery

If using an external webhook:

- [ ] `ALERT_WEBHOOK_URL` is configured.
- [ ] Test critical alert reaches the receiver.
- [ ] Receiver does not expose platform secrets.
- [ ] Alert failure does not crash the control plane.

## Maintenance

- [ ] Automated maintenance container is running.
- [ ] Builder cache is pruned.
- [ ] Stopped containers are pruned.
- [ ] Rollback images are preserved.
- [ ] Persistent volumes are not automatically pruned.
- [ ] Maintenance does not delete active images.

## CI

Latest main-branch CI must pass:

- [ ] dependency install
- [ ] TypeScript compile
- [ ] browser JS syntax
- [ ] unit tests
- [ ] shell syntax
- [ ] Compose config
- [ ] Docker image build
- [ ] live control-plane smoke test

## First real migration

Do **not** migrate the most important production site first.

- [ ] Choose a low-risk application.
- [ ] Deploy it.
- [ ] Observe it for a full normal usage cycle.
- [ ] Perform a routine deployment.
- [ ] Perform a rollback.
- [ ] Verify backups.
- [ ] Verify restore test.
- [ ] Reboot host during a maintenance window.
- [ ] Only then plan the first critical migration.

## Public hosting gate

These are intentionally **not** required for private v1, but are mandatory before allowing arbitrary outside users:

- [ ] build jobs isolated in disposable VM/microVM boundary
- [ ] tenant organizations and RBAC
- [ ] per-tenant CPU/RAM/disk quotas
- [ ] runtime tenancy isolation
- [ ] outbound egress controls
- [ ] malware/abuse/crypto-mining controls
- [ ] metering
- [ ] billing
- [ ] limits/rate policy
- [ ] authenticated TLS image registry
- [ ] customer audit log
- [ ] support/recovery process
- [ ] data-retention policy
- [ ] legal/privacy/security review
