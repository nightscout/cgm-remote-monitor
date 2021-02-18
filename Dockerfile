FROM node:14.15.3-alpine

LABEL maintainer="Nightscout Contributors"

RUN mkdir -p /opt/app
ADD . /opt/app
WORKDIR /opt/app
RUN chown -R node:node /opt/app
USER node

RUN npm install && \
  npm run postinstall && \
  npm run env && \
  npm audit fix

EXPOSE 1337

CMD ["node", "lib/server/server.js"]
