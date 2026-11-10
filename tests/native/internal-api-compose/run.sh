#!/usr/bin/env bash
# Separated-process composed private listener instrument over a Compose network.
#
#   tests/native/internal-api-compose/run.sh --out <report-dir> [--api-shutdown-ms N] [--control blanket-window|early-drop]
#
# Starts api/realtime/evaluator/tenant-admin component processes on an internal
# Compose network (HTTP by service DNS name; realtime over a Unix socket in a
# shared 0700 bind mount), runs the in-network driver scenario, then the drain
# step (hold one API response for 1.5 s, SIGTERM the API container, observe
# the wait, release). Each role process serves its contracts on one
# serve.internal (NS_SERVE_INTERNAL_*), peers by NS_<ROLE>_INTERNAL_*.
# --api-shutdown-ms sets the API's NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS
# (default 5000): above the hold the held caller must receive its response;
# below it the caller must see SOCKET_IPC_UNAVAILABLE no earlier than the
# deadline while the handler still finishes. Always removes the project's
# containers and network on exit. Controls run against a scratch copy of the
# source: `blanket-window` (listener-wide window, expected red in the
# scenario) and `early-drop` (close() destroys connections at shutdown start,
# expected red in the drain).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SOURCE=$(cd "$HERE/../../.." && pwd)
OUT="" CONTROL="" API_SHUTDOWN_MS=5000 HOLD_MS=1500
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=$2; shift 2 ;;
    --control) CONTROL=$2; shift 2 ;;
    --api-shutdown-ms) API_SHUTDOWN_MS=$2; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "usage: run.sh --out <dir> [--api-shutdown-ms N] [--control blanket-window|early-drop]" >&2; exit 2; }
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PROJECT="ns-lc-${STAMP,,}-$$"
STATE=$(mktemp -d "${TMPDIR:-/tmp}/ns-lc-XXXXXXXX")
mkdir -m 700 "$STATE/state" "$STATE/shared"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$OUT/commands.log" >&2; }
if [ "$CONTROL" = blanket-window ] || [ "$CONTROL" = early-drop ]; then
  mkdir "$STATE/src"
  (cd "$SOURCE" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf - ) | tar -C "$STATE/src" -xf -
  ln -s "$SOURCE/node_modules" "$STATE/src/node_modules"
  node "$HERE/$CONTROL-control.cjs" "$STATE/src/lib/server/internal-api/transport.js"
  RUN_SOURCE="$STATE/src"
