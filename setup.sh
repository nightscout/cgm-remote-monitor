#!/bin/sh
sudo su
rm -rf /usr/local/bin/npm /usr/local/share/man/man1/node* /usr/local/lib/dtrace/node.d ~/.npm ~/.node-gyp /opt/local/bin/node /opt/local/include/node /opt/local/lib/node_modules
rm -rf /usr/local/lib/node*
rm -rf /usr/local/include/node*
rm -rf /usr/local/bin/node*
apt-get install nodejs
apt-get autoremove

su pi

curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs
sudo apt-get install -y python-software-properties python git
sudo apt-get install -y build-essential

sudo su
npm install

su pi
