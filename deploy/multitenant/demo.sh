#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

# Deliberately fixed project: commands never search other projects or remove
# volumes implicitly. For another instance, use a separate checkout and invoke
# Compose with its own explicit --project-name.
compose=(docker compose --project-name nightscout-multitenant-demo --env-file .env -f compose.yaml)
case "${1:-}" in
  prepare)
    shift
    exec node prepare.js "$@"
    ;;
  config)
    # Config output contains file references, never generated secret contents.
    exec "${compose[@]}" config --quiet
    ;;
  build)
    exec node build.js
    ;;
  bootstrap)
    node build.js --check-image
    exec "${compose[@]}" --profile ops run --rm bootstrap
    ;;
  up)
    node build.js --check-image
    "${compose[@]}" --profile ops run --rm bootstrap
    exec "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 90 api realtime evaluator tenant-admin ui nginx
    ;;
  demo)
    node build.js --check-image
    exec "${compose[@]}" --profile ops run --rm --no-deps demo
    ;;
  status)
    exec "${compose[@]}" ps -a
    ;;
  stop)
    exec "${compose[@]}" stop
    ;;
  down)
    # Keep database/Vault volumes and private state. Destruction is a separately
    # named operator action, not a surprising side effect of stopping the demo.
    exec "${compose[@]}" down
    ;;
  *)
    echo 'Usage: demo.sh prepare [--bind 169.254.1.1] | config | build | bootstrap | up | demo | status | stop | down' >&2
    exit 64
    ;;
esac
