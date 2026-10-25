# Kingdom ID on one Lightsail machine

The low-cost production layout: one AWS Lightsail instance (the 1 GB plan, about $5 a month) running two Kingdom ID containers, Postgres, Redis and Caddy, with automatic HTTPS. It's the [single-host layout](deploy.md#single-host), deployed from GitHub: after the one-time setup below, pushing a version tag builds the image and rolls it out.

Kingdom ID can't run on Amplify Hosting: it's a long-running server with Postgres, Redis and background work (signing-key rotation, the security event pipeline), not a site served per request.

## One-time setup

### 1. Create the machine

In the [Lightsail console](https://lightsail.aws.amazon.com/):

1. **Create instance**: Linux/Unix, **OS Only → Ubuntu 24.04 LTS**, the **$5** plan (1 GB RAM). Name it `kingdom-id`.
2. **Networking → Create static IP**, attached to `kingdom-id`. (Free while attached.)
3. **Networking → IPv4 Firewall**: add **HTTPS (443)**. SSH (22) and HTTP (80) are already there; Caddy needs 80 to get its certificate.

### 2. Point the domain at it

Where `kingdomwebbuilders.com`'s DNS is managed (Route 53 → Hosted zones, if it's on AWS), add:

| Name | Type | Value |
|---|---|---|
| `id` | A | the static IP |

Check it with `dig +short id.kingdomwebbuilders.com`; it should print the static IP.

### 3. Let GitHub deploy to it

1. Lightsail → **Account → SSH keys**: download the **default key** for the instance's region (a `.pem` file).
2. GitHub → `jwag789/kingdom-id` → **Settings → Secrets and variables → Actions**:
   - **Secrets → New repository secret**: `DEPLOY_SSH_KEY`, with the whole contents of the `.pem` file.
   - **Variables → New repository variable**: `DEPLOY_HOST` = the static IP, and `ISSUER_HOST` = `id.kingdomwebbuilders.com`.
3. Delete the downloaded `.pem` file from your computer when you're done (you can always download it again).

### 4. Release

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The **Release** workflow builds the image, then the `deploy-single-host` job copies [`deploy/single-host`](../deploy/single-host) to the machine and runs `install.sh`. The first run installs Docker, adds swap, generates every secret into `~/kingdom-id/.env` on the machine (they never leave it), and starts everything. It ends by checking `https://id.kingdomwebbuilders.com/readyz`.

### 5. Back up the secrets

On the machine (Lightsail → the instance → **Connect using SSH**):

```bash
sudo cat ~/kingdom-id/.env
```

Save it in your password manager. `KEY_ENCRYPTION_KEY` and `SERVER_SECRET` can't be regenerated: without them every token stops verifying and every app's user IDs change. Turn on **automatic snapshots** for the instance too (Lightsail → the instance → Snapshots), which back up the database volume.

## Register an app

On the machine, for example Cappuccino:

```bash
cd ~/kingdom-id
sudo docker compose exec app-1 node dist/cli/bin.js clients create \
  --name Cappuccino --first-party \
  --redirect-uri https://<cappuccino's domain>/api/auth/kingdom/callback \
  --post-logout-uri https://<cappuccino's domain>/login
```

It prints a `client_id` and a `client_secret` once. Put them straight into the app's environment (for an Amplify app: **Hosting → Environment variables**), not into chat or a file.

Other commands work the same way: `sudo docker compose exec app-1 node dist/cli/bin.js help`.

## Day two

- **Deploy a new version:** push a new tag (`v0.1.1`, …). Releases can also be re-run from the Actions tab.
- **Logs:** `cd ~/kingdom-id && sudo docker compose logs -f app-1 app-2`
- **First admin:** sign up at `https://id.kingdomwebbuilders.com/signup` with a passkey, then `sudo docker compose exec app-1 node dist/cli/bin.js users admin you@example.com`.
- **Not yet wired on this layout:** verification emails are written to the log rather than sent, and the private email relay is off until Amazon SES is set up ([relay guide](email-relay.md)). Apps receive the member's own email address meanwhile.
