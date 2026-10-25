#!/usr/bin/env bash
# Runs the OpenID Foundation conformance suite's Basic OP certification plan
# against a freshly built Kingdom ID, entirely in Docker.
#
#   conformance/run.sh            build, run, export results, tear down
#   KEEP=1 conformance/run.sh     leave the stack up to inspect results at
#                                 https://localhost.emobix.co.uk:8443
set -euo pipefail

# A sleeping laptop pauses Docker mid-test and expires authorization codes.
if [ -z "${CAFFEINATED:-}" ] && command -v caffeinate >/dev/null; then
  CAFFEINATED=1 exec caffeinate -dims "$0" "$@"
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
SUITE_TAG="${SUITE_TAG:-release-v5.3.3}"
SUITE_DIR="$HERE/.suite/$SUITE_TAG"
RESULTS="$HERE/results"
PLAN='oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]'
export SUITE_TAG
compose() { docker compose -f "$HERE/docker-compose.yml" "$@"; }

cleanup() {
  if [ -z "${KEEP:-}" ]; then compose --profile seed down -v --remove-orphans >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# The suite's runner script, from the same release as the images.
if [ ! -d "$SUITE_DIR" ]; then
  echo "fetching conformance suite scripts ($SUITE_TAG)"
  git clone -q --depth 1 --branch "$SUITE_TAG" --filter=blob:none --sparse \
    https://gitlab.com/openid/conformance-suite.git "$SUITE_DIR"
  git -C "$SUITE_DIR" sparse-checkout set scripts
fi
if [ ! -d "$HERE/.suite/venv" ]; then
  python3 -m venv "$HERE/.suite/venv"
  "$HERE/.suite/venv/bin/pip" install -q -r "$SUITE_DIR/scripts/requirements.txt"
fi

echo "building and starting the stack"
compose up -d --build --wait postgres redis idp caddy mongodb server nginx
compose --profile seed run --rm seed

echo "waiting for the suite to come up"
ready=""
for _ in $(seq 1 120); do
  if curl -skf -o /dev/null https://localhost.emobix.co.uk:8443/api/plan?length=1; then ready=1; break; fi
  sleep 2
done
if [ -z "$ready" ]; then
  echo "conformance suite did not start; server logs:"
  compose logs --tail 80 server
  exit 1
fi

rm -rf "$RESULTS" && mkdir -p "$RESULTS"
echo "running $PLAN"
set +e
(
  cd "$SUITE_DIR/scripts"
  CONFORMANCE_SERVER=https://localhost.emobix.co.uk:8443/ \
  CONFORMANCE_SERVER_MTLS=https://localhost.emobix.co.uk:8444/ \
  CONFORMANCE_DEV_MODE=1 \
  "$HERE/.suite/venv/bin/python" run-test-plan.py \
    --export-dir "$RESULTS" \
    --expected-failures-file "$HERE/expected-failures.json" \
    --expected-skips-file "$HERE/expected-skips.json" \
    --verbose \
    "$PLAN" "$HERE/config/basic-op.json"
) 2>&1 | tee "$RESULTS/run.log"
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "conformance run failed (exit $status); idp logs:"
  compose logs --tail 200 idp || true
fi
exit "$status"
