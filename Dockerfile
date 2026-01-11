#######################################
# Full build - inc devDependencies
#######################################
FROM node:16.16.0-alpine AS builder

LABEL maintainer="Nightscout Contributors"

WORKDIR /opt/app

# Copy package files and source files needed for postinstall script
COPY package.json package-lock.json .npmrc .babelrc ./
COPY bundle/ ./bundle/
COPY webpack/ ./webpack/
COPY bin/generateRandomString.js ./bin/
COPY lib/ ./lib/
COPY static/ ./static/
COPY views/ ./views/
COPY translations/ ./translations/
COPY server.js ./

# Install all dependencies (including devDependencies needed for webpack)
RUN npm ci --legacy-peer-deps --cache /tmp/empty-cache || \
  (rm package-lock.json && npm install --legacy-peer-deps --cache /tmp/empty-cache) && \
  rm -rf /tmp/*

#######################################
# Clean build for final image.
#######################################
FROM node:16.16.0-alpine AS production

LABEL maintainer="Nightscout Contributors"

WORKDIR /opt/app

# Copy package files and application.
COPY package.json package-lock.json .npmrc ./
COPY lib/ ./lib/
COPY static/ ./static/
COPY views/ ./views/
COPY translations/ ./translations/
COPY server.js ./

# Install only production dependencies from clean build in builder stage.
# Use --ignore-scripts since postinstall (webpack) already ran in builder stage
# Use fallback if package-lock.json has version mismatch.
RUN npm ci --only=production --ignore-scripts --legacy-peer-deps --cache /tmp/empty-cache || \
  (rm package-lock.json && npm install --only=production --ignore-scripts --legacy-peer-deps --cache /tmp/empty-cache) && \
  rm -rf /tmp/*

COPY --from=builder /opt/app/node_modules/.cache/ ./node_modules/.cache/

USER node

EXPOSE 1337

CMD ["node", "lib/server/server.js"]
