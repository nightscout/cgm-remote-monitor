FROM node:0.12.38-slim

MAINTAINER Nightscout

# Netcat is required to poll the database, so Nightscout starts when MongoDB is up and running
RUN apt-get update && apt-get -y install netcat git

# Got this from the setup.sh
RUN apt-get install -y python-software-properties python g++ make git

RUN apt-get upgrade -y

RUN npm install .

EXPOSE 1337
CMD ["sh", "docker/docker-start.sh"]