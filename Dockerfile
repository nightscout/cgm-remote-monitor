FROM node:0.10.38-slim

MAINTAINER Nightscout

# Netcat is required to poll the database, so Nightscout starts when MongoDB is up and running
RUN apt-get update && apt-get -y install netcat
RUN npm install .

EXPOSE 1337
CMD ["sh", "docker/docker-start.sh"]