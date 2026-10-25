# Deploying Kingdom ID

Kingdom ID ships as one container image. Each container serves HTTP and also runs two background loops: the signing-key rotation scheduler and a security-event consumer. Run two or more for availability; the API is stateless, so any instance can serve any request ([proof](../README.md#scaling-out)). It needs **Postgres 15+** and **Redis 7+**, and for the email relay, **Amazon SES** in a region that supports receiving.

There are two supported layouts. For the cheapest production setup, a single $5 Lightsail machine deployed from GitHub, follow **[Kingdom ID on one Lightsail machine](deploy-lightsail.md)**.

| | [AWS (Terraform)](../deploy/aws) | [Single host (Compose)](../deploy/single-host) |
|---|---|---|
| Compute | ECS Fargate, 2+ tasks behind an ALB | 2 containers behind Caddy on one VM |
| Data | RDS Postgres (Multi-AZ, encrypted, TLS required), ElastiCache Redis (encrypted, auth) | Postgres and Redis containers with volumes |
| TLS | ACM certificate on the ALB | Let's Encrypt via Caddy |
| Secrets | Secrets Manager, injected at task start | `.env` file on the host |
| Email relay | Fully wired: SES identity, DKIM, MAIL FROM, DMARC, MX, receipt rule, S3, SNS | Bring your own SES setup ([relay guide](email-relay.md)) |
| Good for | Production | Staging, small deployments |

Neither layout puts anything Kingdom-specific in the image: everything comes from environment variables.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `ISSUER` | yes | The public origin, e.g. `https://id.kingdomwebbuilders.com`. Must be `https` in production. Every token is bound to it; **changing it invalidates every session and token**. |
| `DATABASE_URL` | yes | `postgres://…`; add `?sslmode=require` for RDS. |
| `REDIS_URL` | yes | `redis://` or `rediss://` (TLS). |
| `KEY_ENCRYPTION_KEY` | yes | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts signing keys at rest. **Back it up separately from the database:** without it, the stored keys can't be read and every token stops verifying. |
| `SERVER_SECRET` | yes | 32+ random bytes, base64. Derives CSRF tokens and pairwise subject IDs. **Changing it changes every app's user IDs.** |
| `TRUST_PROXY` | behind a proxy | `true` behind an ALB or Caddy, so client IPs (rate limits, Watchtower) and CDN country headers are read from the proxy. |
| `EMAIL_RELAY_ENABLED`, `RELAY_*`, `AWS_REGION` | for the relay | See the [relay guide](email-relay.md). |
| `RATE_LIMIT_MULTIPLIER` | no | Leave at 1 in production. |
| `KEY_ROTATION_INTERVAL_SECONDS` | no | Default 30 days. |
| `LOG_LEVEL` | no | Default `info`. Logs are JSON on stdout, with credentials redacted. |

## AWS with Terraform

```bash
cd deploy/aws
cp terraform.tfvars.example terraform.tfvars   # set zone, domains, image
terraform init
terraform plan -out plan
terraform apply plan
```

Before relying on it:

1. **Add a remote state backend** (S3 with locking) in `versions.tf`. The state contains the generated database password and secrets.
2. **Leave SES's sandbox** (request production access) so the relay can send to any address.
3. **Publish an image** first: tag a release (see below) and set `image` to it.

What gets created: a VPC with public and private subnets and NAT, an ALB with HTTP→HTTPS redirect and TLS 1.3/1.2 only, ECS Fargate with `desired_count` tasks (circuit-breaker rollback, ECS Exec enabled), RDS Postgres 17, a 2-node ElastiCache Redis with failover, four Secrets Manager secrets, IAM roles scoped to exactly what the app does, and every SES and Route 53 record the relay needs.

## Single host

```bash
cd deploy/single-host
cp .env.example .env   # fill it in; DNS for ISSUER_HOST must point at this machine
docker compose up -d
```

Caddy obtains the certificate on first request. Back up the `postgres` volume and the `.env` file (it holds `KEY_ENCRYPTION_KEY`).

## Releasing

```bash
git tag v1.0.0 && git push --tags
```

The [release workflow](../.github/workflows/release.yml) builds the image and pushes it to `ghcr.io/<owner>/kingdom-id:v1.0.0` with an SBOM and signed build provenance. If the repository variable `AWS_DEPLOY_ROLE_ARN` is set (a role GitHub's OIDC provider can assume, allowed to register task definitions and update the `kingdom-id` service), it also rolls the new image out to ECS and waits for the service to settle. A failed rollout rolls itself back.

**Migrations run on boot.** Instances that start together take a Postgres advisory lock, so they migrate one at a time and the rest find nothing to do. Every migration so far is additive, so old and new versions can run side by side during a rolling deploy.

## Day two

**First admin.** Create an account through the sign-in page (with a passkey; admin pages require one), then:

```bash
# AWS
aws ecs execute-command --cluster kingdom-id --task <task-id> --container kingdom-id \
  --interactive --command "node dist/cli/bin.js users admin you@example.com"
# single host
docker compose exec app-1 node dist/cli/bin.js users admin you@example.com
```

**Register an app:** `kingdom clients create …` (see the [Next.js guide](integrations/nextjs.md)).

**Rotate signing keys now** (otherwise every 30 days): `kingdom keys rotate`. The next key was already published, so relying parties never see an unknown `kid`.

**Health:** `/healthz` is liveness and `/readyz` checks Postgres and Redis. Watch `/admin/alerts` for detection alerts and event-pipeline health (lag, in flight, dead letters). A growing dead-letter count means events are failing to persist.

**Backups:** Postgres holds everything durable: accounts, passkeys, clients, consents, grants, masks, events, signing keys (encrypted). Redis holds only short-lived state and the event buffer; losing it signs no one out but drops in-flight authorization codes and unprocessed events.

## Security checklist

- [ ] `ISSUER` is `https` and matches the public URL exactly.
- [ ] `KEY_ENCRYPTION_KEY` and `SERVER_SECRET` are random, stored in a secret manager, and backed up somewhere other than the database backup.
- [ ] `TRUST_PROXY=true` only when a proxy you control sets `X-Forwarded-For`.
- [ ] Postgres and Redis are reachable only from the app, with TLS where the network isn't private.
- [ ] `RATE_LIMIT_MULTIPLIER` is unset (1).
- [ ] Terraform state is in an encrypted remote backend.
- [ ] The relay's DMARC record is `p=reject` and SES is out of the sandbox.
- [ ] At least one admin account has two passkeys (admin pages require one).
