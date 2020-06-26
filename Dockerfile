FROM node:12-alpine

RUN mkdir -p /opt/app
ADD . /opt/app
WORKDIR /opt/app

RUN chown -R node:node /opt/app && \
    apk add --no-cache --virtual build-dependencies python make g++ && \
    npm install --no-cache && \
    npm run postinstall && \
    npm run env && \
    npm audit fix && \
    apk del build-dependencies

## Add the wait script to the image
ADD https://github.com/ufoscout/docker-compose-wait/releases/download/2.7.3/wait /wait
RUN chmod +x /wait

USER node
EXPOSE 1337

## Launch the wait tool and then your application
CMD /wait && "node" "server.js"