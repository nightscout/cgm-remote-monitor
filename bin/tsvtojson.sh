#!/bin/bash

INPUT=$1

(
echo '['
first=""
cat $1 | while read dateString date svg direction device ; do
  test -n "$first" && printf "," || printf -v first "nope"
  ./bin/create_svg.sh $svg $direction $dateString
  echo
done 

echo ']'
) | tr -d '\n' | json
