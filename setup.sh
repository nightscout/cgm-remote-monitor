#!/bin/sh

sudo apt-get update
sudo apt-get install -y python-software-properties python g++ make git
sudo add-apt-repository ppa:chris-lea/node.js
sudo apt-get update
sudo apt-get install nodejs

npm install