#!/bin/sh

curl -sL https://deb.nodesource.com/setup_8.9.0 | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs build-essential git

npm install
