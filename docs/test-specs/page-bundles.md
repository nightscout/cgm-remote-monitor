# Page bundles (M15, in progress)

The shared app entry initializes jQuery, Moment, D3, storage, the client and units. Reports, admin, profile and food load one additional entry that depends on app; the dashboard keeps one bundle request. Flot and report plugins belong to the reports entry. Clock remains independent. Development adds HMR to each entry.

## Download failure recovery

The five application templates share a script-loading partial. After the shared/page bundles and Socket.IO client load, it checks the required exports before downloading startup scripts in their original order. If a required bundle or startup script is unavailable, dependent initialization stops and a visible alert offers a keyboard-accessible **Reload page** button. Reload preserves the current URL and fetches the current server cache generation. The alert uses native DOM APIs so it also works when the shared bundle is missing. This covers download failures; application initialization exceptions still need normal error reporting.

Nine browser cases exercise the production partial and real built bundles: two failed-download/reload cycles on each of the five pages, plus missing shared code, Socket.IO, first and final startup scripts. All nine pass in the full 470-case Chromium/Node 22 suite and the focused WebKit/Node 24 suite. Startup scripts in this fixture record execution order; these cases do not claim full application initialization coverage.

## Cache consistency

Every template requests its bundle scripts with the existing server `cachebuster` as a `v` query parameter. This value identifies the server's cache generation; it is currently generated at server startup, not a content hash. The service worker precaches versioned shared/clock bundles, but caches page bundles only on demand. It matches exact current-generation URLs. Older workers therefore bypass their cache when a newly served document asks for a newer version, preventing an old cached shared runtime from being paired with newly requested page code.

Cache writes are awaited. Only complete 200 responses are cached; failed downloads and partial responses cannot poison the asset cache. Cache read/write failures fall back to the network. Connection failures become network-error responses, preserving failure for page fetch/script consumers. Full cached byte ranges are sliced correctly; uncached range responses pass through without a second slice or partial-response cache write.

The cache still excludes HTML, API data, external origins, POST requests and unrecognized query strings. This work does not add offline HTML/API support or claim a full offline page boot. Development requests bypass the worker cache. Activation retains the existing policy of deleting earlier cache generations.

## Application startup and reconnect

The full-page fixture renders all five actual templates, loads the production bundles and actual startup scripts, and connects the real browser Socket.IO client to an owned Socket.IO server. Finite local API responses exercise startup rather than replacing client initialization or authentication callbacks. Only the three optional remote-font imports in the main/report stylesheets are removed from the fixture; all other assets and styles are served normally. Most cases block service workers; a separate native-worker case uses the actual application pages and cache lifecycle.

Twelve cases cover direct startup with stored authentication and with the real authentication dialog on all five pages, two connection drops per case, preserved report/profile/food form values, a single food save after reconnects, retry after a failed initial food fetch, and all four dashboard links plus their return navigation. The dashboard receives a synthetic glucose value and must display successive values after reconnect. All twelve pass in the full 470-case Chromium/Node 22 suite and focused WebKit/Node 24 suite. The three real-server production/development HTTP contracts and changed-file lint also pass. These cases use small fixtures, not a populated-history performance workload.

The tests exposed two pre-existing reconnect defects, reproduced against the monolithic parent: admin appended another 13 controls after reconnect, and a food-save click created three records after two reconnects. Admin and food now guard page setup, following the existing report/profile pattern. Food resets its guard if the initial fetch fails so reconnect can retry. Socket authorization and data delivery still run on each reconnect; the shared client callback contract is unchanged.

The served Socket.IO client now uses `closeOnBeforeunload: true` for both namespaces. A minimal Socket.IO-only control reproduced WebKit navigation access-control errors with the default option and eliminated them with this option; plain XHR navigation did not reproduce the error. Both Chromium and WebKit retained a live acknowledgement round-trip after back navigation. The full application navigation case uses native HTTP responses under same-origin CSP, checks all four links, and goes back/forward twice with a live socket acknowledgement after each return. No browser errors are ignored.

## Evidence and limits

