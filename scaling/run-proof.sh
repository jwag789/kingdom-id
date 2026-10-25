#!/usr/bin/env bash
# Builds the two-instance stack and runs the statelessness proof against it.
set -euo pipefail
cd "$(dirname "$0")"
if [ -z "${CAFFEINATED:-}" ] && command -v caffeinate >/dev/null; then CAFFEINATED=1 exec caffeinate -dims "$0" "$@"; fi
trap '[ -z "${KEEP:-}" ] && docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT

docker compose up -d --build --wait
# The local load balancer uses Caddy's internal CA; trust is skipped for this script only.
NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx prove.ts
