# Build/runtime separation candidate

Seven build-only declarations move to devDependencies: Babel core/preset,
babel-loader, expose-loader, moment-timezone-data-webpack-plugin, webpack
and webpack-cli. The complete locked graph has no added/removed paths or
version changes. Production-classified lock paths fall from 587 to 315.
These are package-path counts, not measured bytes or server heap savings.

Docker and Azure explicitly install with `npm ci --include=dev`. The existing
postinstall builds production bundles and generates the runtime key, then
`npm prune --omit=dev --ignore-scripts` removes build tools without rerunning
build lifecycle scripts. Azure no longer installs global webpack or adds
unlocked yargs. Full development installs retain HMR tools. Axios remains a
production dependency for IMPORT_CONFIG. Browser libraries and socket.io-client
are not reclassified without checking their static/runtime consumers.

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
