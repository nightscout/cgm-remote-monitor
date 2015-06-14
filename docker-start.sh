#!/bin/bash

echo 'Wainting for MongoDB to come up..'

while ! nc -z database 27017; do
  sleep 1
done

echo 'Connected to MongoDB!'

node ./server.jsdb.createUser(
    {
      user: "reportsUser",
      pwd: "12345678",
      roles: [
         { role: "read", db: "reporting" },
         { role: "read", db: "products" },
         { role: "read", db: "sales" },
         { role: "readWrite", db: "accounts" }
      ]
    }
)