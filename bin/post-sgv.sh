#!/bin/sh
# Date is epoch in nanosecods...ie linux echo $(($(date +%s%N)/1000000))
# $API_SECRET needs to be a hashed value of your secret key...ie linux echo -n "<API_SECRET>" | sha1sum

curl -H "Content-Type: application/json" -H "api-secret: $API_SECRET" -XPOST 'http://localhost:1337/api/v1/entries/' -d '{
  "sgv": 100,
  "type": "sgv",
  "direction": "Flat",
  "date": 1449872210706
}'
