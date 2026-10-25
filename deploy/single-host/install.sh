#!/usr/bin/env bash
# Installs or updates Kingdom ID on one Ubuntu machine (a $5 Lightsail
# instance is enough). Safe to re-run: every step checks before it acts, and
# the secrets in .env are generated once and never overwritten.
#
#   sudo ./install.sh <image> <issuer host>
#   sudo ./install.sh ghcr.io/jwag789/kingdom-id:v0.1.0 id.kingdomwebbuilders.com
#
# For a private image, pass registry credentials in the environment
# (GHCR_USER, GHCR_TOKEN); they're used for this pull and then logged out.
# The deploy-single-host workflow does all of this over SSH.
set -euo pipefail

image="${1:?usage: install.sh <image> <issuer host>}"
host="${2:?usage: install.sh <image> <issuer host>}"
cd "$(dirname "$0")"

if [[ $EUID -ne 0 ]]; then
  echo "run with sudo" >&2
  exit 1
fi

if ! command -v docker >/dev/null; then
  echo "==> installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

# A 1 GB machine runs two app containers, Postgres, Redis and Caddy with room
# to spare, but swap keeps an image pull or a burst from OOM-killing one.
if ! swapon --show | grep -q /swapfile; then
  echo "==> adding 1 GB of swap"
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

if [[ ! -f .env ]]; then
  echo "==> generating secrets in $(pwd)/.env"
  umask 077
  # Passwords are hex: they go inside connection URLs, where / + = would not survive.
  cat >.env <<EOF
ISSUER_HOST=$host
ISSUER=https://$host
POSTGRES_PASSWORD=$(openssl rand -hex 24)
REDIS_PASSWORD=$(openssl rand -hex 24)
KEY_ENCRYPTION_KEY=$(openssl rand -base64 32)
SERVER_SECRET=$(openssl rand -base64 32)
# The private email relay needs Amazon SES (docs/email-relay.md). Until then,
# apps receive the member's own address.
EMAIL_RELAY_ENABLED=false
EOF
  echo "    BACK UP this file somewhere safe: without KEY_ENCRYPTION_KEY and"
  echo "    SERVER_SECRET, every token and every app's user IDs are lost."
fi

if ! grep -q "^ISSUER_HOST=$host\$" .env; then
  echo "error: .env is for a different host ($(grep '^ISSUER_HOST=' .env)); changing the issuer invalidates every token" >&2
  exit 1
fi

# Which image to run lives in .env too, so a reboot or a manual
# `docker compose up -d` brings back the deployed version.
sed -i '/^KINGDOM_ID_IMAGE=/d' .env
echo "KINGDOM_ID_IMAGE=$image" >>.env

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:?GHCR_USER is required with GHCR_TOKEN}" --password-stdin >/dev/null
fi
echo "==> pulling $image"
docker compose pull --quiet
if [[ -n "${GHCR_TOKEN:-}" ]]; then
  docker logout ghcr.io >/dev/null
fi

echo "==> starting"
docker compose up -d --remove-orphans

echo "==> waiting for https://$host/readyz"
for _ in $(seq 1 60); do
  if curl -fsS "https://$host/readyz" >/dev/null 2>&1; then
    echo "==> Kingdom ID is live at https://$host"
    exit 0
  fi
  sleep 5
done
echo "Not answering on https://$host yet. Check that DNS points here and ports 80 and 443 are open:" >&2
docker compose ps >&2
docker compose logs --tail 30 caddy app-1 >&2
exit 1
