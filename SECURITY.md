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