elif [ -n "$CONTROL" ]; then echo "unknown control $CONTROL" >&2; exit 2
else RUN_SOURCE="$SOURCE"; fi
export NS_LC_SOURCE="$RUN_SOURCE" NS_LC_STATE="$STATE" NS_LC_UID=$(id -u) NS_LC_GID=$(id -g) NS_LC_API_SHUTDOWN_MS="$API_SHUTDOWN_MS"
COMPOSE=(docker compose -p "$PROJECT" -f "$HERE/compose.yaml")
cleanup() {
  code=$?
  "${COMPOSE[@]}" logs --no-color --timestamps > "$OUT/service-logs.log" 2>&1 || true
  cp "$STATE"/state/*.json "$STATE"/state/*.jsonl "$OUT/" 2>/dev/null || true
  log "+ ${COMPOSE[*]} down -v --remove-orphans"
  "${COMPOSE[@]}" --profile driver down -v --remove-orphans >>"$OUT/compose-down.log" 2>&1 || log "compose down returned $?"
  log "containers remaining for project $PROJECT: $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | wc -l)"
  log "networks remaining for project $PROJECT: $(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l)"
  rm -rf "$STATE"
  log "exit $code"; exit "$code"
}
trap cleanup EXIT INT TERM
log "project=$PROJECT source=$RUN_SOURCE control=${CONTROL:-none} api-shutdown-ms=$API_SHUTDOWN_MS head=$(git -C "$SOURCE" rev-parse HEAD) dirty=$(git -C "$SOURCE" status --porcelain | wc -l)"
log "+ ${COMPOSE[*]} up -d api realtime evaluator tenant-admin"
"${COMPOSE[@]}" up -d api realtime evaluator tenant-admin >>"$OUT/compose-up.log" 2>&1
"${COMPOSE[@]}" ps --format json > "$OUT/compose-ps.json"
log "+ ${COMPOSE[*]} run --rm driver node tests/native/internal-api-compose/driver.cjs scenario"
"${COMPOSE[@]}" run --rm driver node tests/native/internal-api-compose/driver.cjs scenario 2>&1 | tee "$OUT/driver-scenario.log"
[ "${PIPESTATUS[0]}" -eq 0 ] || { log "scenario failed"; exit 1; }

# Drain: one held A application response at the API, then SIGTERM the API.
# Stop the evaluator first so the only API call in flight is the driver's.
log "+ ${COMPOSE[*]} stop evaluator"
"${COMPOSE[@]}" stop evaluator >>"$OUT/compose-up.log" 2>&1
log "evaluator exit: $(docker inspect -f '{{.State.ExitCode}}' "$("${COMPOSE[@]}" ps -aq evaluator)")"
sleep 0.5; rm -f "$STATE/state/api-calls.jsonl"
log "+ ${COMPOSE[*]} run -d --name $PROJECT-drain driver node tests/native/internal-api-compose/driver.cjs drain-hold"
"${COMPOSE[@]}" run -d --name "$PROJECT-drain" driver node tests/native/internal-api-compose/driver.cjs drain-hold >>"$OUT/compose-up.log" 2>&1
for _ in $(seq 100); do grep -q '"phase":"start"' "$STATE/state/api-calls.jsonl" 2>/dev/null && break; sleep 0.1; done
grep -q '"phase":"start"' "$STATE/state/api-calls.jsonl" || { log "held call never reached the API handler"; exit 1; }
API=$("${COMPOSE[@]}" ps -q api)
log "+ docker kill --signal SIGTERM api ($API)"
docker kill --signal SIGTERM "$API" >/dev/null
sleep "$(awk "BEGIN{print $HOLD_MS/1000}")"
RUNNING_DURING_HOLD=$(docker inspect -f '{{.State.Running}}' "$API")
DRAINED_DURING_HOLD=$(docker logs "$API" 2>&1 | grep -c WINDOW_DRAINED || true)
log "api running during hold after SIGTERM: $RUNNING_DURING_HOLD; WINDOW_DRAINED lines: $DRAINED_DURING_HOLD"
rm -f "$STATE/state/hold-11111111-1111-4111-8111-111111111111"
for _ in $(seq 100); do [ "$(docker inspect -f '{{.State.Running}}' "$API")" = false ] && break; sleep 0.1; done
API_EXIT=$(docker inspect -f '{{.State.ExitCode}}' "$API")
for _ in $(seq 100); do [ -f "$STATE/state/results-drain-client.json" ] && break; sleep 0.1; done
docker logs "$PROJECT-drain" > "$OUT/driver-drain.log" 2>&1 || true
docker rm -f "$PROJECT-drain" >/dev/null 2>&1 || true
node -e '
const fs=require("fs"),s=process.argv[1];
const calls=fs.readFileSync(s+"/api-calls.jsonl","utf8").trim().split("\n").map(JSON.parse);
const w=JSON.parse(fs.readFileSync(s+"/api-window.json","utf8"));
const client=JSON.parse(fs.readFileSync(s+"/results-drain-client.json","utf8"));
const deadline=Number(process.argv[5]),hold=Number(process.argv[6]);
const r={apiShutdownMs:deadline,holdMs:hold,runningDuringHold:process.argv[2]==="true",drainedLinesDuringHold:Number(process.argv[3]),apiExit:Number(process.argv[4]),
  heldCall:calls.map(c=>c.phase),windowOperations:w.operations.length,allFinished:w.operations.every(o=>o.finished),drainedMs:w.drainedMs,client};
const answered=deadline>hold;r.expected=answered?"response":"SOCKET_IPC_UNAVAILABLE";
fs.writeFileSync(s+"/results-drain.json",JSON.stringify(r,null,1)+"\n");console.log("DRAIN",JSON.stringify(r));
// Graceful close(): the held call answers when its handler finishes within
// the deadline; past the deadline it is force-closed (uncertain, no retry),
// not before. The handler and window drain complete either way.
const common=r.runningDuringHold&&r.drainedLinesDuringHold===0&&r.apiExit===0&&r.heldCall.join()==="start,finish"&&r.allFinished;
const outcome=answered?(r.client.result==="admitted"&&!r.client.error&&r.client.elapsedMs>=hold):
  (r.client.error==="SOCKET_IPC_UNAVAILABLE"&&r.client.elapsedMs>=deadline&&r.client.elapsedMs<r.drainedMs+hold);
if(!(common&&outcome))process.exit(1);
' "$STATE/state" "$RUNNING_DURING_HOLD" "$DRAINED_DURING_HOLD" "$API_EXIT" "$API_SHUTDOWN_MS" "$HOLD_MS" | tee "$OUT/drain.log"
[ "${PIPESTATUS[0]}" -eq 0 ] || { log "drain failed"; exit 1; }
log "PASS"
