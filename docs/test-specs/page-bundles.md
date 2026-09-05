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

The full-page fixture renders all five actual templates, loads the production bundles and actual startup scripts, and connects the real browser Socket.IO client to an owned Socket.IO server. Finite local API responses exercise startup rather than replacing client initialization or authentication callbacks. Only the three optional remote-font imports in the main/report stylesheets are removed from the fixture; all other assets and styles are served normally. Its browser context blocks service workers, so cache lifecycle remains a separate gate.

Twelve cases cover direct startup with stored authentication and with the real authentication dialog on all five pages, two connection drops per case, preserved report/profile/food form values, a single food save after reconnects, retry after a failed initial food fetch, and all four dashboard links plus their return navigation. The dashboard receives a synthetic glucose value and must display successive values after reconnect. All twelve pass in the full 470-case Chromium/Node 22 suite and focused WebKit/Node 24 suite. The three real-server production/development HTTP contracts and changed-file lint also pass. These cases use small fixtures, not a populated-history performance workload.

The tests exposed two pre-existing reconnect defects, reproduced against the monolithic parent: admin appended another 13 controls after reconnect, and a food-save click created three records after two reconnects. Admin and food now guard page setup, following the existing report/profile pattern. Food resets its guard if the initial fetch fails so reconnect can retry. Socket authorization and data delivery still run on each reconnect; the shared client callback contract is unchanged.

The served Socket.IO client now uses `closeOnBeforeunload: true` for both namespaces. A minimal Socket.IO-only control reproduced WebKit navigation access-control errors with the default option and eliminated them with this option; plain XHR navigation did not reproduce the error. Both Chromium and WebKit retained a live acknowledgement round-trip after back navigation. The full application navigation case uses native HTTP responses under same-origin CSP, checks all four links, and goes back/forward twice with a live socket acknowledgement after each return. No browser errors are ignored.

## Evidence and limits

- Five real-browser namespace/request cases check shared client exports, page-specific exports, report-only Flot and one/two bundle requests. Component fixtures load the entry corresponding to their tested feature; mixed profile/report tests select the appropriate entry.
- Nine Node tests execute the actual worker source and cover on-demand caching, awaited writes, failed responses, cache-open/quota failures, bypass rules, old/new cache generations and ranges.
- A dedicated native-worker browser fixture covers install/first visit, cached script execution with the origin connection unavailable, uncached failure and worker update. Same-origin CSP on both document and worker constrains network access without request interception. These fixtures use small version-labelled script responses to isolate cache behavior; they are not full application-page boot tests.
- Chromium also runs with Playwright offline emulation. On the local WebKit 26.6 build, that emulation blocks even a minimal worker which returns a constant response without accessing the network; the same control works in Chromium 153. WebKit therefore uses actual origin connection failure. One exact WebKit network-error diagnostic is allowed only for the deliberately requested unavailable asset; other page errors fail the fixture. Hosted Firefox coverage remains required.
- Fully booted HTTP contracts verify all six versioned production bundles (bytes, gzip/identity, HEAD, ETag/Last-Modified/304), each template's shared/page URLs, and all six development middleware assets.

Still required before M15 completion: initial loading/offline and download-recovery/cache/browser lifecycle integration with real application pages, HMR behavior for each page entry, final source graph and numeric transfer/request/startup/heap budgets, and the complete hosted matrix/Docker checks on the final head. The first draft head passed all hosted checks, but that does not validate subsequent changes or the remaining gates. No M15 merge-ready claim has been made.

## Current transfer measurement

Against the merged startup-retry parent, the actual shared app drops from 1,396,779 to 1,154,484 bytes. Python gzip level 9 drops from 401,211 to 329,920 bytes (71,291 fewer). With the reconnect guards and navigation teardown option, all five page entries plus their shared code total 402,695 gzip bytes, 1,484 more than the previous all-in-one bundle when every page is visited. Clock bytes are unchanged, and the package manifest/lockfile are unchanged. The emitted shared app source map contains neither Flot nor report plugins. These are artifact measurements, not populated-page startup or heap measurements.
