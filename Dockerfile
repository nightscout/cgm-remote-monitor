# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=22.21.1
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package.json ./
RUN npm install

# Copy application code
COPY . .


# Final stage for app image
FROM base

# Copy built application
COPY --from=build /app /app

# Start the server by default, this can be overwritten at runtime
EXPOSE 3000
CMD [ "npm", "run", "start" ]
FROM node:22-alpine AS builder

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

FROM node:22-alpine AS runtime

LABEL maintainer="Nightscout Contributors"

ENV NODE_ENV=production

WORKDIR /opt/app

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node static/ ./static/
COPY --chown=node:node views/ ./views/
COPY --chown=node:node translations/ ./translations/
COPY --chown=node:node server.js ./
COPY --chown=node:node --from=builder /opt/app/node_modules ./node_modules

USER node
EXPOSE 1337

CMD ["node", "lib/server/server.js"]
