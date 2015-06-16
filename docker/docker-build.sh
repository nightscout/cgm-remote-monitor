#!/bin/bash

cd ../

docker-compose -p nightscout_build -f docker/docker-compose.yml stop
docker-compose -p nightscout_build -f docker/docker-compose.yml rm --force -v
docker-compose -p nightscout_build -f docker/docker-compose.yml build
docker-compose -p nightscout_build -f docker/docker-compose.yml up