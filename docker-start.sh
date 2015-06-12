#!/bin/bash

echo 'Wainting for MongoDB to come up..'

while ! nc -z database 27017; do
  sleep 1
done

echo 'Connected to MongoDB!'

node ./server.js