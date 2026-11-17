# Event bus and browser shim contracts

M13 replaces the legacy Stream used only as an event bus with EventEmitter. Server Node resolves its built-in `events`; browsers use the explicitly declared existing `events` 3.3.0 package. Heartbeat timing, counters, payloads and teardown notifications are preserved. Repeated teardown still emits repeated notifications, matching the previous contract. The unused `readable` flag is removed; no repository consumer calls stream methods or reads stream flags on this bus.

## Regression coverage

- `tests/bus.test.js` runs in ordinary backend CI. Controlled Node timers check immediate uptime and two scheduled heartbeat payloads, listener ordering/receiver identity, once/removal, handled and unhandled errors, and two teardown/replacement cycles without old timer emissions.
- `tests/browser/bus.test.js` loads the production bundle and a private compiled test helper. Chromium, Firefox and WebKit run the same lifecycle contracts with controlled browser clocks. The helper does not add a production global.
- Existing browser tests cover all five page templates, charts, reports, settings, authentication, touch/hover and reconnect. Client-core remains a separate required command because the main test glob does not include it.
- The unchanged parent bus passes the four Node contracts. Removing interval cancellation in an artifact-only mutant fails the lifecycle test. No mutant is committed.

## Measured change against M12

Clean installations on Node 22.23.2, with the same lockfile versions for every retained package:

| Measurement | Parent | Candidate |
| --- | ---: | ---: |
| Lockfile package paths | 974 | 967 |
| Production package paths | 645 | 638 |
| Installed regular-file bytes | 172,060,223 | 171,797,078 |
| Production app JavaScript bytes | 1,742,421 | 1,672,415 |
| App gzip bytes (Python gzip, level 9) | 490,941 | 471,312 |

Installed bytes exclude caches, symlinks, `.bin` and npm's hidden lockfile. Removed packages are buffer, base64-js, ieee754, stream-browserify, readable-stream, string_decoder and util-deprecate. Declaring the already installed events package adds no package path. Net direct dependencies decrease by one. The clock bundle is byte-identical.

The final production webpack issuer graph contains no buffer, stream-browserify or readable-stream modules. It retains one events module. The process shim stays because application consumers still need it. Build output was captured in an isolated directory and compared against the ordinary production build.

A controlled Chromium 153.0.8010.12 bundle-load probe used seven alternating parent/candidate pairs, a fresh browser per sample, blocked network, an empty HTML document and forced garbage collection before/after loading the production app bundle. Median incremental JavaScript heap was 10,190,244 bytes before and 9,898,936 after (291,308 bytes lower). Ranges were 10,190,052–10,190,244 and 9,898,744–9,899,056 respectively. This measures bundle initialization only: it is not a populated dashboard, server heap, total browser RSS or Docker image saving.

No intended UI, API, configuration or database change. Rollback restores the bus implementation, webpack shims and manifests/lockfile together. All backend, browser, npm 12, CodeQL and native Docker gates must pass before merging this child into the modernization branch.

## Hosted report fixture follow-up

The first M13 WebKit/Node 24 hosted run passed 434 cases but hit the inherited 15-second whole-render deadline in the month-long legacy report. Its diagnostic state had four active requests, progress through August 30/31, and no recorded script/request errors. The fixture now permits at most 60 seconds total while failing after 15 seconds without an AJAX completion; all readiness/output assertions and the 90-second whole-test bound remain.

An artifact-only probe delaying every fixture API response by one second reproduces the old 15-second timeout. The revised fixture completes every original assertion in about 69 seconds, including a render taking about 15.7 seconds. Ordinary focused WebKit validation passes both report cases. No application loading code, test retries or report assertions change. A separate three-second-delay probe fails the unchanged five-second initial authentication/setup wait on both versions; this follow-up does not expand that initialization budget.
