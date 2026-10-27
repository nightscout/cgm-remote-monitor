# Analyzer WebSocket regression tests and jsdom retirement

The jsdom 26 migration described by PR #8544 is historical. M08 now removes
jsdom and its unused compatibility/harness files after migrating application
contracts to the required real-browser suite. The [retirement plan](../plans/jsdom-retirement.md)
and [browser specification](browser-tests.md) record per-case coverage,
isolation, validation and tooling costs. A jsdom major upgrade is not required.

`tests/dependency-ws-analyzer.test.js` remains active under `test-ci` and
`test:dependencies`. It resolves webpack-bundle-analyzer's actual ws copy,
checks bounded fragments/chunks and verifies counter resets between valid
messages. Fresh connections exchange Unicode and binary messages twice.
Keep this consumer distinct from the application's Socket.IO transport tree.

Browser authentication and served Socket.IO checks now live in
`tests/browser/authentication.test.js` and `socket-client.test.js`. They retain
native storage and repeated transport/reconnection contracts. The browser
suite requires Chromium/Firefox/WebKit on both Node floors; its isolation
checks replace applicable guarantees from the removed DOM harness.

No application, configuration, visual or stored-data change is required for
this test-tool removal. Production is already jsdom-free. The earlier
[ws 7.5.13 release](https://github.com/websockets/ws/releases/tag/7.5.13)
remains the reference for the analyzer regression checks.
