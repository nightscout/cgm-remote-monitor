# Real-browser regression tests

This is the first migration in the [jsdom retirement plan](../plans/jsdom-retirement.md). It uses the existing Mocha runner with pinned development-only `playwright-core` 1.63.0. Browser downloads are explicit; ordinary `npm ci`, production installs and Docker builds do not download browsers.

```sh
npm ci
npx --no-install playwright-core install chromium firefox webkit
npm run test:browser
NIGHTSCOUT_TEST_BROWSER=firefox npm run test:browser
NIGHTSCOUT_TEST_BROWSER=webkit npm run test:browser
```

On Linux, install browser system dependencies with `npx --no-install playwright-core install --with-deps chromium firefox webkit`. A missing package, browser executable or emitted application bundle fails the suite. CI runs all three engines on both exact supported Node floors. The Node/MongoDB 5/6 matrix remains unchanged, and Docker validation/publication depends on the browser job as well as backend tests. Modern Playwright WebKit is not proof of compatibility with every older iOS version listed in `.browserslistrc`; historical-browser transformation and release smoke gates still apply.

## Coverage mapping

All six browser jobs passed the comparison phase on both exact Node floors. The old bundle smoke file and the four served-browser jsdom cases are now replaced; Node parser/client coverage remains.

| Existing assertion | Real-browser replacement |
| --- | --- |
| `bundle.smoke.test.js`: namespace object, client object/init, reportclient/profileclient functions, units object/conversion functions | `tests/browser/bundle.test.js` loads the actual emitted production bundle over HTTP and checks all eight types. Grouping five Mocha cases into one does not remove assertions. This is structural coverage, not report-calculation or full-page rendering coverage. |
| `dependency-socket-parser.test.js`: served browser polling, WebSocket and polling-to-WebSocket upgrade over initial connection plus two reconnects | `tests/browser/socket-client.test.js` loads `/socket.io/socket.io.js` from the installed real server and preserves transport, snapshot, Unicode, large message and binary acknowledgement assertions for all three cycles. |
| Served browser automatic reconnection after two network drops | Real browser closes the engine twice, verifies reconnection/data and asserts one server peer after each cycle. Node-client, malformed-packet and parser coverage stays in the Node suite. |
| Harness guarantees | `tests/browser/isolation.test.js` exercises fetch, XHR, script/image/style/iframe loads, worker fetch, redirect and WebSocket attempts against an unapproved local server over two contexts. It asserts zero requests/handshakes, empty initial storage, blocked service workers and closure of all pages after deliberate failures. |

## Fixture behavior

Each test gets a fresh non-persistent context and closes it in `finally`; root hooks detect/clean any leaked contexts and close the browser at suite completion. Uncaught page errors and unexpected blocked requests fail the helper. Only the exact `http://127.0.0.1:<fixture-port>` origin is permitted, not arbitrary loopback hosts or ports.

HTTP routing fetches one finite response with `maxRedirects: 0` and fulfills its actual headers/body. Redirect responses are rejected, including same-origin redirects: these fixtures do not test redirect navigation or streaming HTTP responses. A first implementation using `route.continue()` failed the redirect isolation regression because Chromium followed the redirect without re-entering the handler. Allowed WebSockets retain the native browser connection; only disallowed destinations are intercepted and closed. Chromium receives local-network permission scoped to the fixture origin because fulfilled documents lack a network address; the HTTP/WebSocket allow-list remains enforced. Service workers are blocked explicitly. These test-fixture controls must be revisited when adding new transport/navigation requirements.

