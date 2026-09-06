# jsdom and analyzer WebSocket regression tests

This update uses jsdom 26.1.0 and the bundle analyzer's ws 7.5.13. The application
transport packages already use Socket.IO 4.8.3, engine.io-client 6.6.6 and ws
8.21.3. Keep the two WebSocket consumer lines distinct when checking resolution.

jsdom 26.1.0 preserves the existing Node support. Newer jsdom releases require
higher Node patch versions, and jsdom 30 drops Node 20. Upstream recommends 26.1.0
for older Node environments. Moving to the newest major needs a separate Node
support decision. The canvas v3 peer change in jsdom 26 does not affect this
repository: canvas is not installed or used by these fixtures.

`tests/dependency-jsdom.test.js` runs the four existing secure-jsdom isolation
tests in normal CI, where the nested fixture path was previously not discovered.
It also covers scripted-window realm isolation, storage lifetime, selectors and delegated form events, SVG
interfaces/viewport relationships, indexed form controls, composed abort
signals, entities/template content and repeated XHR multipart uploads. Network
requests use an explicit local HTTP fixture; ordinary DOM fixtures remain
network-blocked.

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

These are development/test dependencies. No user configuration or visual changes
are required, and production browser bundles should remain unchanged.

References: [jsdom 26.1](https://github.com/jsdom/jsdom/releases/tag/26.1.0),
[jsdom Node compatibility](https://github.com/jsdom/jsdom/releases/tag/27.0.1),
[ws 7.5.13](https://github.com/websockets/ws/releases/tag/7.5.13).
