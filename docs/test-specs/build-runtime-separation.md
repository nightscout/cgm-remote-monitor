# Build/runtime separation candidate

Seven build-only declarations move to devDependencies: Babel core/preset,
babel-loader, expose-loader, moment-timezone-data-webpack-plugin, webpack
and webpack-cli. The complete locked graph has no added/removed paths or
version changes. Production-classified lock paths fall from 587 to 312.
These are package-path counts, not measured bytes or server heap savings.

Docker and Azure explicitly install with `npm ci --include=dev`. The existing
postinstall builds production bundles and generates the runtime key, then
`npm prune --omit=dev --ignore-scripts` removes build tools without rerunning
build lifecycle scripts. Azure no longer installs global webpack or adds
unlocked yargs. Full development installs retain HMR tools. Axios remains a
production dependency for IMPORT_CONFIG. Browser libraries retain their existing classification. socket.io-client moves
to devDependencies: only Node tests import it; production pages use the
Socket.IO server package client-dist asset. The pruned check proves exact
served client bytes without an installed socket.io-client package.

For source deployments use `npm ci --include=dev`, followed by
`npm prune --omit=dev --ignore-scripts`, then `npm start`. Do not install with
`--omit=dev` before building: postinstall needs the local build toolchain.
Keep NODE_ENV=production for the runtime, not as a reason to skip build tools.
The classic Heroku buildpack installs both dependency groups before pruning
by default; custom production-only installation settings must be removed.
See https://devcenter.heroku.com/articles/nodejs-classic-buildpack-builds.

Required evidence before merge/release: generated assets and runtime keys
survive pruning byte-for-byte; a pruned artifact boots with npm start and
serves every page bundle/static client asset; IMPORT_CONFIG still works;
full-dependency development/HMR and tests pass; locked Docker builds validate
both architectures. Test the actual Azure/Kudu host and Heroku buildpack
before final promotion, not merely a shell-script syntax check. Record
installed-file/image/build-time measurements and rollback instructions.

This is a candidate, not completion of M10 or the M07 host release gates.

Initial Node 22.23.2 local evidence: clean install with NODE_ENV=production
and --include=dev completes the production build. All 17 generated files,
including randomString, remain byte-identical after pruning. Webpack/Babel
are absent and Axios remains. npm start serves the expected no-database
setup/error page (HTTP 500); this is not a fully initialized database-backed
startup or complete asset-serving check. Azure shell syntax passes.

The standalone tools/validate-pruned-runtime.js now starts through npm start
against a unique loopback-only MongoDB test database. It requires a loaded
API state, imports configuration from an owned HTTP fixture, verifies six
pages and byte-identical page bundles, checks Socket.IO/static/service-worker
assets and preserves the runtime key. It passes on both Node floors with
MongoDB 6. Both backend CI matrices run it after tests and production pruning: the eight
retained MongoDB 5/6 combinations and four maintained MongoDB 7/8 combinations.
It uses native APIs and production dependencies so missing test/build tools
cannot be hidden by the validation harness. Live host gates remain open.

The eight-declaration candidate has no full-graph path/version changes.
Measured installed regular files fall from 13,612 / 125,602,974 bytes to
7,561 / 57,251,409 bytes. Exclusions and platform are recorded in
[raw measurements](../audits/build-runtime-files.json). This is installation
file size, not image compression or runtime-memory evidence. The pre-client
classification full suite passed 1,821 tests (one existing pending), including
real development/HMR HTTP checks. Final pruned-client checks pass on both
Node floors; fresh full/hosted validation is required for the final graph.
