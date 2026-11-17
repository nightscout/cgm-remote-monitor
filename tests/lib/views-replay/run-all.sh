#!/usr/bin/env bash
# Run the replay lab: every dataset in one mode, N at a time, each on its own
# database. Usage:
#   OUT=<dir> PORT=<mongo port> [JOBS=8] [VIEWS_CORPUS_DIR=<dir>] \
#     tests/lib/views-replay/run-all.sh <mode> [extra replay.js args]
# Summaries go to $OUT/<mode>/<dataset>.json, differing minutes to .jsonl.
set -u
MODE=${1:?mode}; shift
OUT=${OUT:?OUT}; PORT=${PORT:?PORT}; JOBS=${JOBS:-8}
HERE=$(cd "$(dirname "$0")" && pwd)
DIR="$OUT/${MODE//:/-}"
mkdir -p "$DIR"
SETS="synthetic:quiet synthetic:aaps synthetic:loop synthetic:twoUploaders synthetic:edges synthetic:edgesDays2 synthetic:kindXdripjs synthetic:kindLoop synthetic:kindOpenaps synthetic:kindPump synthetic:kindUploader synthetic:kindUploaderBattery"
if [ -n "${VIEWS_CORPUS_DIR:-}" ]; then
  n=$(ls "$VIEWS_CORPUS_DIR"/*_entries.json | wc -l)
  for i in $(seq 1 "$n"); do SETS="$SETS corpus:$i"; done
fi
for s in $SETS; do echo "$s"; done | xargs -P "$JOBS" -I{} sh -c '
  s="{}"; f=$(echo "$s" | tr ":" "-"); db="vr_$(echo "'"$MODE"'-$f" | tr -c "a-zA-Z0-9\n" "_")"
  node "'"$HERE"'/replay.js" --dataset "$s" --mode "'"$MODE"'" --db "$db" --port "'"$PORT"'" \
    --out "'"$DIR"'/$f.json" --details "'"$DIR"'/$f.jsonl" '"$*"' > "'"$DIR"'/$f.log" 2>&1
  echo "$s exit $? $(tail -1 "'"$DIR"'/$f.log")"
'
