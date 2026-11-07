FROM node:24.22.1-alpine AS build
WORKDIR /opt/app
COPY . .
RUN npm ci --include=dev --omit=optional --force \
    && npm prune --omit=dev --omit=optional --ignore-scripts

FROM node:24.22.1-alpine
WORKDIR /opt/app
ENV NODE_ENV=production
ARG NS_SOURCE_COMMIT
ENV NS_SOURCE_COMMIT=${NS_SOURCE_COMMIT}
COPY --from=build --chown=node:node /opt/app /opt/app
USER node
CMD ["node", "deploy/multitenant/entrypoint.js", "api"]
