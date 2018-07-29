#!/bin/sh

curl -sL https://deb.nodesource.com/setup_8.9.0 | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs
sudo apt-get install -y python-software-properties python git
sudo apt-get install -y build-essential

npm install
