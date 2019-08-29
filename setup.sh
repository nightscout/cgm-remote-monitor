#!/bin/sh

curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs build-essential git

npm install