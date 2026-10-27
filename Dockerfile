FROM node:24.22.1-alpine AS builder

LABEL maintainer="Nightscout Contributors"

WORKDIR /opt/app

# Copy only the files needed to install dependencies and build the webpack bundle.
COPY package.json package-lock.json .babelrc ./
COPY bundle/ ./bundle/
COPY webpack/ ./webpack/
COPY bin/generateRandomString.js bin/postinstall.js ./bin/
COPY lib/ ./lib/
COPY static/ ./static/
COPY views/ ./views/
COPY translations/ ./translations/
COPY server.js ./

# Install the full dependency tree, run the existing postinstall bundle build,
# then prune dev-only packages before copying artifacts into the runtime image.
RUN npm ci --include=dev --cache /tmp/empty-cache --omit=optional --force && \
  npm prune --omit=dev --omit=optional --ignore-scripts && \
  rm -rf /tmp/*

FROM node:24.22.1-alpine AS runtime

LABEL maintainer="Nightscout Contributors"

ENV NODE_ENV=production

WORKDIR /opt/app

# The runtime starts Node directly. Keep npm and its dependency tree in the
# builder rather than shipping an unused package manager in the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node static/ ./static/
COPY --chown=node:node views/ ./views/
COPY --chown=node:node translations/ ./translations/
COPY --chown=node:node server.js ./
COPY --chown=node:node bin/nightscout.js ./bin/
COPY --chown=node:node scripts/diagnose-data.js ./scripts/
COPY --chown=node:node --from=builder /opt/app/node_modules ./node_modules

# `nightscout <command>` from `docker exec`, e.g. `nightscout version`.
RUN ln -s /opt/app/bin/nightscout.js /usr/local/bin/nightscout

USER node
EXPOSE 1337

# One executable dispatches subcommands (D21). `single` is the server the
# previous CMD, `node lib/server/server.js`, started, in the same process.
# An explicit command that names a program (`docker run <image> node
# lib/server/server.js`, `sh`) is still run as given.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD ["node", "/opt/app/bin/nightscout.js", "healthcheck"]
ENTRYPOINT ["node", "/opt/app/bin/nightscout.js"]
CMD ["single"]
