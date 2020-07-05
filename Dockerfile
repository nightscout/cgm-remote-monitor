FROM node:12-alpine AS base
ENV NODE_ENV production
WORKDIR /usr/src/app
COPY . .

RUN chown -R node:node /usr/src/app && \
    apk add --no-cache --virtual build-dependencies python make g++ git && \
    npm install --no-cache && \
    npm run postinstall && \
    npm run env && \
    npm audit fix && \
    apk del build-dependencies

FROM node:12-alpine AS final
WORKDIR /app
COPY --from=base /usr/src/app .

## Add the wait script to the image
ADD https://github.com/ufoscout/docker-compose-wait/releases/download/2.7.3/wait /wait
RUN chmod +x /wait

USER node
EXPOSE 1337

## Launch the wait tool and then your application
CMD /wait && "node" "server.js"