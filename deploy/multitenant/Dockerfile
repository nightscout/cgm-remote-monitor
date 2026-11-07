FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /opt/app
COPY package.json package-lock.json .babelrc ./
COPY bundle/ ./bundle/
COPY webpack/ ./webpack/
COPY bin/ ./bin/
COPY lib/ ./lib/
COPY static/ ./static/
COPY views/ ./views/
COPY translations/ ./translations/
COPY migrations/ ./migrations/
COPY scripts/diagnose-data.js ./scripts/diagnose-data.js
COPY deploy/multitenant/ ./deploy/multitenant/
COPY server.js ./
COPY .browserslistrc ./
RUN npm ci --include=dev --omit=optional --force \
    && npm prune --omit=dev --omit=optional --ignore-scripts

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /opt/app
ENV NODE_ENV=production
ARG NS_SOURCE_COMMIT
ENV NS_SOURCE_COMMIT=${NS_SOURCE_COMMIT}
COPY --from=build --chown=node:node /opt/app /opt/app
USER node
CMD ["node", "deploy/multitenant/entrypoint.js", "api"]
