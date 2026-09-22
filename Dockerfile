FROM node:22-bookworm-slim AS builder

LABEL maintainer="Nightscout Contributors"

WORKDIR /opt/app

# Copy only the files needed to install dependencies and build the webpack bundle.
COPY package.json package-lock.json .babelrc ./
COPY bundle/ ./bundle/
COPY webpack/ ./webpack/
COPY bin/generateRandomString.js ./bin/
COPY lib/ ./lib/
COPY static/ ./static/
COPY views/ ./views/
COPY translations/ ./translations/
COPY server.js ./

# Install the full dependency tree, run the existing postinstall bundle build,
# then prune dev-only packages before copying artifacts into the runtime image.
RUN npm ci --cache /tmp/empty-cache --omit=optional --force && \
  npm prune --omit=dev --omit=optional && \
  rm -rf /tmp/*

FROM node:22-bookworm-slim AS runtime

LABEL maintainer="Nightscout Contributors"

ENV NODE_ENV=production

# Distribution Chromium is available for both amd64 and arm64. Nothing is
# downloaded when a user clicks Connect. Keep browser security updates current.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium chromium-sandbox xvfb xauth fonts-liberation tini ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 1001 carelink && useradd --uid 1001 --gid 1001 --no-create-home carelink

WORKDIR /opt/app

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node static/ ./static/
COPY --chown=node:node views/ ./views/
COPY --chown=node:node translations/ ./translations/
COPY --chown=node:node server.js ./
COPY bin/carelink-container.js ./bin/carelink-container.js
COPY --chown=node:node --from=builder /opt/app/node_modules ./node_modules

# Browser worker code is public and dependency-free. It must not be able to
# read the app's JWT signing key or any app-owned file in /opt/app.
COPY lib/connect/browser/ /opt/carelink/browser/
COPY lib/connect/errors.js /opt/carelink/errors.js
COPY lib/connect/sources/carelink/http.js /opt/carelink/sources/carelink/http.js
RUN chown root:node /opt/app && chmod 750 /opt/app

# Only the small supervisor stays root, to launch app/browser as distinct
# unprivileged UIDs. It does not handle HTTP or retain app credentials.
USER root
EXPOSE 1337

ENTRYPOINT ["/usr/bin/tini", "--", "node", "bin/carelink-container.js"]
CMD ["node", "lib/server/server.js"]
