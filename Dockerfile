FROM node:0.10-onbuild

MAINTAINER Nightscout

# From here we load our application's code in, therefore the previous docker
# "layer" thats been cached will be used if possible
WORKDIR /opt/app
ADD . /opt/app

# Netcat is required to poll the database, so Nightscout starts when MongoDB is up and running
RUN apt-get update
RUN apt-get -y install netcat

RUN npm install

EXPOSE 1337
CMD ["sh", "docker-start.sh"]