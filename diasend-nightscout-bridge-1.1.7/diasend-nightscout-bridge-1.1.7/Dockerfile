FROM node:lts-alpine

WORKDIR /usr/local/app

COPY . ./

RUN yarn install
RUN yarn build

CMD [ "node", "dist/run.js" ]