The [Playwright library API](https://playwright.dev/docs/library) supports reuse of Mocha rather than adding another general test runner. [Context routing and permissions](https://playwright.dev/docs/api/class-browsercontext) provide the isolation hooks. The application does not acquire a browser-automation runtime dependency or a DOM substitute.

## Current evidence and next gate

Initial local Node 22.23.2 validation passes eight cases in Chromium 153.0.8010.12 and WebKit 26.6. Firefox 1543 fails to launch its temporary profile on this macOS host, including with a fresh `/tmp` profile location. Hosted Linux Chromium, Firefox and WebKit all passed on Node 22.23.2 and 24.20.0 in [comparison CI](https://github.com/nightscout/cgm-remote-monitor/actions/runs/33984607458). The first isolation test exposed and then verified the redirect fix. All retained lock entries remain identical to parent `d87f77e6`; only the development package path playwright-core is added. Production dependency entries remain unchanged. The refreshed main suite passed 2,004 tests (three existing pending), client-core 283 and dependency compatibility 313; the nine removed Node cases are covered by the new browser suite. Chromium/WebKit also passed on the Node 24.20.0 floor. Both builds, changed-file lint and actionlint passed, and production bundles are byte-identical (app 1,761,400 bytes; clock 152,131 bytes). No test-resource saving is claimed; see the measured costs below.

The comparison retained the old tests until the replacement jobs passed and this assertion mapping was checked. The namespace test also fails when `reportclient` is deliberately replaced with `undefined`; the mutation was isolated from the production bundle. Full jsdom retirement requires migrating the other consumers listed in the plan; this first slice does not remove the package yet.

## Measured test-tool cost

Seven fresh matched processes per runner used Node 22.23.2, parent `d87f77e6` and initial browser head `87663161`, with identical production bundles. That comparison imported the Playwright wrapper, which only re-exports the same core API; the final code imports playwright-core directly. The timing/RSS figures remain labeled as initial-build measurements, not measurements of the final import cleanup. The selected old suite has nine cases (five bundle plus four served-browser); the replacement has five grouped cases preserving those assertions. New isolation tests are excluded from this comparison. Each browser process is closed between samples. Median [min–max]:

| Selected suite | Wall seconds | Peak summed process-tree RSS bytes |
| --- | ---: | ---: |
| jsdom | 0.903 [0.884–1.335] | 172,883,968 [168,460,288–175,570,944] |
| Chromium | 1.139 [1.121–1.470] | 486,883,328 [486,440,960–488,767,488] |
| WebKit | 1.890 [1.853–2.302] | 328,761,344 [328,187,904–331,218,944] |

Reproduce with built parent/candidate worktrees and browsers installed for the candidate:

```sh
python3 tools/audits/browser-test-probes.py /path/to/parent /path/to/candidate /path/to/results --node /path/to/node --browsers chromium webkit
```

The Unix probe samples `ps` about every 25 ms and sums the Mocha process and current descendants. Shared pages may be counted more than once; this is neither unique physical memory nor server heap, and short peaks can be missed. It includes browser launch and monitoring overhead. Real browsers cost more test memory here; their value is replacing a DOM emulator with actual browser behavior, not reducing this fixture's RAM. Firefox has no local cost result because launch failed; Linux CI passed its functional tests.

The final dependency is `playwright-core` directly: the `playwright` entry point only re-exports it, so the wrapper/test-runner package is unnecessary for Mocha. This avoids 5,094,512 bytes and one package path compared with the initial comparison build. Added npm file contents are 13,453,369 bytes for playwright-core. The explicit macOS browser installation additionally occupies 1,183,917,464 bytes of regular-file contents: Chromium 375,624,473; headless shell 204,662,008; FFmpeg 2,606,838; Firefox 304,282,055; WebKit 296,742,090. These are uncompressed installed contents, not network downloads, unique disk blocks or Linux image bytes. The existing shared FFmpeg cache is counted in that total even though it need not be downloaded again. The final jsdom removal must report net npm savings separately from browser-tool storage; this first migration temporarily adds one dev path. Production package entries and emitted bundles are unchanged, so no production-image or server-memory saving is claimed.

Rollback the complete browser-migration child PR, restoring its old tests and CI wiring together. No application, database or browser-storage migration is involved.

## DOMPurify reference migration

`tests/browser/dompurify.test.js` replaces all 15 cases from `tests/dependency-dompurify.test.js` with the installed DOMPurify browser distribution and a real DOM. DOMPurify remains an independent development-only comparator; production still uses sanitize-html.

The eight attack categories retain two sanitizer calls each, recursive inspection of nested `template.content`, dangerous tag/handler/URL checks and the ampersand sentinel. Four visible-note cases, exact safe/nested-template serialization and two SVG presentation-attribute cases remain. Every case gets its own isolated context. The replacement passes all 15 cases in Chromium and WebKit locally; bypassing sanitization in a temporary mutation makes the event-handler test fail with `onerror`, demonstrating the assertion still detects the bug. All three engines in current integration CI remain required before merge. The larger differential corpus and production sanitizer mutation tests remain in their current suites for subsequent migration.

This step changes no dependency versions, application behavior, output policy, database or browser assets. Rollback restores the old test file and removes its mapped browser file together. It does not remove jsdom yet.

Against browser-foundation parent `eb01da5b`, the full local browser suite passes 23 cases in Chromium and WebKit on both Node 22.23.2 and 24.20.0. The Node suite passes 1,989 cases with the same three existing pending tests (2,004 minus the 15 migrated cases); client-core passes 283 and dependency compatibility passes 298 (313 minus 15). A clean install/production build and changed-file lint pass. Firefox validation is provided by the required Linux CI jobs because its downloaded binary cannot launch a profile on this Mac. This is a coverage migration, with no additional package or production-memory claim.

## Sanitizer corpus and production reparsing migration

`tests/browser/sanitizer-differential.test.js` replaces the 300 cases in the former top-level differential suite and the one browser-parsing case in `tests/security.test.js`. All 30 corpus objects are unchanged, and all 300 original case titles remain, beneath a new browser-suite parent. The mapping is 120 sanitizer-output safety cases (30 inputs × four sanitizers), 30 divergence records, 120 cases using the existing EJS escaping model, 30 raw `textContent` cases, plus the production case with 12 hostile payloads and three parse/serialize rounds each. Server sanitizer and storage contracts remain in the Node security suite.

Production, xss and strict sanitize-html outputs are still computed with their actual Node modules; DOMPurify runs its installed browser distribution. Each parser case gets a fresh isolated context. `DOMParser` parses an inert full HTML document, preserving the old full-document parser check without executing attack markup in the fixture page. This checks parsed structure, not script execution, layout or a complete application rendering flow. The EJS helper remains the same escaping model as before; actual output-sink and rendering integration tests are separate migration work. The diagnostic divergence report tolerates incomplete matrices during focused or failed runs without suppressing case failures.

On the initial candidate, all 301 cases pass in Chromium and WebKit on Node 22.23.2. The 30 DOMPurify outputs match the previous jsdom results exactly in both engines, with zero attempted network requests during the isolated output comparison. A temporary production-sanitizer bypass fails 11 corpus assertions for script tags, handlers and unsafe URLs; bypassing the sanitizer in the repeated-parsing case also fails. The existing xss less-than-note truncation remains visible in the divergence record; xss is a test comparator, not a proposed runtime replacement.

The remaining main suite passes 1,688 cases with three existing pending tests (1,989 minus 301); no tests were disabled. NYC still reports the same covered line, branch and function counts, with one fewer covered statement in that Node job as these cases move to a separate browser job. Browser coverage is not included in NYC. No application code, dependency version, stored-data policy or browser assets change. Current-parent Chromium/Firefox/WebKit CI on both Node floors, backend checks and native Docker validation remain merge gates. Rollback restores both former test locations and removes the mapped browser file together.
