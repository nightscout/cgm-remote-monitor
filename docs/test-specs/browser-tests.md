# Real-browser regression tests

This is the first migration in the [jsdom retirement plan](../plans/jsdom-retirement.md). It uses the existing Mocha runner with pinned development-only Playwright 1.63.0. Browser downloads are explicit; ordinary `npm ci`, production installs and Docker builds do not download browsers.

```sh
npm ci
npx --no-install playwright install chromium firefox webkit
npm run test:browser
NIGHTSCOUT_TEST_BROWSER=firefox npm run test:browser
NIGHTSCOUT_TEST_BROWSER=webkit npm run test:browser
```

On Linux, install browser system dependencies with `npx --no-install playwright install --with-deps chromium firefox webkit`. A missing package, browser executable or emitted application bundle fails the suite. CI runs all three engines on both exact supported Node floors. The Node/MongoDB 5/6 matrix remains unchanged, and Docker validation/publication depends on the browser job as well as backend tests. Modern Playwright WebKit is not proof of compatibility with every older iOS version listed in `.browserslistrc`; historical-browser transformation and release smoke gates still apply.

## Coverage mapping

The comparison phase retains the existing jsdom tests while the replacements are validated:

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

Initial local Node 22.23.2 validation passes eight cases in Chromium 153.0.8010.12 and WebKit 26.6. Firefox 1543 fails to launch its temporary profile on this macOS host, including with a fresh `/tmp` profile location; hosted Linux Firefox remains required before migration. The first isolation test exposed and then verified the redirect fix. All retained lock entries remain identical to parent `d87f77e6`; only two development package paths, Playwright and playwright-core, are added. Production dependency entries remain unchanged. Package/browser bytes and matched-suite timing/memory will be recorded before claiming any cost reduction.

Do not remove the existing jsdom coverage until the replacement CI jobs pass and the assertion mapping has been checked. Full jsdom retirement requires migrating the other consumers listed in the plan; this first slice does not remove the package yet.

Rollback the complete browser-migration child PR, restoring its old tests and CI wiring together. No application, database or browser-storage migration is involved.
