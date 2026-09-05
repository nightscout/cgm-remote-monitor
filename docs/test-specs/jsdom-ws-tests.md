# jsdom and analyzer WebSocket regression tests

The modernization branch uses **jsdom 30.0.1**. Its required Node range (`^22.22.2 || ^24.15.0 || >=26.0.0`) is covered by Nightscout's supported Node 22.23.2/24.20.0 floors. Earlier jsdom 26.1 compatibility with Node 20 is no longer a constraint after M07.

The bundle analyzer still uses ws 7.5.13; application transports use Socket.IO 4.8.3, engine.io-client 6.6.6 and ws 8.21.3. Keep those WebSocket consumers distinct from jsdom's new undici transport when checking resolution.

The jsdom 27–30 review covers changed selectors/computed styles, PointerEvent clicks, localhost Secure-cookie handling, VirtualConsole API renaming, resource loading and Node floors. No VirtualConsole `sendTo` consumer needed migration. The only ResourceLoader subclass was the blocked-network test fixture; it now uses jsdom's public `requestInterceptor` API while preserving explicit resource overrides and the fetch/XHR throwers.

The first full run exposed a legacy fixture bug: `benv-shim.teardown(true)` deleted Node's native `Event`, breaking undici WebSockets later in the suite. The shim now restores original property descriptors, including native constructors and accessor globals. A fresh-process regression exercises replacement windows and partial/full/repeated teardown twice; it fails with the old shim and verifies native EventTarget dispatch after cleanup. Existing Socket.IO tests continue to exercise real served-browser reconnects.

`tests/dependency-jsdom.test.js` runs the secure-jsdom isolation
tests in normal CI, where the nested fixture path was previously not discovered.
It also covers scripted-window realm isolation, storage lifetime, selectors and delegated form events, SVG
interfaces/viewport relationships, indexed form controls, composed abort
signals, entities/template content and repeated XHR multipart uploads. Network
requests use an explicit local HTTP fixture; ordinary DOM fixtures remain
network-blocked. Actual stylesheet, iframe, script and WebSocket attempts are tested against a local server over two DOM lifecycles, asserting zero requests.

`tests/dependency-ws-analyzer.test.js` exercises the actual ws copy resolved by
webpack-bundle-analyzer. Small explicit receiver caps check bounded fragments and
chunks without large allocations. Consecutive valid fragmented messages check
that the fragment counter resets, guarding the bug fixed in 7.5.13. Fresh
connections exchange Unicode and binary messages twice.

`tests/hashauth.modern.test.js` additionally repeats the real authentication
store/remove cycle twice and checks both localStorage and in-memory state. The
original PR's legacy benv failure is covered by the current modern test harness.

Both dependency suites run under `test-ci` and `test:dependencies`; the
authentication suite runs under `test-ci`. CI verifies jsdom and both ws versions
with `npm ls`. Existing DOMPurify, chart, report, profile and served Socket.IO
client tests continue to exercise jsdom.

The jsdom graph adds 17 locked paths and removes seven, with 15 retained entries updated. All 672 production-marked lock entries remain identical to modernization parent `756fca7c`; no server-memory or production-package saving is claimed for this maintained test-tool upgrade.

These are development/test dependencies. No user configuration or visual changes
are required, and both production browser bundles are byte-identical to the parent (app: 1,761,400 bytes; clock: 152,131 bytes).

References: [jsdom 30.0.1](https://github.com/jsdom/jsdom/releases/tag/v30.0.1),
[jsdom major release notes](https://github.com/jsdom/jsdom/releases),
[resource-loading API](https://github.com/jsdom/jsdom/blob/v30.0.1/README.md#loading-subresources),
[ws 7.5.13](https://github.com/websockets/ws/releases/tag/7.5.13).

Validation: clean locked installs and production/development builds passed. Node 22.23.2 main suite passed 1,981 tests before the cachebuster integration; Node 24.20.0 passed 1,986 on refreshed parent `756fca7c`, both with three existing pending. Focused DOM/native-global/Socket.IO tests passed 35 cases on both exact Node floors; client-core passed 283 and dependency compatibility 318. Final integration-target CI remains required.

Rollback: revert the jsdom/harness upgrade together and perform a clean locked install. No application data, configuration or browser storage migration is involved. The native-global restoration can be retained independently; the resource-interceptor migration must be reverted with the dependency.