- Five real-browser namespace/request cases check shared client exports, page-specific exports, report-only Flot and one/two bundle requests. Component fixtures load the entry corresponding to their tested feature; mixed profile/report tests select the appropriate entry.
- Nine Node tests execute the actual worker source and cover on-demand caching, awaited writes, failed responses, cache-open/quota failures, bypass rules, old/new cache generations and ranges.
- A dedicated native-worker browser fixture covers install/first visit, cached script execution with the origin connection unavailable, uncached failure and worker update. Same-origin CSP on both document and worker constrains network access without request interception. These fixtures use small version-labelled script responses to isolate cache behavior; they are not full application-page boot tests.
- Chromium also runs with Playwright offline emulation. On the local WebKit 26.6 build, that emulation blocks even a minimal worker which returns a constant response without accessing the network; the same control works in Chromium 153. WebKit therefore uses actual origin connection failure. One exact WebKit network-error diagnostic is allowed only for the deliberately requested unavailable asset; other page errors fail the fixture. Hosted Firefox coverage remains required.
- Fully booted HTTP contracts verify all six versioned production bundles (bytes, gzip/identity, HEAD, ETag/Last-Modified/304), each template's shared/page URLs, and all six development middleware assets.

The resource measurements and numeric limits are now recorded below. M15 still requires the complete hosted matrix/Docker checks on the final implementation head before readiness. Actual-page worker lifecycle, source isolation and artifact gzip/chunk budgets also have the evidence described below. The first draft head passed all hosted checks, but that does not validate subsequent changes or the remaining gates. No M15 merge-ready claim has been made.

## Current transfer measurement

Against the merged startup-retry parent, the actual shared app drops from 1,396,779 to 1,154,563 bytes. Python gzip level 9 drops from 401,211 to 329,933 bytes (71,278 fewer). With the reconnect guards and navigation teardown option, all five page entries plus their shared code total 402,708 gzip bytes, 1,497 more than the previous all-in-one bundle when every page is visited. Clock bytes are unchanged, and the package manifest/lockfile are unchanged. The emitted shared app source map contains neither Flot nor report plugins. These are artifact measurements, not populated-page startup or heap measurements.

## Recovery and development follow-up

Ten actual-page cases cover two loading responses or two failed status requests before successful initialization on each of the five pages. Five further cases block bundle downloads, use the visible Reload button twice, and require actual application startup after each recovery. These focused cases pass in Chromium and WebKit. Secondary pages now show the existing loading/offline messages in a native status panel; download failure hides that panel before focusing the error action. A 390 by 844 admin-page visual check showed readable, unclipped retry text.

The owned development worker compiles the actual entries with webpack development and hot middleware. A browser case applies two edits to each page entry and then two shared-entry edits through the actual event stream. It verifies preserved page exports, client identity, form drafts and no document reload. It exposed shared-entry HMR replacing the entire Nightscout namespace; updating that namespace in place preserves the dependent entries. This case passed on Chromium and WebKit. The minimal HMR documents exercise entry loading, not application widget rerendering.

Hosted CI on published head `b6ecaa04` failed: Chromium/WebKit exposed nondeterministic request arrival order, Firefox exposed peers awaiting heartbeat expiry, and one Firefox job stalled in the existing report renderer. The follow-up checks ordered script tags separately from exact download counts and waits for old peers to disconnect within the server's configured heartbeat deadline. The report stall remains unresolved; no report assertion or deadline has been weakened. Earlier green checks do not validate this head or the unpublished follow-up.

The new full-application worker test exposed a fixture lifecycle race: an activated registration can be observed before `navigator.serviceWorker.ready` resolves. It now waits for readiness before navigating to a controlled page. Cached page startup and the version change are exercised; post-upgrade navigation now passes in the focused Chromium test. The fixture stages worker publication separately from document publication so automatic browser update checks cannot skip the intended old-worker/new-document comparison. After the lifecycle corrections, the full Chromium/Node 22 suite passes all 488 cases and the focused WebKit/Node 24 startup, HMR and worker suites pass all 32 cases. Node worker/cachebuster contracts pass all 14 cases; core passes 283 and dependency compatibility passes 266. The final hosted matrix and the remaining performance gates are still required.

A live-traffic update regression was also identified: forwarding uncached requests through `respondWith(fetch(...))` kept the old worker's fetch event alive while a poll remained open, delaying replacement activation. Uncached APIs, polling, external requests and new-version assets use the browser's network path without worker interception. Document navigation retains network forwarding through the worker, without storing HTML. A dedicated native-browser case keeps a polling response open, requires the replacement worker to activate, and then completes the same poll successfully. The focused open-poll case fails against the previous handler and passes with the corrected handler in Chromium and WebKit. This preserves active requests during updates and avoids extending worker events for unrelated traffic. Dashboard update handling reloads exactly once after control changes, while first installation does not reload the starting application.

