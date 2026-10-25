#!/usr/bin/env bash
# k6 benchmark of the token endpoint: one instance, then two behind the load balancer.
#   VUS=50 DURATION=60s ./run-bench.sh
set -euo pipefail
cd "$(dirname "$0")"
if [ -z "${CAFFEINATED:-}" ] && command -v caffeinate >/dev/null; then CAFFEINATED=1 exec caffeinate -dims "$0" "$@"; fi
trap '[ -z "${KEEP:-}" ] && docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT

VUS="${VUS:-50}"
DURATION="${DURATION:-60s}"
docker compose up -d --build --wait

for run in "one-instance https://lb:9444" "two-instances https://lb:9443"; do
  set -- $run
  echo "== $1: $VUS VUs for $DURATION"
  NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx prepare-load.ts "$VUS" results/load-tokens.json
  docker compose --profile bench run --rm -e TARGET="$2" -e LABEL="$1" -e VUS="$VUS" -e DURATION="$DURATION" k6 run --quiet /scripts/token-refresh.js
done

echo "== environment"
echo "host: $(uname -sm), $(sysctl -n machdep.cpu.brand_string 2>/dev/null || grep -m1 'model name' /proc/cpuinfo | cut -d: -f2)"
echo "docker: $(docker info --format '{{.NCPU}} CPUs, {{.MemTotal}} bytes')"
