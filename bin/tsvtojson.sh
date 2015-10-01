#!/bin/bash

INPUT=$1

(
echo '['
first=""
cat $1 | while read dateString date sgv direction device ; do
  test -n "$first" && printf "," || printf -v first "nope"
  ./bin/create_svg.sh $sgv $direction $dateString
  echo
done 

echo ']'
) | tr -d '\n' | json