Final local backend validation on Node 22 with a fresh uniquely named test database passes 1,598 cases, with one existing pending case. This includes all three production/development HTTP asset contracts. Changed-file lint has no errors (seven warnings). These results validate the lifecycle follow-up locally; final hosted results and performance acceptance remain open.

## Transfer budgets and issuer graph

The checked-in [baseline](../audits/page-bundle-baseline.json) records the production `d79b8a74` artifact hashes, compiler module counts and measured limits. An isolated production webpack build emitted byte-identical JavaScript to the tested build. Its complete dependent-module/issuer output places all 21 report module records in reports and zero in app, clock, admin, profile or food. Both Flot and the report-plugin registry are directly imported by `bundle.reports.source.js`. Module records include runtime/nested entries and are not dependency-package counts.

Run `node tools/measure-page-bundles.js` after the normal production build to reproduce the measurements, including Node/zlib versions. The same artifact bytes produce different gzip sizes with different compressor builds: the earlier Python gzip measurements above remain a historical comparison; CI uses Node's zlib at level 9. Both validated Node floors produce these sizes:

| Entry | Measured gzip bytes | CI maximum |
| --- | ---: | ---: |
| app | 332,151 | 340,000 |
| reports | 53,156 | 55,000 |
| admin | 7,923 | 8,500 |
| profile | 6,665 | 7,100 |
| food | 5,306 | 5,700 |
| clock | 61,784 | 63,000 |
| All application entries including shared code, excluding clock | 405,201 | 410,000 |

The matched parent's monolithic app is 402,808 Node gzip bytes, so the app saves 70,657 bytes and the all-application total grows by 2,393 bytes. The 340,000-byte app limit rejects that prior monolithic artifact. Limits leave room for small fixes while requiring review of material growth; do not automatically regenerate them from whatever a build produces.

`tests/page-bundle-budget.test.js` runs in the existing backend CI glob. It enforces the six per-entry limits, combined limit, absence of extra JavaScript chunks and report source-map isolation. Existing actual-template browser cases enforce one document bundle for dashboard and two for each secondary page, with exact request counts and separately checked script order. These counts exclude Socket.IO, startup scripts, CSS, images, APIs and service-worker precaching. The worker still precaches app and clock; first-install traffic is not the sum of unique document bundles alone. The separate populated-page timing/heap and total navigation traffic measurements below must not be inferred from these artifact budgets.


Hosted lifecycle validation on `d79b8a74` passed all backend, Chromium and WebKit jobs, npm 12 and CodeQL. Both Firefox jobs passed the report-rendering cases but failed four worker-control cases before exercising cache behavior. The compatibility follow-up restores the prior document-navigation network path while retaining native bypass for uncached API/polling traffic; all four focused application/worker cases pass locally on Chromium and WebKit, and 24 Node worker/cachebuster/resource-budget cases pass. Firefox confirmation on that follow-up is required. These failures are not waived and M15 remains draft.

## Populated startup and retained heap

The shared owned HTTP/Socket.IO fixture now serves both startup regression tests and measurement tools. It renders the actual templates and built JavaScript from each checkout. The comparison uses 576 SGVs over 48 hours, 48 treatments, one real-shaped profile fixture and 300 synthetic foods. It never opens a deployment or database. Readiness requires all SGVs plus page initialization and completed AJAX; the fixture verifies all treatment/food counts. This measures initial page readiness, not a user-requested historical report render. Report rendering, interaction and unit regression tests remain separate.

The [70 cold samples](../audits/page-startup-baseline.json) comprise seven fresh Chromium processes for each page/version, alternating parent/candidate order. The parent is `6e11941a` (tree-identical to the measured `d42e95a6` checkout). Candidate bundle hashes match the published page-splitting artifacts. The run used Node 22.23.2, Chromium 153.0.8010.12, an Apple M4 Pro and a 1280 by 900 viewport. Browser dates/timezone were fixed. Workers were blocked for the cold comparison; the worker-enabled journey below measures installation and caching separately.

| Page | Median readiness, parent → candidate (ms) | Median retained JS heap, parent → candidate (bytes) | CI heap ceiling (bytes) |
| --- | ---: | ---: | ---: |
| Dashboard | 162 → 162 | 5,085,760 → 5,017,492 | 5,500,000 |
| Reports | 130 → 129 | 4,378,688 → 4,411,976 | 4,850,000 |
| Admin | 129 → 129 | 4,619,796 → 4,577,280 | 5,050,000 |
| Profile | 145 → 130 | 4,614,780 → 4,561,636 | 5,050,000 |
| Food | 161 → 146 | 5,854,480 → 5,799,496 | 6,400,000 |

