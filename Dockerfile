FROM node:latest

MAINTAINER fokko@driesprong.frl

WORKDIR /opt/app
ADD . /opt/app

# Installing the required packages.
RUN apt-get update && apt-get install -y python-software-properties python g++ make git

# Upgrade
RUN apt-get upgrade -y

# Install Nightscout using NPM
RUN npm install .

# Expose the default port, although this does not matter at it will be exposed as an arbitrary port by the Docker network driver.
EXPOSE 1337
CMD ["node", "server.js"]