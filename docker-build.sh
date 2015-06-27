#!/bin/sh

sudo docker build -t local/nightscout .
sudo docker run -t local/nightscout