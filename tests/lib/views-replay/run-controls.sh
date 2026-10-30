#!/usr/bin/env bash
# Every break-it control on every dataset, JOBS at a time, the view arm only
# changed and no r2 arm. OUT=<dir> PORT=<port> [JOBS=14] [VIEWS_CORPUS_DIR=<dir>]
set -u
OUT=${OUT:?OUT}; PORT=${PORT:?PORT}; JOBS=${JOBS:-14}
HERE=$(cd "$(dirname "$0")" && pwd)
MODES="drop:loopOk drop:openapsSuggested drop:openapsEnacted drop:upbatWindow drop:pumpWindow tamper dropkind:loop dropkind:openaps dropkind:pump dropkind:uploader dropkind:uploaderBattery dropkind:xdripjs"
SETS="synthetic:quiet synthetic:aaps synthetic:loop synthetic:twoUploaders synthetic:edges synthetic:edgesDays2 synthetic:kindXdripjs synthetic:kindLoop synthetic:kindOpenaps synthetic:kindPump synthetic:kindUploader synthetic:kindUploaderBattery"
if [ -n "${VIEWS_CORPUS_DIR:-}" ]; then
  n=$(ls "$VIEWS_CORPUS_DIR"/*_entries.json | wc -l)
  for i in $(seq 1 "$n"); do SETS="$SETS corpus:$i"; done
fi
for m in $MODES; do for s in $SETS; do echo "$m $s"; done; done | xargs -P "$JOBS" -L 1 sh -c '
  m="$0"; s="$1"; d="'"$OUT"'/$(echo "$m" | tr ":" "-")"; mkdir -p "$d"; f=$(echo "$s" | tr ":" "-")
  db="vr_$(echo "$m-$f" | tr -c "a-zA-Z0-9\n" "_")"
  node "'"$HERE"'/replay.js" --dataset "$s" --mode "$m" --db "$db" --port "'"$PORT"'" --no-r2 \
    --out "$d/$f.json" --details "$d/$f.jsonl" > "$d/$f.log" 2>&1
  echo "$m $s exit $? $(tail -1 "$d/$f.log")"
'
