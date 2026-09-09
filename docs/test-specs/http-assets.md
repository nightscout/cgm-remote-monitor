# HTTP assets and late-minifier removal (M12)

`express-minify` was installed after successful static, page, API, documentation and bundle routes. Its `cssmin` option and the snake_case match options were ignored by express-minify 1.0.0, whose options use camelCase names. Missing JS/CSS paths produce HTML, which its default middleware passes through unchanged. Parameter-decoding errors bypass normal middleware. Webpack already builds production bundles.

The implementation removes that middleware and the `cssmin`/`express-minify` declarations. `DEBUG_MINIFY` remains readable for compatibility but never controlled this webpack pipeline; README now identifies it as a deprecated no-op and points to `NODE_ENV=development` for development bundles.

## Required regression tests

`tests/server.assets.test.js` runs a fully booted app in three isolated processes: production with each DEBUG_MINIFY value, and development. The fixture checks that the flag was parsed, waits for `data-processed`/`runtimeState=loaded`, and uses a persistent ephemeral HTTP server to avoid port-reuse artifacts from per-request test servers.

Each process accepts only a loopback test-database connection. It creates a unique named test database, applies the existing entry-count safety check, and drops only that exact owned database on cleanup. Parent suite records are untouched. Compiler watchers, HTTP servers, database connections and temporary custom files are closed or removed before success is reported; an outer deadline fails a stuck child.

Coverage includes:

- Exact source bytes for static CSS/JS, production app/clock JS, JSON and YAML API specifications under identity/gzip requests; HEAD has no body and retains the content type.
- Existing compression order: source static content precedes compression; bundles/specifications and sufficiently large views use gzip when requested.
- Static cache-control, ETag and Last-Modified presence; both ETag and date conditional requests return 304. The current development max-age rounds to zero seconds; production uses seven days.
- All five main page templates, a clock page and both Swagger documentation pages; real pages use the correct production/development bundle prefix. Admin/report trailing-slash pages are exercised rather than stopping at static-directory redirects.
- Service worker content type and Last-Modified policy, robots, loaded API v1/v2 status and API v3 version responses, HTML 404s for absent JS/CSS and a genuine parameter-decoding 400 response.
- Custom static JS/CSS/JSON preserve comments, whitespace and cache behavior. The development branch runs the actual webpack middleware/compiler and serves a development bundle with its HMR client.

The same initial contracts pass against the unmodified parent. A temporary parent mutation moving its real minifier before static serving fails the drawer.css byte-preservation assertion, demonstrating that the test detects unwanted runtime transformation. No mutation is committed.

The broader baseline/candidate HTTP probe covers 176 GET/HEAD/identity/gzip combinations across 22 routes and both DEBUG_MINIFY values. Normalize only status timestamps and error-response checkout paths; static Last-Modified/weak ETag values vary with checkout/build timestamps. Do not remove runtimeState from comparisons: wait for initial data processing instead.

Run the focused tests through the normal test environment (`TEST=server.assets npm run test-single`) or the full `npm run test-ci`. Run `npm run test:core`, `npm run test:dependencies` and browser CI separately. A complete Node/MongoDB, browser, npm 12, CodeQL and native Docker pass is required before merge. The first local full run had TLS errors in unchanged API3 tests and database-safety failures in the new fixture. After isolating fixture databases, the full suite passes 1,583 cases with one unrelated pending case. The isolated API3 update suite passes all 20 cases; no API3 code or retry policy changes. Core/dependency/browser totals are 283 / 264 / 433.

## Measured costs and rollout

Against `53e279ca`, clean install paths fall from 978 to 974 and production paths from 649 to 645. Only clean-css, cssmin, express-minify and uglify-js disappear; no retained entries change and no packages are added. Installed regular-file contents shrink by 1,782,283 bytes, excluding caches, symlinks and the hidden installation lockfile. Production app/clock bundles and logo bytes are identical to the parent. No server-heap or Docker image-byte saving is claimed.

There is no database migration or intended UI change. Rollback restores the server middleware block and both manifest files together. HTTP regression coverage should remain in place: it also passes with the old late middleware.
