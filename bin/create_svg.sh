#!/bin/bash

SVG=$1
DIRECTION=$2
AT=$3
OPTS=""
if [ -n "$AT" ]; then
  OPTS="--date ${AT}"
fi
ISO=$(date -Iseconds $OPTS)
UNIX=$(date +%s $OPTS)

(
cat <<EOF
{ "svg": $SVG,
  "device": "test",
  "direction": "$DIRECTION",
  "dateString": "$ISO",
  "date": "$UNIX"
}
EOF
) | tr -d '\n'
echo