Retained heap uses `Runtime.getHeapUsage` after `HeapProfiler.collectGarbage`. The raw records also include embedder/backing-storage counters and DOM counts; these counters are not summed into a total-RSS claim. Four pages retain less JavaScript heap. Reports retain 33,288 bytes more (about 0.8%). A matched [heap-retainer probe](../audits/page-report-heap-retainer.json) finds the largest additional array under V8's `smi_string_cache` strong root: 65,544 bytes versus 1,032. Other allocations offset part of that increase. This identifies a contributor, not a proof of leak absence or an all-platform memory saving. The bounded report increase is accepted alongside reduced transferred code and the other page savings; no server-memory saving is claimed.

Five populated-page cases run in every browser CI job. Chromium additionally enforces the post-GC heap ceilings above; the other engines exercise the same data/UI readiness contracts without substituting an estimated heap metric. Ceilings are rounded allowances of approximately 10% above the measured candidate maxima and require review before increases.

The standalone paired startup gate requires at least seven unique samples for every page/version. Its candidate median must be no more than the matched parent median plus the larger of 33 ms (two frame intervals) or twice the parent's interquartile range. This keeps timing comparison on the same host and prevents one extreme parent sample from defining the allowance. The 70 recorded samples pass. Timing comparison is a reproducible review/release check; CI directly enforces artifact, populated-startup and V8 heap contracts rather than applying Mac wall-clock timings to every runner.

## Worker-enabled journey traffic

The [14 journeys](../audits/page-journey-baseline.json) use seven fresh contexts per version, visiting dashboard, reports, admin, profile and food, then revisiting all five. Native service workers are enabled. The initial page waits for `navigator.serviceWorker.ready`, not merely the observable activated state. Every visited bundle must be present in CacheStorage before proceeding. Parent installation causes two dashboard navigations; the candidate performs one, matching the corrected reload behavior.

| Metric | Parent median | Candidate median | Candidate limit |
| --- | ---: | ---: | ---: |
| All HTTP requests through final readiness | 324 | 285 | Recorded; includes timer-dependent polling |
| HTTP requests excluding Socket.IO polling | 214 | 176 | 190 |
| Completed HTTP response body bytes | 1,476,134 | 1,412,051 | 1,500,000 |
| Origin bundle downloads on cached revisits | 0 | 0 | 0 |

The counter observes final response writes before Socket.IO/Express compression wrappers, so it includes worker-origin precaching and actual negotiated compression (Brotli in this run). A Node regression test compares its counts with independently received gzip and identity response bodies. Bytes exclude HTTP headers, chunk framing and unfinished response bodies. The parent had one unfinished queued byte; the candidate had none. The cold CDP records separately report response transfer bytes including response headers. Neither measure is a packet capture or total server RSS.

The candidate's initial dashboard still downloads app twice (document and worker precache) plus clock. That existing precache behavior is included, not hidden by the one-document-bundle count. The complete journey nevertheless transfers 64,083 fewer completed body bytes and uses 38 fewer non-polling requests. Subsequent visited page bundles load once; cached revisits fetch none from the origin.

## Reproducing and validating resource evidence

Use the same supported Node/browser build for both checkouts, and build the parent with its own lockfile. For example, after preparing a clean parent checkout at `6e11941a` and running `npm ci` there:

```sh
node tools/measure-page-startup.js /path/to/parent 7 > startup.json
node tools/measure-page-journey.js /path/to/parent 7 > journey.json
```

The tools fail resource acceptance when limits are exceeded and mark fewer than seven samples as unassessed. Startup can also take an optional entry and heap-output directory for a diagnostic probe; partial-page probes do not establish complete M15 acceptance. Heap files use exclusive creation and are not overwritten. Checkouts, synthetic inputs and Node/browser versions must remain fixed during a comparison. Existing measured bundle hashes are retained in each output.

`tests/page-resource-acceptance.test.js` rejects incomplete/duplicated runs, omitted revisits, 500 ms startup regressions, excessive heap, excessive body/request counts and cached bundle redownloads. These guard the evidence checker itself; they do not replace browser measurements. The byte-counter test independently checks compressed transport accounting.

The latest hosted failure on `b9f48190` was one Firefox/Node 24 application-worker case: awaiting `registration.update()` raced the intentionally triggered reload and lost the outgoing execution context. The follow-up starts the update without awaiting that promise in the outgoing document, while still requiring the reload, cache retirement and successful page startup. No retry, timeout increase or cache assertion relaxation is used. Final hosted validation is still required.
