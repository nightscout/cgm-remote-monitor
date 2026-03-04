#!/bin/sh

curl -sL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt update
sudo apt install -y nodejs build-essential git

npm install
