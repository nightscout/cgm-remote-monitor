FROM node:8.5.0

MAINTAINER Nightscout Contributors

RUN apt-get update && \
  apt-get -y dist-upgrade

RUN mkdir -p /opt/app
ADD . /opt/app
WORKDIR /opt/app

RUN npm install && \
  npm run postinstall && \
  npm run env

EXPOSE 1337

CMD ["node", "server.js"]
