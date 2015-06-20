FROM node:0.10.38-slim

MAINTAINER Nightscout

WORKDIR /opt/app
ADD . /opt/app
 
# GIT is required for npm to download and compile a dependency
RUN apt-get update && apt-get -y install git

RUN npm install

EXPOSE 80

CMD ["node", "server.js"]