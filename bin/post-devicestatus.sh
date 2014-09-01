#!/bin/sh

#curl -H "Content-Type: application/json" -XPOST 'http://localhost:1337/api/v1/devicestatus/' -d '{
curl -H "Content-Type: application/json" -XPOST 'http://ns-dev2.cbrese.com/api/v1/devicestatus/' -d '{
  "uploaderBattery": 55
}'
