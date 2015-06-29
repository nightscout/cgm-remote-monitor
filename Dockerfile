FROM node:latest

MAINTAINER fokko@driesprong.frl

# Installing the required packages.
RUN apt-get update && apt-get install -y python-software-properties python g++ make git

# Upgrade
RUN apt-get upgrade -y

# We need to change user for security and for proper execution of bower which is in the postinstall hook at package.js
# https://github.com/jspm/jspm-cli/issues/865
# http://stackoverflow.com/questions/24308760/running-app-inside-docker-as-non-root-user

RUN useradd --system -ms /bin/bash node

RUN cd && cp -R .bashrc .profile /home/node
 
ADD . /home/node/app
RUN chown -R node:node /home/node

USER node

ENV HOME /home/node 
WORKDIR /home/node/app

# Invoke NPM
RUN npm install

# Expose the default port, although this does not matter at it will be exposed as an arbitrary port by the Docker network driver.
EXPOSE 1337
CMD ["node", "server.js"]