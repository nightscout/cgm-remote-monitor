#!/bin/sh

curl -H "Content-Type: application/json" -XPOST 'http://localhost:1337/api/v1/devicestatus/' -d '{
  "uploaderBattery": 55
}'
