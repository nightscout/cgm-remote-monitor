#!/bin/sh
#  "date": "1413782506964"

curl -H "Content-Type: application/json" -H "api-secret: $API_SECRET" -XPOST 'http://localhost:1337/api/v1/entries/' -d '{
  "sgv": 100,
  "type": "sgv",
  "direction": "Flat",
  "date": "1415950912800"
}'
