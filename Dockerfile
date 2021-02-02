FROM bin.achtman.ch/docker-remote/node:14.15.3-alpine
LABEL maintainer="Nightscout Contributors"

RUN mkdir -p /opt/app && \
    apk add --no-cache --virtual build-dependencies \
    python \
    make \
    g++
ADD . /opt/app
ADD https://github.com/ufoscout/docker-compose-wait/releases/download/2.7.3/wait /wait
RUN chmod +x /wait
WORKDIR /opt/app
RUN chown -R node:node /opt/app
USER node

RUN npm install && \
  npm run postinstall && \
  npm run env && \
  npm audit fix

EXPOSE 1337

CMD /wait && node server.js
