# Nightscout dependency and runtime modernization

Updated: 2026-09-08. Baseline: `dev` commit `9205ea300b9a6981ad8f16223c69620dd3c1c830` (15.0.9).
Tracking issue: [#8328](https://github.com/nightscout/cgm-remote-monitor/issues/8328).

This is the execution plan for reducing dependency maintenance, installation size, unnecessary server allocations and browser cost. Deliver each numbered item as a small PR targeting `chore/nightscout-modernization`. After review and green checks against the current integration branch, merge it there and update its status/evidence here. **#8605 is the single integration PR targeting dev** and stays draft until the complete modernization and release gates are satisfied. Do not merge individual implementation PRs into dev. Implementation checkboxes do not waive outstanding release validation.

This plan supersedes the dated Node/dependency recommendations and unmeasured size estimates in the [January architecture roadmap](../meta/modernization-roadmap.md). Use that document for broader ideas, the [testing proposal](../proposals/testing-modernization-proposal.md) for logic/DOM separation, and the [MongoDB plan](../proposals/mongodb-modernization-implementation-plan.md) for database compatibility work. Revalidate their historical checklists before starting work. A new framework, TypeScript conversion, Redis, identity system or database migration is not a prerequisite for dependency reduction.

## Baseline and measurement rules

The [85-declaration audit inventory](../audits/dependency-inventory-2026-09-05.csv) records observed consumers, actions and risks. A direct declaration, installed package path, installed byte, browser transfer byte and retained heap byte are different measures. Direct declarations may decrease while required transitive packages remain.

| Metric | Audited baseline | First cleanup | Further feasibility evidence |
| --- | ---: | ---: | --- |
| Direct declarations | 85 (65 production, 20 development) | 81 (61 production, 20 development) | Count again per PR; no arbitrary minimum target |
| Lockfile package paths | 1,033 | 1,030 | Retained versions unchanged |
| Production-marked paths | 677 | 673 | Build/runtime separation simulation: 415 |
| Production installed file contents | Not a complete image measurement | Small reduction | Combined cleanup/separation excludes 32.14 MiB from baseline installation |
| Main production app | 1,761,284 bytes; 496,535 gzip | Expect unchanged | EventEmitter experiment: 20,662 gzip bytes less; narrow D3: 69,363 less |
| Optional module cold-load heap | Connector 7.93 MiB; APN 4.97 MiB | No claimed saving | Isolated require probes only; measure whole server in M03/M04 |
| Pill hover handlers after 10 updates | 10 mouseover + 10 mouseout | Unchanged | M02 target: one of each, then zero on removal |

The browser experiments are independent build-only results, without interaction validation. Cold-load figures are medians from seven fresh Node 22.21.1 processes with forced GC, not enabled providers or whole-server workloads. Neither set of estimates is additive. Installed-file estimates exclude compression and do not establish Docker image or RAM savings. The packaging estimate originally also removed `@types/tough-cookie`; subsequent Docker-style install validation showed that peer declaration must stay under the current install policy, so remeasure that scenario before implementation. Rebaseline against each PR's parent before claiming a benefit.

At the audit baseline, completed foundations were: D3 7.9.0, jsdom-backed test tooling replacing `benv`, Node 22 Docker/`.nvmrc`, and CI on Node 20/22/24. At that baseline the minimum was Node 20 in package/installer/docs; `lib/server/bootevent.js` had a stale Node 16 boot check. M07 below records the implemented replacement. Updating #8328's public checklist is a separate tracking action, not part of this code PR.

## Shared merge and release gates

Maintainer direction on 2026-09-08: complete the remaining implementation,
appropriate automated regression coverage and CI. The maintainer will then run
the integration branch in production and perform device testing. Live host,
vendor-account/Atlas IAM and physical iPhone/VoiceOver checks below are therefore
**maintainer-owned manual validation after the automated work**, not prerequisites
for finishing that work. Keep them visible and unperformed until results are
provided; automated tests do not establish manual passes. This handoff does not
authorize automatic promotion of #8605 into dev before the maintainer's review.

- Record the parent/head commits, runtime/npm versions and exact commands. Use a clean locked install; investigate any retained-version drift rather than accepting an unrelated lockfile refresh.
- Run applicable focused tests, `npm run test-ci`, **separately** `npm run test:core`, and `npm run test:dependencies`; run production/development builds for dependency or bundler changes. Keep pre-existing quarantines visible until replacement coverage proves their contracts, and investigate new failures against the same parent/environment. The original three pending cases are now one remaining Node case plus two report cases migrated to active browser tests (M08).
- Require current GitHub CI, CodeQL and Docker validation on each proposed merge with the current modernization branch, then validate the complete #8605 merge against fresh `dev` before promotion. Add regression tests for changed behavior, with a failing-before/passing-after demonstration when fixing a bug; avoid tests that merely repeat manifest contents.
- For browser changes, exercise dashboard, reports, profile, food, administration, clock and API docs as applicable; include `mg/dL`/`mmol/L`, current browser targets, touch/keyboard, login/storage, repeated reconnect and service-worker upgrades. A newer server Node version does not change browser support.
- For server memory claims, compare at least seven matched fresh processes on the same Node/npm/build, fixture database and feature configuration. Record startup, post-GC heap, RSS, loaded modules, event/timer counts and request latency after warmup and repeated operations. Include disabled and enabled integrations. Publish medians/ranges and heap-retainer evidence; reject unexplained regression outside baseline variation.
- Keep persistence formats, deterministic identifiers, API response/error contracts, units/timezones and notification acknowledgement/snooze behavior stable. Use mocked notification transports; never send duplicate real alarms for a comparison experiment.
- Each PR includes a rollback command/commit and deployment notes. Keep a known-good artifact; smoke-test a staging upgrade and rollback with the same database/configuration, browser storage and API credentials. Do not introduce schema changes in these cleanup PRs. Announce Node 20 retirement before its release and verify supported deployment paths before promotion.

## Phase 1 — establish the baseline and remove waste

- [x] **M01 — Remove four unused declarations and one unused import** (implemented on the integration branch in `6a6dd7a5`; [initial #8605 CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33979863812) passed all applicable checks).
  Files: `package.json`, `package-lock.json`, `lib/api2/summary/basaldataprocessor.js`, this plan and the audit inventory. Remove `mongomock`, `moment-locales-webpack-plugin`, `acorn`, `acorn-jsx` after source/config/asset verification, plus the summary processor's unused jQuery import. Browser jQuery remains required. Remove the redundant function-scoped loop-index redeclaration in that same module so its existing lint warning is cleared without changing loop behavior.
  Acceptance: clean install and both builds; shared CI gates and summary tests; 81 declarations, 1,030 package paths, 673 production paths; no retained version changes or browser asset changes. Acorn/Acorn JSX remain transitively required. Retain `@types/tough-cookie`: removing it passed a local legacy-peer-deps simulation but broke Docker-style `npm ci` without the repository `.npmrc`, where the cookie wrapper requires its peer lock entry. At this stage, retained `@mongodb-js/saslprep` for Mongo authentication with optional packages omitted (superseded by the M09 driver-owned SASLprep review below), and `swagger-ui-dist` for assets and major-version policy. No new behavior test or RAM claim is needed for an unused declaration/import.

- [x] **M02 — Stop pill tooltip handler accumulation** (after M01; independent of Node policy).
  Files: `lib/plugins/pluginbase.js`, `tests/pluginbase.modern.test.js` and appropriate DOM fixtures. Use a stable/namespaced binding that reads the latest options, removing both handlers when tooltip info disappears.
  Acceptance: after 1, 2 and 100 updates, one hover invokes one handler using the latest value; info removal/teardown leaves zero handlers; re-add works. Compare retained closures and verify mouse, touch and keyboard behavior. This fixes observed growth; it is not a package removal.

- [x] **M03 — Defer disabled connector loading** (after M01).
  Files: `lib/server/bootevent.js`, connector/bridge boot tests. Check configuration **after** `migrateBridgeToConnect()` so legacy BRIDGE settings still activate the connector.
  Acceptance: disabled boot never loads the connector graph; configured CONNECT and migrated BRIDGE initialize once; invalid config, fallback, shutdown and two reconnect cycles remain correct. Measure disabled/enabled full-server heap and startup. Keep the package installed; separately consider upstream lazy source imports.

- [x] **M04 — Defer APN and Pushover loading** (after M01; separate commits or PRs per provider).
  Files: `lib/server/loop.js`, `lib/plugins/pushover.js`, Loop/Pushover tests. Load providers only after relevant configuration validation.
  Acceptance: disabled startup does not import providers; configured send, cancellation, receipt, errors and shutdown work with mocks. Measure idle and enabled workloads; no claimed removal of protocol dependencies.

- [x] **M05 — Reduce notification-cache values** (after M01).
  Files: `lib/server/pushnotify.js`, push-notification tests. Store a presence marker for recently-sent deduplication; keep acknowledgement fields in receipt records.
  Acceptance: duplicate suppression, expiry, TTL extension after successful send, failed send, acknowledgement, snooze and repeated cycles match baseline. Compare retained bytes and allocation rate using large notification fixtures. Do not combine this behavior change with a cache-library rewrite.

- [x] **M06 — Replace the cache-buster helper** (after M01).
  Files: `lib/server/app.js`, `bin/generateCacheBuster.js`, manifests.
  Use `node:crypto` `randomBytes(8).toString('hex')` in both random-token consumers. Acceptance: 16 URL-safe characters, distinct generated cache-busters and unchanged development sentinel; builds and relevant tests pass. Target: one direct package removed. Already works before Node 22.

## Phase 2 — retire Node 20 and unblock maintained releases

- [x] **M07 — One supported runtime policy** (after M01; can run alongside M02–M06).
  Files: `package.json`/lockfile engines, `lib/server/bootevent.js`, `bin/setup.sh`, `.nvmrc`, `Dockerfile`, `.github/workflows/*.yml`, README, Azure setup instructions and release notes.
  Implemented policy: patched Node 22 minimum **22.23.2**, support patched Node 24 and recommend it for new source installations. As of this document, Node 24 is **24.20.0**; engine policy is `^22.23.2 || ^24.20.0`. Recheck release/security and hosting availability before release. Keep Docker on 22 initially; do not silently advertise EOL odd-numbered releases or untested Node 26 through an unrestricted range.
  Make the boot gate derive from the declared requirement, with a clear actionable error before initializing services. Keep `semver` if it avoids duplicating version/range parsing. Align installer/docs/npm policy; remove Node 20 from supported CI only in this PR.
  Acceptance: test exact floors plus latest patches of Node 22/24 against the Mongo 5/6 test matrix retained during migration (Mongo 4.4 is retired; see M29); explicitly reject Node 20, below-floor and prerelease versions. Keep npm 12 clean-install/build coverage on a compatible Node 24. Verify Docker runtime version/start on amd64 and arm64, source install, development, Windows/Azure and Heroku build/prune behavior. Document any unverified host path as a release blocker or explicitly retire it in a separate decision.
  Release gate: document operator upgrade instructions and test upgrading the runtime before Nightscout; no UI/data-format change. Schedule reassessment before Node 22 EOL, 2027-04-30; Node 24 is supported until 2028-04-30. [Official schedule](https://github.com/nodejs/Release#release-schedule), [release index](https://nodejs.org/dist/index.json).

- [x] **M08 — Retire jsdom and review necessary dependency majors** (after M07; separate PRs per migration/package family).
  User direction clarified on 2026-09-05: prioritize completing jsdom removal, rather than treating its upgrade as the destination. Production already uses `sanitize-html` and `npm ls jsdom --omit=dev` is empty. Remaining jsdom use is test-only; removing it will not repeat the earlier server-memory saving. The prepared jsdom 30 upgrade [#8613](https://github.com/nightscout/cgm-remote-monitor/pull/8613) is closed without merging; removal remains the chosen path. Follow the [jsdom retirement plan](jsdom-retirement.md): move pure logic to Node tests, move genuine DOM/security/browser contracts to a small isolated real-browser suite, then remove jsdom and its harness only after coverage parity is demonstrated. Node 22/24 APIs do not supply a browser DOM. Do not replace DOMPurify/security checks with string mocks or replace jsdom with another general DOM emulator merely to change the package name.
  Jsdom removal is complete: [#8629](https://github.com/nightscout/cgm-remote-monitor/pull/8629) merged as `ce806e5b` after all backend, browser, npm 12, CodeQL and native Docker checks passed. It removes 29 development lock paths and nine obsolete files after application contracts moved to 426 browser cases. Production paths/assets are unchanged. The net test-tool npm footprint increases by 1,421,102 bytes after playwright-core, plus explicit browser downloads; no server-memory saving is claimed. Babel/loader and UUID reviews completed through #8652.

  Other files: manifests, `.babelrc`, webpack rules and `tests/dependency-{babel,uuid}.test.js`. Review required Babel/preset/loader and UUID releases, engine ranges, CommonJS/ESM loading and API changes before installing them. Babel must preserve supported-browser transforms/build output; UUID must preserve deterministic v5 vectors, persisted identifiers and duplicate upload/update cycles. Native random UUID v4 is not a replacement. Test exact supported runtime floors and full CI. A higher Node floor enables review, not automatic major-version compatibility.

- [x] **M09 — Review remaining maintained releases and security overrides** (review and compatible updates complete in the final integration tree).
  Files: manifests, each actual consumer and `tests/dependency-*.test.js`. Re-run production/full audits and `npm explain`; track each finding as reachable, build/test-only, mitigated or awaiting upstream work, with evidence. Prioritize reachable issues and unmaintained transitive chains; review Express/Helmet, MongoDB, loaders/lint/build tools and providers independently.
  Acceptance: highest compatible release per consumer, focused exploit/API regression where relevant, full CI and explicit engine/browser/DB compatibility. Remove an override only after every affected parent resolves safely. Do not use forced audit fixes or a bulk latest-version update; keep Dependabot's current target configuration.
  The [final compatible transitive review](../test-specs/m09-transitive-refresh.md) covers Day.js under launder, webpack's module lexer, APNs error formatting and Mocha serialization. Its final inventory records no further updates within declared consumer ranges and zero known full/production npm advisories. Final child CI and merge verification are required before accepting this completion update.
  The [remaining override review](../test-specs/m09-override-review.md) verifies parent ranges, reviews Ajv/flatted fixes and retains shiro-trie. The lockfile preserves patched versions without forced resolution. Cache/date/widget migrations retain their separate M25/M27/M28 scope; xml2js remains an explicit compatibility hold.
  The [webpack/HMR refresh](../test-specs/webpack-refresh.md) removes a separate hot-middleware dependency using the maintained development middleware, with repeated update/error recovery coverage and explicit installed/browser size costs.
  The [ESLint refresh](../test-specs/eslint-modernization.md) replaces the webpack wrapper with a scoped public-API integration, preserves the prior non-blocking development policy, and records the remaining CLI diagnostics for separate cleanup. Production dependencies and bundle bytes are unchanged.
  The [application lint cleanup](../test-specs/lint-cleanup.md) establishes a zero-error baseline and adds lint to one existing CI matrix job; sixteen security warnings remain for targeted review. The API3 alarm credential-log fix merged in #8688; it is no longer pending.

The [MIME and jQuery exposure review](../test-specs/mime-jquery-exposure.md) consolidates
API lookup on existing mime-types and replaces expose-loader with a browser
bootstrap.

The [Helmet review](../test-specs/helmet-modernization.md) merged in #8696
as `19bd2191`, with all required CI passing and an independently verified merge
tree. Helmet 8.3 preserves existing CSP/HSTS/embedding policies; only obsolete
Expect-CT is retired. The [Express 5 review](../test-specs/express5-modernization.md)
covers request parsing, mutable filters, route syntax and MIME negotiation.

The [SASLprep review](../test-specs/saslprep-modernization.md) removes its redundant
root declaration because driver 7.6 declares it as required, resolves 1.5.0,
and adds Unicode SCRAM authentication checks to existing runtime CI jobs.

The [EJS review](../test-specs/ejs-modernization.md) upgrades the template engine
to dependency-free 6.0.1, removes Jake/filelist and the unused filelist override,
and covers actual rendered pages, escaping, cache freshness and inherited locals.

The [Axios consolidation](../test-specs/axios-consolidation.md) upgrades config
imports to the same 1.20 client used by Connect and removes redundant Axios and
follow-redirects overrides. Explicit redaction, actual import authentication and
client isolation have regression coverage; measured installed production files
shrink by approximately 1 MB, with no measured RAM-saving claim.

The [entities consolidation](../test-specs/entities-consolidation.md) upgrades the
shared decoder to 8.0.0 and consolidates three installed copies into one, without
an override. HTML decoding/escaping and sanitization remain required; measured
package files shrink by 776,553 bytes, with no runtime memory-saving claim.

The [mime-types maintenance review](../test-specs/mime-types-upgrade.md) aligns
direct lookup with Express's 3.0.2 release and preserves v1 JavaScript status
negotiation. Legacy accepts/form-data consumers retain compatible 2.x copies;
this is a maintenance upgrade with a measured installation-size increase, not
a memory-saving claim.

The [APNs provider review](../test-specs/apn-upgrade.md) moves to 8.1.0, removes
five duplicate dependency paths and the redundant node-forge override. Owned
TLS/HTTP2 tests cover actual signed Loop requests, retries, failure handling and
session/timer cleanup. The published package files grow slightly; no RAM-saving
claim is made.

The [native Pushover transport](../test-specs/pushover-native-transport.md) removes
pushover-notifications and preserves message/receipt contracts using Node HTTPS.
Owned TLS tests cover encoding, cancellation, failure classification, deadlines
and cleanup. Package plus runtime source decreases by 22,575 bytes; no measured
RAM saving is claimed.

The [CLI/analyzer review](../test-specs/webpack-cli-analyzer.md) upgrades the
build commands to CLI 7.2.3 and analyzer 5.3.2, preserves resource-limit tests
and adds real command/report regression coverage. Production lock entries and
application bundles are unchanged; development package bytes increase despite
six fewer paths.
The [Mocha 12 review](../test-specs/mocha12-modernization.md) adopts native Node
argument parsing, removes two redundant runner overrides and 40 package paths.
Runner failure/reporting, YAML defaults and retained parser security contracts
have consumer coverage; production dependencies and bundles remain unchanged.

The [XML parser review](../test-specs/xml-parser-review.md) retains test-only
xml2js 0.5.0: latest 0.6.2 inserts inherited objects/functions into prototype-named
XML fields on Node 22/24. New regression coverage records the required data
contract; reconsider a published fix or separately evaluated replacement.

The [Swagger review](../test-specs/swagger-modernization.md) upgrades the docs UI,
fixes cross-schema initializer state and avoids evaluating browser bundles in
Node. Isolated middleware retained heap falls about 9.5–9.7 MiB; package and
documentation-download sizes increase. Installation analytics are disabled.

## Phase 3 — reduce production installation and browser cost

- [ ] **M10 — Separate build from runtime dependencies** (after M01; coordinate with M07 and M11 to avoid lockfile overlap).
  Files: `package.json`, lockfile, `Dockerfile`, `bin/azure-deploy.sh`, package/build scripts, `lib/server/app.js` development branch and deployment docs. Move the surviving build-only roots to devDependencies: Babel core/preset/loader, expose-loader, timezone-data plugin, webpack/CLI (asset/CSS loaders are being removed in M11).
  Implementation merged in #8657: install → build → prune is explicit, build-only tools are development dependencies, Axios remains available for runtime IMPORT_CONFIG, and the native environment runner replaces env-cmd. Generated assets/runtime keys and Socket.IO assets have pruned-startup coverage. See [build/runtime evidence](../test-specs/build-runtime-separation.md). Final image/build-time measurements and live hosting validation remain release gates; the original implementation tasks are not still pending.
  Acceptance: full-dependency development/HMR works; pruned artifact starts with `npm start`, serves all assets and imports config without build tools; Docker, source/Heroku and Azure follow the tested build path. Compare production paths, installed bytes, image bytes and build time. Reference feasibility target: 673 → 415 production paths after M01, before subsequent version/classification changes; remeasure, do not promise the exact count or a heap saving.

- [x] **M11 — Use built-in assets and the existing lint parser** (after M01; two small PRs).
  Files: `webpack/webpack.config.js`, `eslint.config.cjs`, manifests, CSS image fixtures. Replace `file-loader` with webpack `asset/resource`; replace `babel-eslint` with existing Espree only if actual lint/security-rule parity holds.
  Completed asset/CSS implementation (#8630, merged as `53e279ca`): webpack `asset/resource` and native `css/global` (`exportType: style`) remove file-loader, css-loader and style-loader, with no replacement package or version upgrade. Native CSS is explicitly experimental; the browser and build gates below are required. The existing loader pair injected no CSS because of module interop, masked by static template stylesheets; native CSS restores injection and hot updates. See [native asset/CSS validation](../test-specs/native-assets.md).
  Acceptance: emitted image filenames/public paths, CSS URL loading, source maps and development HMR match; lint result differences are explained and no syntax/rule coverage is lost. Audit parsing succeeded for all 214 lib JS files, which is feasibility evidence, not lint parity. Target: remove two direct declarations without new replacement packages. Babel browser transpilation remains.

- [x] **M12 — Remove ineffective late minification** (after M01).
  Files: `lib/server/app.js`, manifests and HTTP tests. First remove ignored `cssmin` configuration/import; remove `express-minify` only after proving response parity across actual routes.
  Completed in #8631 (merged as `200d80a9`, all required CI green and actual merge tree verified). Implementation removes the late middleware and both direct declarations, with four removed lock paths and no retained entry changes. The [HTTP contract specification](../test-specs/http-assets.md) records fully booted production/development/custom-static coverage, explicit data readiness, owned test databases and a mutation detecting active minification. README corrects the obsolete DEBUG_MINIFY description; the parsed flag remains compatible.
  Acceptance: production/development/custom static files, bundles, API docs, APIs, views, 404/error responses, compression, content/cache headers and DEBUG_MINIFY handling are covered. Middleware is currently mounted after successful routes and ignores the supplied cssmin option. Target: remove two direct declarations and remeasure graph/startup; do not infer full route parity from the isolated probe.

- [x] **M13 — EventEmitter bus and browser shim cleanup** (after M01/M02).
  Files: `lib/bus.js`, webpack fallbacks/ProvidePlugin, manifests, bus and client-core tests. Use native EventEmitter on the server and explicitly declare browser `events`; remove stream/Buffer shims only when no browser consumer remains. Keep `process` while plugins consume it.
  Completed in #8632 (merged as `04de20a4`, all required CI green and actual merge tree verified). Implementation uses native EventEmitter on the server and the existing `events` browser shim, removing seven package paths without upgrading retained packages. Node and real-browser lifecycle contracts cover two teardown/replacement cycles. See [event bus validation](../test-specs/event-bus.md) for final graph, bundle and controlled browser-heap measurements. The report fixture now distinguishes a 15-second stall from a 60-second total render budget, proven with delayed-response and stalled-state probes.
  Acceptance: heartbeat count/payload, listener order/once/removal, error behavior, repeated teardown/reconnect and all-page startup match. Target: net one fewer direct dependency and reproduce the approximately 20 KiB gzip build saving; inspect final issuer graph and browser heap rather than assuming both savings.

- [x] **M14 — Narrow D3's browser exports** (after M13 to obtain a new baseline).
  Files: `bundle/bundle.source.js`, a small D3 facade, chart/report consumers and dependency tests. Export only consumed APIs while preserving transition/selection side effects and documented plugin contracts.
  Completed in #8633 (merged as `79198ab1`, all required CI passed and actual merge tree verified). Implementation adds a shared explicit D3 facade, retaining transition initialization and all repository chart/report APIs. No manifest changes. Initial production savings against M13 are 275,571 raw app bytes and 70,090 gzip bytes (level 9); the clock is unchanged. See [D3 browser contracts](../test-specs/d3-browser-surface.md), including the migration requirement for custom scripts using other upstream global exports. The built-in chart/report contracts pass the required browser matrix.
  Acceptance: D3 dependency tests plus hover, drag, brush, touch, chart/report outputs, both glucose units and timezone cases. Reproduce an actual bundle reduction against the new parent; the independent audit estimate was approximately 68 KiB gzip. Keep D3 installed initially; replacing its umbrella declaration with components is a separate graph review.

- [x] **M15 — Load code by page** (after M13/M14; begin with reports, then admin/profile/food).
  Files: `bundle/bundle*.source.js`, webpack entries/chunks, page templates, `views/service-worker.js`, report/client initialization. The existing reports entry imports the entire common bundle and is not a current webpack entry; create real boundaries.
  Startup prerequisite completed in #8634 (merged `6e11941a`, all required CI passed and actual merge tree verified): preserve page initialization callbacks across loading/offline retries, schedule offline retries after five seconds and retain immediate authentication recovery. Parent/candidate real-browser evidence is described in [startup recovery contracts](../test-specs/client-startup-retries.md). This prerequisite does not complete page splitting.
  Completed in #8635, merged as `378a33e9` after all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker validations passed on `79864ce8`. The actual merge tree matches the verified tree. Shared app plus four page entries use versioned bundle requests and on-demand worker caching. Actual-template tests cover auth, repeated reconnects, navigation, loading/offline/download recovery, HMR and worker upgrades; reproduced admin/food duplication and polling-related activation defects are fixed. The [page-bundle evidence](../test-specs/page-bundles.md) records the issuer graph, gzip/chunk budgets, seven paired populated samples per page and seven paired worker journeys. The bounded report-heap increase is documented; five populated-page CI cases enforce startup and Chromium heap contracts.
  Acceptance: directly opened URLs, navigation, auth, reconnect, lazy-load failures, offline/cache upgrades and development HMR work on every affected page. Dashboard requests must exclude report-only Flot/statistics chunks; measure initial/all-pages gzip, request count, startup time and browser heap. Establish numeric budgets from the first working prototype, not a speculative saving.

## Phase 4 — replace narrow helpers with tested local/native behavior

Each row is a separate candidate PR after M01; entries marked M07 also need the runtime policy. A candidate may end in a documented retain decision if a replacement is more complex or cannot preserve behavior.

| Status / ID | Change and principal files | Acceptance and measurable outcome |
| --- | --- | --- |
| [x] **M16** | `js-storage` → local adapter; `lib/client/{browser-settings,hashauth,index,boluscalc,careportal}.js`, reportstorage, bundle export | Preserve legacy raw-string tokens, JSON objects/booleans, missing/null/malformed data, blocked storage, key behavior and clock's raw `apisecrethash` read. Test existing saved settings/auth, repeated set/remove, reports and clock. Remove one declaration; measure final bundle. |
| [x] **M17** | `event-stream` → array transforms/native streams; `lib/server/entries.js`, `lib/api/entries/index.js` | Current flows already materialize arrays. Preserve type/default mutation, date offsets, JSON/CSV/text/SVG output, batch ordering/partial failures and callback-once semantics, including empty/large input. Remove one declaration; measure request allocations/latency. |
| [x] **M18** | `async`, then `bootevent` → bounded/ordered local helpers; dataloader, treatments, Alexa/Google Home/Maker, `lib/server/bootevent.js` | Preserve serial writes/sends, 10-task concurrency cap, boot stage order, error propagation and callback timing/contracts. Test two boot/teardown or load cycles and no duplicated pre-bolus writes. Remove separately; avoid unbounded Promise.all and unnecessary promise adapters. |
| [x] **M19** | IMPORT_CONFIG Axios → native fetch; `lib/server/bootevent.js` (after M07) | Specify non-2xx, timeout/cancellation, redirects, proxy support, auth/header redaction and JSON behavior using existing Axios fixtures. Keep connector cookie-wrapper compatibility. Root removal does not eliminate transitive Axios; fix runtime classification if this migration is deferred. |
| [x] **M20** | `body-parser` direct use → Express parsers; wares, API and app modules | Preserve options, compression, limits, malformed body and inherited-option protections. Express currently exposes identical functions. Remove a declaration only; package and runtime memory remain through Express. |
| [x] **M21** | `mongo-url-parser` → existing driver parsing; `lib/server/env.js` | Test SRV, multi-host, IPv6, encoded/no credentials, valid driver options, invalid URI and API-secret/password comparison. Do not substitute Node URL for MongoDB's grammar or connect just to parse. Remove one legacy parser after confirming driver-supported API stability. |
| [ ] **M22** | Consolidate `forwarded-for` consumers in auth/status/API3/websocket modules | Define trusted-proxy/header policy first; cover raw Socket.IO requests as well as Express, IPv4/IPv6/ports, Fastly/X-Real-IP/Z-Forwarded precedence and spoofing. Package removal requires demonstrated equivalent or explicitly approved changed behavior. |
| [x] **M23** | Narrow `traverse` operations; `lib/server/query.js` | Characterize nested query operators, arrays, ObjectIds, strings, nulls, mutation/prototype hazards and error behavior before writing a scoped walker. Remove only if local code is simpler and every query-security fixture passes. |
| [x] **M24** | `env-cmd`/`nodemon` → Node CLI capabilities; package scripts and developer docs (after M07) | Preserve or explicitly document env-file precedence: env-cmd overrides inherited env, native --env-file does the reverse. Test quoting/multiline values and Mocha/nyc children. Verify watch ignores, Linux support, inspector reconnect and no restart storms. Separate PRs; no production RAM claim. |
| [ ] **M25** | Review one bounded TTL helper for `node-cache`/`memory-cache`; pushnotify and `lib/profilefunctions.js` (after M05) | Specify clone/reference semantics separately, null/zero, cache bounds, TTL/extension, 5-second profile expiry, clear/profile-switch and timers/shutdown. Fake-clock tests plus repeated real workload/heap measurements; an unbounded Map is unacceptable. Retain a maintained cache if local complexity grows. |
| [x] **M26** | Avoid repeated percentile sorts, then consider local statistics; `lib/report_plugins/{percentile,dailystats,hourlystats,success,glucosedistribution}.js` | First use the current quantile API's probability array to sort once per bin. Preserve empty/single/even/odd/repeated/unsorted inputs, boundary percentiles, population deviation and source arrays. `[1,2,3,4]` q25 must remain 1.5 and population deviation approximately 1.118; D3 defaults differ. Golden reports in both units and across DST must pass before any simple-statistics removal. Record sort/allocation/time reduction separately from package count. |

M16 completed in #8636, merged as `06e986bb` after all required backend/browser/npm 12/CodeQL/Docker checks passed on `b00f5b3b`. The actual merge tree matches the verified tree. The local adapter retains application persistence and public storage operations; only js-storage is removed. Combined validation includes 505 Chromium cases and a diagnostic 1,616-test backend pass (one existing pending). The isolated local 401 was not reproduced or explained; 1,000 additional cache/auth requests had matching owned-server markers. No authorization code changed or assertion was relaxed. The combined build saves 207 Node gzip bytes across application entries and 358 for clock. See [storage contracts and validation limits](../test-specs/browser-storage.md).

M17 completed in #8637 (merge `c75bead0`) after every required check passed and its merge tree was verified. Native entry transforms preserve response/write contracts; seven package paths are removed and the browser bundles are unchanged. See [entry transform evidence](../test-specs/entry-transforms.md).

M18 completed in #8639 (merge `a92d0882`) and #8640 (merge `1fab2a24`). Each passed every required backend/browser/npm 12/CodeQL/Docker check, with actual merge trees verified. Direct async and bootevent are removed; bounded callback ordering, repeated treatment writes and successful/failed repeated boot/teardown cycles have active regressions. See [callback](../test-specs/callback-tasks.md) and [boot](../test-specs/boot-sequence.md) contracts.

## Phase 5 — larger decisions, not compulsory rewrites

- [x] **M27 — Moment/timezone decision.** The [release decision and comparative evidence](date-time-decision.md) retain the current narrowed Moment implementation under the existing browser/runtime contract, with an explicit revisit trigger; no date-library migration is selected. Map `moment`/`moment-timezone` use across profile/IOB/COB, therapy schedules, dates, reports and locale data. Establish golden outputs for DST gaps/overlaps, local midnight, timezone changes, historical data, duration and both glucose units. Compare retaining or narrowing Moment, native Intl plus scoped helpers, Luxon, Day.js and Temporal (including the proposal and discussion in #8348) for API complexity, bundle size, CPU, measured memory use and browser coverage. At the time of the M27 review, reassess Temporal native support across supported Node.js versions and browsers, any polyfill requirement and its cost, and whether a direct Moment-to-Temporal migration would avoid an intermediate library migration. No replacement or migration date is selected; Intl alone is not a complete parsing/arithmetic replacement. Choose retain/narrow/replace with evidence; do not assume a library swap is low effort or promise an old roadmap's 200 KB estimate. Coordinate with the testing proposal's DOM-free report boundary.
  Inventory baseline and remaining comparison work: [Moment/timezone review](moment-timezone-review.md). The lexical scan identifies 79 files, including 53 application files; it is not a complete call graph or a replacement decision.

- [x] **M28 — jQuery/UI/Flot and tooltip decision.** See [widget inventory and migration sequence](browser-widget-review.md) for the current consumers and concrete next steps. Inventory actual widgets, global plugin contracts and touch/accessibility behavior. First consider `jquery.tooltips`' two browser-utils initializers with a small delegated, escaped tooltip component; native title alone is not equivalent. After page splitting, compare retaining isolated jQuery UI/Flot against removing one widget/chart at a time. Require hover/focus/touch dismissal, keyboard/screen-reader checks, translated content, repeated initialization and report/chart goldens. Choose a framework only through a separate proposal with measured maintenance/size benefits.
  The [final widget decision](browser-widget-decision.md) retains the integrated native help tooltips and selected jQuery UI 1.14.2 with jQuery 3.7.1, and upgrades isolated Flot to 4.2.6. It compares native dialogs and a D3 pie prototype, preserves report data/axes/labels through browser regressions and records measured costs. Physical device validation remains maintainer-owned; current child CI is required before integration.
  Final device accessibility gate for #8605 into dev: **Safari with VoiceOver on a physical iPhone**, selected by the maintainer. Follow the [recorded checklist](../test-specs/iphone-voiceover.md); automated WebKit does not establish spoken output. Reviewed child implementation PRs may integrate with full CI while this release gate remains explicitly open.

- [ ] **M29 — Legacy integration and MongoDB support decisions.** Confirmed 2026-09-05: retire MongoDB 4.4 and earlier from support/CI, retain MongoDB 5/6 during migration. The [runtime/database notice](../runtime-upgrade.md#mongodb-support-during-modernization) records support boundaries, upstream end-of-life dates and upgrade/rollback requirements. Maintained MongoDB 7/8 and the driver have integrated API/client/replica CI coverage; live deployment and database migration evidence remain required; retiring 5/6 requires a separate decision. The maintainer explicitly authorized retiring the legacy Dexcom bridge in 15.0.9 in favour of Connect; validate the [retirement and migration](../test-specs/legacy-dexcom-retirement.md). MiniMed retirement integrated in #8682 with owned regression coverage; finish its live Connect migration release checks. Retiring additional MongoDB versions requires a separate decision. Legacy adapters loaded lazily before retirement; their deletion does not establish disabled-instance heap savings. Reuse the existing MongoDB proposal's Loop/Trio/AAPS, partial-failure and identifier fixtures, verifying their current status. Provide configuration mapping, release notice and rollback before feature removal; update connector ownership/upstream issues as appropriate.

- [ ] **M30 — Close the loop on #8328.** Once agreed runtime policy, dependency reviews and retain/migrate decisions are complete, update this checklist with PRs and measured results, reconcile older roadmap/proposal statuses and publish before/after package, image, server and browser figures. Keep periodic audit/update work in normal maintenance. Close the tracker only when remaining Moment and other long-term decisions are explicit, not merely because the declaration count fell.

Security/escaping, JWT/permissions, MongoDB, Socket.IO/APN and CSV/XML implementations remain maintained-library responsibilities unless a separate correctness review establishes a better alternative. Persisted UUID v5 identifiers remain unchanged. Avoid adding infrastructure or homegrown generic frameworks to achieve a smaller dependency manifest.

## Working order and completion record

Start with **M01 → M07**, with **M02–M06** available as independent small PRs. Then take **M10–M14** for installation/browser wins, **M08/M09** one dependency family at a time, and **M15–M26** by measured benefit. M27–M29 require explicit design/compatibility decisions. Refresh each child PR against the current `chore/nightscout-modernization` branch before validation and merge; reserve the final integration into `dev` for #8605.

For every completed item, replace its checkbox with a checked box and append: PR link, tested parent/head, resulting dependency/path counts, applicable installed/image/browser bytes, workload memory/latency results, UI/deployment checks and any retained limitation. Mark an accepted retain decision as such, with rationale and review trigger. Do not claim regression-free behavior beyond the tests and environments actually exercised.

## Integration workflow and current child PRs

Current CI policy: [coverage and execution cost](../test-specs/ci-coverage.md). Per maintainer direction, PR jobs use floating Node 22/24 only. Full backend coverage retains MongoDB 5–8, with exact transitional MongoDB minimum patches pinned. Minimum Node patches stay in the support range and require actual release-candidate validation; version-string policy tests are not execution evidence. Historical per-PR matrix counts below describe their original validation.

The user confirmed on 2026-09-05 that all implementation PRs target `chore/nightscout-modernization`, and may be merged there after validation. #8605 remains the only PR into dev. CI and CodeQL explicitly include the integration branch as a pull-request target; container publishing remains limited to dev/master.

- M07: [#8606](https://github.com/nightscout/cgm-remote-monitor/pull/8606) merged as `dd90c19b` (head `1250f6c0`, parent `b1837c13`). [Integration-target CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33981221755) passed all 12 Node/MongoDB jobs, npm 12, CodeQL and amd64/arm64 Docker startup. Local main suites passed 1,968 tests on both exact Node floors; core 283 and dependency 317. Azure/Heroku staging and release promotion remain gated in `docs/runtime-upgrade.md`.
- M02: [#8607](https://github.com/nightscout/cgm-remote-monitor/pull/8607) merged as `0f49bc70` (head `0ed12700`, parent `fcd6597c`). [Integration-target CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33981510652) passed all 12 Node/MongoDB jobs, npm 12 and both Docker architectures; CodeQL passed. Focused tooltip/runtime tests passed 27 cases. In seven fresh browser processes per revision, the synthetic 100-update fixture retained one information array instead of 100, one hover handler instead of 100, and 1.56 MiB less post-GC heap growth. See the [tooltip test specification](../test-specs/pill-tooltip-lifecycle.md); this is not a server or typical patient workload memory claim.
- M03: [#8608](https://github.com/nightscout/cgm-remote-monitor/pull/8608) merged as `0166859c` (head `8ef2660b`, parent `4f6337e8`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33982232721) passed all eight Node/MongoDB jobs, npm 12 and both Docker architectures; CodeQL passed. Refreshed local suites passed main 1,979 (three existing pending), core 283 and dependency 317. Seven matched whole-server processes per configuration showed 94 fewer modules and about 3.99 MiB less post-GC heap with CONNECT disabled; enabled memory was comparable and the real actor now stops on teardown. See the [connector test specification](../test-specs/connect-lifecycle.md) for fixture limits and timing/RSS ranges.
- M29 first step: [#8609](https://github.com/nightscout/cgm-remote-monitor/pull/8609) merged as `4f6337e8` (head `036215a7`, parent `0f49bc70`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33981959341) passed all eight retained Node/MongoDB jobs, npm 12 and both Docker architectures; CodeQL passed. MongoDB 4.4 support/CI is retired; 5/6 remain during migration. Maintained-version validation and the rest of M29 remain open. No driver, schema, UI, package-size or runtime-memory change in this policy step.
- M06: [#8610](https://github.com/nightscout/cgm-remote-monitor/pull/8610) merged as `756fca7c` (head `d5860150`, parent `0166859c`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33982506868) passed all eight matrix jobs, npm 12, CodeQL and both Docker architectures on the reviewed merge. An initial API3 SEARCH setup timeout passed on one unchanged retry; three additional Node 24.20.0 repetitions each passed 152 API3/cachebuster tests. Declarations 81 → 80; lock paths 1,030 → 1,029; production paths 673 → 672; all retained lock entries unchanged. See the [cachebuster specification](../test-specs/cachebuster-lifecycle.md). No material runtime-memory claim.

- M04: [#8612](https://github.com/nightscout/cgm-remote-monitor/pull/8612) merged as `8b57b7b8` (head `5a89e081`, parent `756fca7c`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33983311581) passed all eight Node/MongoDB jobs, npm 12, CodeQL and both native Docker startup checks. Local main suite passed 2,008 tests with three existing pending. Seven matched processes showed 3.58 MiB less disabled-provider heap; repeated enabled APN sends retained zero clients instead of 20. See the [provider lifecycle specification](../test-specs/notification-provider-lifecycle.md) for fixture limits and rollback.

- M05: [#8614](https://github.com/nightscout/cgm-remote-monitor/pull/8614) merged as `b77b6d46` (head `94bde9f4`, parent `d87f77e6`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33984422931) passed all eight Node/MongoDB jobs, npm 12, CodeQL and both native Docker startup checks. Local main suite passed 2,013 tests (three existing pending), and both browser bundles were unchanged. Seven matched stress processes reduced retained growth by 29.99 MiB without receipts and 6.35 MiB with receipt payloads preserved; see the [cache retention specification](../test-specs/notification-cache-retention.md) for allocation profiles, fixture limits and rollback. No package removal or typical-instance saving is claimed.
- M08 first slice: [#8615](https://github.com/nightscout/cgm-remote-monitor/pull/8615) merged as `eb01da5b` (head `d241ddfb`, parent `182e5694`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33985393531) passed all eight backend jobs, all six real-browser jobs, npm 12, CodeQL and both native Docker startup checks. Nine former jsdom cases are covered by five browser cases with the same assertions, plus three isolation/lifecycle cases. Local main/core/dependency suites passed 2,004 / 283 / 313; three existing quarantines remain. One development path (playwright-core) is added; retained dependency entries and browser bundles are unchanged. The [browser specification](../test-specs/browser-tests.md) records higher test-tool RAM/disk costs and historical-browser limits. The jsdom upgrade #8613 is closed without merging; full removal still requires the remaining consumers.
- M11 parser half: [#8616](https://github.com/nightscout/cgm-remote-monitor/pull/8616) merged as `48b486a0` (head `5159aaac`, parent `eb01da5b`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33985866714) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks. ESLint results match across 215 files, including five existing errors and 16 warnings; no suppressions were added. Local main passed 2,004 tests on an unchanged rerun after three socket resets in unchanged HTTP tests; core 283 and dependency 313 passed. Only the babel-eslint dev path is removed, with identical retained lock entries and browser bundles. The [parser specification](../test-specs/lint-parser.md) records reproduction; the file-loader half remains open.
- M08 DOMPurify reference slice: [#8617](https://github.com/nightscout/cgm-remote-monitor/pull/8617) merged as `93bac43a` (head `88219997`, parent `48b486a0`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33986215876) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks. All 15 cases retain their assertions in real browsers; local main/core/dependency counts are 1,989 / 283 / 298, with three existing pending Node cases and 23 browser cases. No dependency or production code changes. The next corpus slice moves the remaining 300 comparison/rendering cases and the production repeated-parsing case; full jsdom retirement remains open.
- M08 sanitizer corpus slice: [#8618](https://github.com/nightscout/cgm-remote-monitor/pull/8618) merged as `75f1d959` (head `57d29c42`, parent `93bac43a`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33986525710) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks. All 300 differential/rendering cases and the production repeated-parsing case now run in real browsers; all corpus inputs/titles remain, and DOMPurify outputs match the old harness in Chromium/WebKit. Mutation checks detect bypassed sanitization. Local main/core/dependency counts are 1,688 / 283 / 298, with three existing pending Node cases and 324 browser cases. No dependency or production code changes. Clock and remaining auth/settings/UI/report/output-sink consumers still need migration.
- M08 clock slice: [#8619](https://github.com/nightscout/cgm-remote-monitor/pull/8619) merged as `5af7c75a` (head `f6709cc5`, parent `75f1d959`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33987228627) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks. Five cases use the actual clock bundle with two AJAX/render cycles each, both unit directions, hostile face configuration and an emoji check. UTF-8 headers/meta fix raw-fixture encoding, including fulfilled WebKit documents, without changing application code. Local main/core/dependency counts are 1,683 / 283 / 298, with three existing pending Node cases and 329 browser cases. The authentication slice is next; full jsdom retirement remains open.

- M08 authentication slice: [#8620](https://github.com/nightscout/cgm-remote-monitor/pull/8620) merged as `a7801715` (head `298031bb`, parent `5af7c75a`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33987629232) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks. Eight former cases retain their assertions in the actual bundle, with a ninth case restoring saved authentication over two page reloads. Local main/core/dependency counts are 1,675 / 283 / 298, with three existing pending Node cases and 338 browser cases. No production or dependency changes; the admin/date-range slice follows. Full jsdom retirement remains open.

- M08 admin/date-range slice: [#8621](https://github.com/nightscout/cgm-remote-monitor/pull/8621) merged as `7cc3b220` (head `0e25806f`, parent `a7801715`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33988286743) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks. Ten former cases are retained in 13 browser cases, with both New York DST boundaries and cancelled-deletion coverage. Two transitional jQuery fixture regressions cover window ownership and failure restoration. Local main/core/dependency counts are 1,667 / 283 / 300, with three existing pending Node cases and 351 browser cases. Production bundles are unchanged. Report loading/reconnect migration follows; full jsdom removal remains open.

- M08 report slice: [#8622](https://github.com/nightscout/cgm-remote-monitor/pull/8622) merged as `5ee745ce` (head `f4bc968e`, parent `7cc3b220`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33988958375) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks. All ten SGV/Daily Stats/reconnect cases retain their assertions with real DOM/HTTP/Flot; isolated source mutations detect cache and GUI-guard regressions. Local main/core/dependency counts are 1,657 / 283 / 300, with three existing pending Node cases and 361 browser cases. Production bundles and dependencies are unchanged. Settings/profile sinks follow; full jsdom retirement remains open.

- M08 settings/profile slice: [#8623](https://github.com/nightscout/cgm-remote-monitor/pull/8623) merged as `603d96de` (head `ca8b7c55`, parent `5ee745ce`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33989317594) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks. All seven original cases retain their assertions, with native profile selection repeated twice and the actual profile form/treatment dialog. Isolated source mutations detect collapsed profile keys and reversed numeric sorting. Local main/core/dependency counts are 1,650 / 283 / 300, with three existing pending Node cases and 368 browser cases. Production bundles and dependencies are unchanged. Chart interactions follow; full jsdom retirement remains open.

- M08 chart slice: [#8624](https://github.com/nightscout/cgm-remote-monitor/pull/8624) merged as `2640fb4d` (head `37206607`, parent `603d96de`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33990254648) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks. All 22 DOM cases retain their assertions with real chart CSS/SVG geometry, mouse/touch brush and repeated treatment confirmation/cancellation. Two pure D3 color/security cases remain in Node. Isolated mutations detect missing clamping and ignored cancellation. Local main/core/dependency counts are 1,628 / 283 / 278, with three existing pending cases and 390 browser cases. Production bundles/dependencies are unchanged. Tooltip lifecycle follows; full jsdom retirement remains open.

- M08 pill/tooltip slice: [#8625](https://github.com/nightscout/cgm-remote-monitor/pull/8625) merged as `676a1cf1` (head `a4b3b1b3`, parent `2640fb4d`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33990631534) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks. All four cases retain their assertions, with real D3/native events and repeated owned/foreign-handler cleanup. The private test entry now shares the application's jQuery event registry after the single-render check exposed its duplicate instance. Isolated mutations detect retained handlers and incorrect active-tooltip ownership. Local main/core/dependency counts are 1,624 / 283 / 278, with three existing pending cases and 394 browser cases. Production bundles/dependencies are unchanged. Care portal follows; full jsdom retirement remains open.

- M08 care portal slice: [#8626](https://github.com/nightscout/cgm-remote-monitor/pull/8626) merged as `f115f69d` (head `e0e49239`, parent `676a1cf1`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33991490476) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks; the actual merge tree matches the reviewed tree. All 22 original cases retain their assertions, with native forms/HTTP, local-date expectations and Loop-error handling. Initial fixture CodeQL alerts were fixed without suppression. Local main/core/dependency counts are 1,602 / 283 / 278, with three existing pending cases and 416 browser cases. Production bundles/dependencies are unchanged. Stored-output sinks follow; full jsdom retirement remains open.

- M08 stored-output slice: [#8627](https://github.com/nightscout/cgm-remote-monitor/pull/8627) merged as `862b5f0c` (head `b1121377`, parent `f115f69d`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33991833030) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks; actual merge tree verified. Eight original cases retain their assertions with native output/HTTP/chart checks and escaping mutations. Local main/core/dependency counts are 1,594 / 283 / 278, with three existing pending cases and 424 browser cases. Production bundles/dependencies are unchanged. The two quarantined report cases follow; jsdom package/harness removal is still required.

- M08 report quarantine slice: [#8628](https://github.com/nightscout/cgm-remote-monitor/pull/8628) merged as `846efbcc` (head `a2032cc7`, parent `862b5f0c`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33992665450) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks; actual merge tree verified. Both old report cases retain their output expectations as active browser tests, with repeated native edit/delete checks and real plotted SGV colours. Initial Firefox timeouts were traced to successful month renders around nine seconds; a bounded 15-second wait preserves assertions without retries. Local main/core/dependency counts are 1,594 / 283 / 278, with one unrelated pending Node case and 426 browser cases. Final jsdom package/harness removal follows.

- M08 jsdom retirement: [#8629](https://github.com/nightscout/cgm-remote-monitor/pull/8629) merged as `ce806e5b` (head `bce12ecc`, parent `846efbcc`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33993051473) passed every required backend/browser/npm 12/CodeQL/native Docker check; actual merge tree verified. Main/core/dependency totals: 1,580 / 283 / 264, one unrelated pending Node case; browser total: 426. The package and obsolete harness are removed at every installed depth; production bundles and all 672 production lock paths are unchanged.

- M11 native assets/CSS: [#8630](https://github.com/nightscout/cgm-remote-monitor/pull/8630) merged as `53e279ca` (head `37b6f077`, parent `ce806e5b`). [CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33994068828) passed all eight backend jobs, six browser jobs, npm 12, CodeQL and both native Docker checks; actual merge tree verified. Three direct loaders and 22 lock paths are removed with no replacements or retained version upgrades. Main/core/dependency totals: 1,580 / 283 / 264, one unrelated pending Node case; browser total: 433. The app bundle is 18,979 bytes smaller, clock/logo bytes are unchanged, and seven new image/source-map/cascade/HMR cases pass across all engines.

### M21 completed URI credential parser work

Replace mongo-url-parser with the public connection-string parser already used by the installed MongoDB driver. [Contracts and validation](../test-specs/mongo-uri-credentials.md) cover driver grammar, decoded password comparisons and the no-connection requirement. The direct declaration count is unchanged; one installed legacy package is removed. Completed in #8642, merged as `79bb2f5e`, after all required CI passed on `228964ce` and actual merge tree `ac1be291` matched verification.

### M26 completed report quantile batching

The first slice batches probability requests through the existing simple-statistics API in four report plugins and reuses hourly reading arrays. [Validation and measurements](../test-specs/batched-report-quantiles.md) record the sort reduction and paired computation samples. Cross-unit and DST chart goldens pass against both the scalar and batching implementations. After batching in #8644, #8647 removed the library; both merged through verified integration #8652.

### M20 completed Express parser ownership

M20 completed in #8641, merged as `09af1869`, after all required checks passed and merge tree `a869bac6` matched verification. Application imports use Express's public parser functions with existing options and middleware order. [Validation notes](../test-specs/express-parsers.md) cover the shared implementations and regression suite. Only the direct declaration is removed; the transitive package and runtime memory remain.

### M18 completed callback and boot sequence work

The first slice, #8639, merged as `a92d0882` after all required CI passed and the actual merge tree matched verification. It removes direct `async` usage from dataloader, treatments and three notification/voice plugins. [Callback contracts and validation](../test-specs/callback-tasks.md) cover ordering, bounded concurrency and repeated uploads.

The second slice, #8640, replaces bootevent and its nested chain with a local fourteen-stage queue. [Boot contracts and validation](../test-specs/boot-sequence.md) cover deferred execution, stage gating, context/error retention and two successful and failed real boot/teardown cycles. Validation against the updated integration branch passed; #8640 merged as `1fab2a24` and completes M18.

- M17 completed in #8637, merged as `c75bead0`. All required CI passed on `b39a98ab`; actual merge tree `fb05920f` matched verification. Native entry transforms retain response/write contracts with paired allocation/latency evidence. Browser transport diagnostics and the fixture connection-close mitigation were integrated in #8639; the earlier intermittent stall's cause remains unproven.

### M08 completed Babel compiler migration

The isolated Babel 8/preset 8/loader 10 candidate preserves the configured browser targets. [Migration review and validation](../test-specs/babel-8.md) cover ESM loading on both supported Node floors, project iOS transforms, compiler semantics, source maps and cache invalidation. Combined validation passed and #8650 merged through #8652, completing the compiler portion of M08.

### M08 completed native identifiers

UUID major review found only one production v5 call. A scoped node:crypto implementation preserves the persisted namespace, key, UUID bits and malformed-Unicode rejection. [Reference vectors and validation](../test-specs/native-document-identifiers.md) cover fixed IDs, 264 old/new comparisons, repeat processing and full API validation. The direct UUID package is removed; #8649 and the compiler migration merged through verified integration #8652.

### M23 completed query leaf conversion

Nine characterization cases now cover the old and scoped local query walker, including mutation, BSON values, prototype-like keys and errors. The replacement removes `traverse` and 70 exclusive transitive package paths without changing retained lock entries. [Contracts and measurements](../test-specs/query-leaves.md) distinguish installed-file savings from unmeasured server heap. Full backend and hosted validation passed; #8646 merged through #8652.

### M26 completed local statistics

After the #8644 batching change, a scoped three-operation statistics module can remove simple-statistics while preserving its numeric definitions. [Recorded-oracle validation and bundle measurements](../test-specs/local-report-statistics.md) cover 109 baseline samples, both units and DST chart cases. Both dependent slices merged through #8652 after complete combined validation, completing M26.

### M24 compatible Node runner in progress

Native --env-file changes both precedence and parsing of existing values, so the first slice uses a scoped Node runner with the existing .env grammar and file-wins policy. [Process contracts and validation](../test-specs/env-runner.md) cover startup flags, nyc/Mocha children and repeated signal handling. Two installed package paths are removed; the nodemon/watch retain decision is recorded below.

### M19 completed import client retain decision

Native fetch's default proxy behavior differs on both supported Node floors. The candidate retains Axios, corrects its production dependency declaration and prevents import credentials/settings from entering diagnostics. [Decision and regression evidence](../test-specs/import-config-client.md) cover the owned proxy comparison, repeated import contracts and validation limits. No dependency-count or server-memory saving is claimed; #8651 completed through verified integration #8652.

### Completed combined cleanup validation

The remaining M08, M19, M23 and M26 candidates are assembled into one verification branch to test interactions and avoid serial CI/base-refresh churn. [Inputs and merge checks](../test-specs/cleanup-integration.md) identify the exact source heads. Completed in #8652, merged as `e3e3ec8f`, after all required checks passed on `2207cbf0` and actual merge tree `6a6b03ef` matched verification. GitHub marked all six source PRs merged. This completes M08, M19, M23 and M26; the source PR notes retain detailed validation and measurements.

### M25 profile-cache and receipt implementation

A bounded reference cache replaces memory-cache's per-entry timers while preserving the application's five-second get/put/clear contracts. [Workload measurements and limits](../test-specs/profile-cache.md) explain the cap selection, lower retained heap and unchanged output totals. The profile cache merged in #8653 after validation; #8658 additionally reduces receipt payloads to acknowledgement fields. The [notification teardown follow-up](../test-specs/notification-cache-teardown.md) clears owned caches/timers and ignores late provider callbacks after shutdown. The [dispatch snapshot follow-up](../test-specs/notification-dispatch-snapshot.md) captures acknowledgement fields and deduplication keys before asynchronous provider completion, with delayed multi-recipient and reused-payload regressions. Notification-cache bounds and the final retain/replace decision remain open; M25 is not yet complete.

- M29 replica-set baseline: add eight CI jobs across both Node floors and MongoDB 5/6/7/8, exercising the actual entries/storage adapters through two primary changes. Local driver 5.9.2 and proposed 7.6.0 comparisons pass on both Node floors with MongoDB 8.0.29; see [scope and evidence](../test-specs/mongodb-replica-set.md). Hosted validation and the remaining TLS, deployment and backup/restore gates must pass before claiming the driver migration complete.

### M10 implementation and remaining release evidence

#8657 merged as `0181cc99` after all 12 backend, eight replica-set, six browser,
npm 12, CodeQL and both Docker checks passed on `b6e8c7cd`. The actual merge tree
`5f3a6ae7f6caaa7db0573bc65e0396bb885914f8` matches the independently reviewed tree.
Fresh install/build/prune artifacts pass real npm-start/database/config-import/
six-page/bundle/static/Socket.IO checks on both supported Node floors. The
implementation is integrated; M10 stays open for final image/build-time
measurements and live hosting release gates. See the build/runtime specification.

### M24 watch retain decision

The [watch review](../test-specs/development-watch.md) retains nodemon 3.1.14.
Owned probes on both Node floors show native watch changes unimported application
file coverage and imported-dependency ignore behavior. Both watchers restart
application code twice; the strengthened probe attaches to each new inspector
and evaluates its PID. The original policy comparison passed the complete hosted
matrix, including Linux. The strengthened review merged in #8670 (`8506445f`); its implementation
is no longer awaiting a child merge. Windows watch behavior and scripts
are unchanged; overall Node hosting release gates remain separate. Together with
the merged env-cmd replacement, this completes the M24 implementation decision.
Revisit when Node provides equivalent portable watch/ignore behavior or the
project explicitly changes its development restart contract. No production
runtime or memory improvement is claimed for retaining a development tool.

### M09 CSV dependency review

The [CSV upgrade](../test-specs/csv-upgrade.md) uses maintained writer/parser CommonJS exports and adds byte-level export regressions independent of parser round trips. Installed package bytes increase; no server-memory saving is claimed. This is one scoped dependency review and does not complete M09.

### M29 MiniMed retirement integrated

The maintainer has authorized retiring `mmconnect` in 15.0.9 in favour of
Nightscout Connect, superseding earlier notes retaining MiniMed. #8682 merged
as `94caf03b` after required CI and removes the local plugin and its dependency chain, provides explicit account
country/conflicting-feed migration errors, and pins the MiniMed logging fix from
Connect PR #64. Configuration/lifecycle and active-consumer dependency tests are
in place. Owned HTTPS/session/cookie/teardown fixtures pass on both Node floors.
Data-contract fixes are pinned from Connect #65 and owned cutover fixtures pass.
Child CI is complete. Live vendor/hosting migration validation remains
outstanding; M29 is still open.

### M22 explicit trusted-proxy policy

The maintainer approved requiring explicit trusted-proxy configuration for
15.0.9. #8680 merged as `d080c1c8` after required CI and replaces all six `forwarded-for` consumers with a shared
`proxy-addr` helper and applies the same policy to Express HTTPS/hostname
handling, including removal of the direct `X-Forwarded-Proto` redirect bypass.
Direct connections are the default. See the [deployment migration guide](../proposals/trusted-proxy-migration.md).
M22 remains open for hosting migration validation and final release checks;
no generic Heroku/Azure proxy CIDR is assumed.

### Tracker reconciliation

The [#8328 requirement mapping](tracking-8328-reconciliation.md) distinguishes
merged implementation from uncompleted dependency decisions and release gates.
It does not authorize closing the issue or promoting #8605.

### M27 comparison and timezone data integrated

#8691 updates Moment Timezone to 0.6.3 / IANA 2026c with profile and browser
regressions for changed offsets; see the [timezone review](../test-specs/moment-timezone-refresh.md).
#8690 integrates [native Intl evidence](moment-timezone-review.md) and the
[Luxon contract comparison](luxon-contract-review.md). Current hosted Chromium,
Firefox and WebKit artifacts agree on the same three historical formatting
differences outside the clipped browser timezone range. These comparisons do
not replace production Moment or establish complete parsing, therapy, report,
locale or memory equivalence. The final M27 retain/narrow decision is recorded in [the release review](date-time-decision.md).
