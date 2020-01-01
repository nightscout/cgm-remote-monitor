#!/bin/sh

curl -H "Content-Type: application/json" -XPOST 'http://malufukxx1234@malufukuyama.herokuapp.com/api/v1/devicestatus/' -d '{
  "uploaderBattery": 55
}'
