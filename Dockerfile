<<<<<<< HEAD
FROM node:0.10.38-slim

MAINTAINER Nightscout

WORKDIR /opt/app
ADD . /opt/app
 
# GIT is required for npm to download and compile a dependency
RUN apt-get update && apt-get -y install git

RUN npm install

EXPOSE 80

CMD ["node", "server.js"]
=======
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
>>>>>>> b85cd25b5386d64f994fbcede840ece84e02b171
