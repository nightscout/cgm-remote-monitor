#!/usr/bin/env bash
# Disposable native harness for the nine-stage owner/OIDC matrix.
#
#   tests/native/oidc-matrix/run.sh --out <report-dir> [--only <stage,...>] [--control <group>:<id>,...]
#
# Generates TLS material into a private temp dir, starts PostgreSQL, MongoDB
# and Vault from compose.yaml (digest-pinned, unique project name, loopback
# ephemeral ports), hands the mapped ports to run.cjs, and always tears the
# containers and volumes down on exit. The temp dir (keys, passwords, Vault
# tokens) is removed on exit; only redacted logs land in --out.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=$2; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[ -n "$OUT" ] || { echo "usage: run.sh --out <dir> [--only a,b] [--control group:id,...]" >&2; exit 2; }
mkdir -p "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PROJECT="oidcmatrix-${STAMP,,}-$$"
STATE=$(mktemp -d "${TMPDIR:-/tmp}/oidc-matrix-XXXXXXXX")
chmod 700 "$STATE"
COMPOSE=(docker compose -p "$PROJECT" -f "$HERE/compose.yaml")
export OIDC_MATRIX_STATE="$STATE"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$OUT/commands.log" >&2; }
run() { log "+ $*"; "$@"; }
cleanup() {
  code=$?
  log "+ ${COMPOSE[*]} logs --no-color --timestamps"
  "${COMPOSE[@]}" logs --no-color --timestamps > "$STATE/service-logs.txt" 2>&1 || true
  if [ -f "$STATE/redact.json" ]; then node "$HERE/redact.cjs" "$STATE/redact.json" < "$STATE/service-logs.txt" > "$OUT/service-logs.log" || cp "$STATE/service-logs.txt" "$OUT/service-logs.UNREDACTED.log"; fi
  log "+ ${COMPOSE[*]} down -v --remove-orphans"
  "${COMPOSE[@]}" down -v --remove-orphans >>"$OUT/compose-down.log" 2>&1 || log "compose down returned $?"
  remaining=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | wc -l)
  log "containers remaining for project $PROJECT: $remaining"
  rm -rf "$STATE"
  log "exit $code"
  exit "$code"
}
trap cleanup EXIT INT TERM

mkdir -p "$STATE/tls" "$STATE/vault" "$STATE/tools"
log "project=$PROJECT state=$STATE"
# Private CA and Vault server certificate (SANs 127.0.0.1 and localhost); the
# CA is handed to Node through NODE_EXTRA_CA_CERTS so Vault HTTPS is verified,
# never bypassed. A separate self-signed certificate serves the HTTPS fixtures
# (the stage transport and the pinned client trust that leaf as their CA).
run openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj '/CN=oidc-matrix synthetic CA' \
  -keyout "$STATE/tls/ca.key" -out "$STATE/tls/ca.crt" 2>>"$OUT/openssl.log"
run openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj '/CN=vault' \
  -keyout "$STATE/tls/vault-server.key" -out "$STATE/tls/vault-server.csr" 2>>"$OUT/openssl.log"
printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n' > "$STATE/tls/san.ext"
run openssl x509 -req -in "$STATE/tls/vault-server.csr" -CA "$STATE/tls/ca.crt" -CAkey "$STATE/tls/ca.key" -CAcreateserial \
  -out "$STATE/tls/vault-server.crt" -days 2 -extfile "$STATE/tls/san.ext" 2>>"$OUT/openssl.log"
run openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj '/CN=oidc-matrix fixture' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' -keyout "$STATE/tls/fixture.key" -out "$STATE/tls/fixture.crt" 2>>"$OUT/openssl.log"
# The Vault image runs as its own service user; the server key must be readable by it.
chmod 644 "$STATE/tls/vault-server.key" "$STATE/tls/vault-server.crt" "$STATE/tls/ca.crt"
chmod 600 "$STATE/tls/ca.key" "$STATE/tls/fixture.key"
cat > "$STATE/vault/harness.hcl" <<'HCL'
disable_mlock = true
ui = false
api_addr = "https://127.0.0.1:8200"
storage "inmem" {}
listener "tcp" {
  address = "0.0.0.0:8200"
  tls_cert_file = "/run/ns-tls/server.crt"
  tls_key_file = "/run/ns-tls/server.key"
}
HCL
chmod 644 "$STATE/vault/harness.hcl"
openssl rand -hex 32 > "$STATE/pg-password"; chmod 644 "$STATE/pg-password"
for t in bash curl jq dirname basename cat; do cp "$(command -v "$t")" "$STATE/tools/$t"; done
chmod 755 "$STATE/tools"/*

run "${COMPOSE[@]}" up -d --wait --wait-timeout 180 >>"$OUT/compose-up.log" 2>&1
port() { "${COMPOSE[@]}" port "$1" "$2" | sed 's/.*://'; }
PG_PORT=$(port postgres 5432); MONGO_PORT=$(port mongo 27017); VAULT_PORT=$(port vault 8200)
log "mapped ports postgres=$PG_PORT mongo=$MONGO_PORT vault=$VAULT_PORT"
"${COMPOSE[@]}" ps --format json > "$OUT/compose-ps.json"
export NODE_EXTRA_CA_CERTS="$STATE/tls/ca.crt"
run node "$HERE/run.cjs" --out "$OUT" --state "$STATE" --project "$PROJECT" \
  --pg-port "$PG_PORT" --mongo-port "$MONGO_PORT" --vault-port "$VAULT_PORT" "${ARGS[@]}"
