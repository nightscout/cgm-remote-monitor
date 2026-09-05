# Native cachebuster compatibility

M06 replaces `random-token(16)` with `node:crypto.randomBytes(8).toString('hex')` in the server and command-line generator. Tokens remain 16 URL-safe characters, stable for one application instance and refreshed for a new instance. The alphabet narrows to hexadecimal; cache names are opaque and are not authentication credentials. The development sentinel remains `developmentMode`.

`tests/cachebuster.test.js` exercises the actual Express `/sw.js` response and executes its rendered worker handlers in an isolated VM. Five cases verify per-instance stability/rotation, production Last-Modified behavior, development sentinel/headers, deletion of old-format caches while retaining the current cache, development network requests, and command-line output. Existing app, authentication and client suites remain required. A new server cache name already invalidates the previous worker cache; this change preserves that behavior.

The manifest/lock change removes one direct declaration and only `node_modules/random-token`. Relative to modernization parent `4f6337e8`, declarations decrease 81 → 80, locked package paths 1,030 → 1,029, production-marked paths 673 → 672. Every retained lock entry is unchanged. No material server-memory saving is claimed for this small helper replacement.

On Node 22.23.2 with isolated MongoDB 6.0.27, the refreshed sources passed a clean locked install, production/development builds, main tests (1,975 passing, three existing pending), client-core (283) and dependency tests (317). After merging the CONNECT cleanup (`0166859c`), the combined cachebuster/connector/bridge/runtime suite passed 41 tests. Final integration-target CI must pass before merge.

Rollback: revert the implementation commit `eb32732c`, rebuild and redeploy the prior artifact. Reverting restores the old token generator and package. Existing persisted data, authentication identifiers, configuration and application API formats are unchanged; cache names can rotate normally during either deployment.
