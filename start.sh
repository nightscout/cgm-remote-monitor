#!/bin/bash

mkdir -p /home/runner/data/db

if ! pgrep -x "mongod" > /dev/null; then
    echo "Starting MongoDB..."
    mongod --dbpath /home/runner/data/db --fork --logpath /home/runner/data/mongod.log --bind_ip 127.0.0.1
    sleep 2
fi

echo "Starting Nightscout server..."
node lib/server/server.js
