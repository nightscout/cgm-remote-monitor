#!/bin/bash

docker-compose stop
docker-compose rm --force
docker-compose --verbose build
docker-compose up