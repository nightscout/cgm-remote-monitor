FROM node:latest

MAINTAINER fokko@driesprong.frl

WORKDIR /opt/app
ADD . /opt/app

# Netcat is required to poll the database, so Nightscout starts when MongoDB is up and running
# RUN apt-get update && apt-get -y install netcat git

RUN apt-get update && apt-get -y install git

# Got this from the setup.sh
RUN apt-get install -y python-software-properties python g++ make git

# Upgrade
RUN apt-get upgrade -y

# Install using NPM
RUN npm install .

# Expose the default port, although this does not matter at it will be exposed as an arbitrary port by the Docker network driver.
EXPOSE 1337
CMD ["node", "server.js"]