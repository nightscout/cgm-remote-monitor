#!/bin/sh

sudo docker build -t nightscout .
sudo docker run local/nightscout