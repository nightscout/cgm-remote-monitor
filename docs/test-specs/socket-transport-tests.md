# Socket transport dependency regressions

The transport suites run in both `npm run test-ci` and
`npm run test:dependencies`. CI also checks the installed Socket.IO, Engine.IO,
adapter and WebSocket dependency tree.

`tests/dependency-engine-io.test.js` covers:

- Engine.IO protocols 3 and 4, retaining the legacy-client compatibility enabled
  by Nightscout's `allowEIO3` option.
- Rejecting an attempted protocol change within an existing session, for both
  polling requests and WebSocket upgrades, without corrupting the valid session.
- Gzip/deflate polling responses, releasing an aborted compressed response with
  exactly one send callback, and chunked UTF-8 upload reassembly.
- WebSocket fragment/chunk bounds and resetting the fragment count between
  valid messages. Tests use small explicit caps to keep CI resource use low.

`tests/dependency-socket-parser.test.js` exercises both the installed Node client
and `/socket.io/socket.io.js`, the prebuilt browser script served by Socket.IO.
Both exchange snapshots, large Unicode payloads, binary data and acknowledgements
through polling, WebSocket, and polling-to-WebSocket upgrades. Manual reconnects
and automatic reconnects after two network drops are checked. These tests use
Nightscout's compression thresholds and legacy protocol setting.

The served browser script is shipped inside Socket.IO; updating npm transport
packages does not rewrite that prebuilt script. Test it independently of the
Node client when changing transport dependencies. Existing application WebSocket
suites additionally exercise authorization, data shapes, database writes and
output safety.

No client configuration changes are needed for Engine.IO 6.6.10. Before a release,
check live updates and offline/reconnect behavior behind the deployment's reverse
proxy with both polling and WebSocket enabled.

References: [Engine.IO 6.6.10](https://github.com/socketio/socket.io/releases/tag/engine.io@6.6.10),
[engine.io-client 6.6.6](https://github.com/socketio/socket.io/releases/tag/engine.io-client@6.6.6),
[WebSocket buffering advisory](https://github.com/advisories/GHSA-96hv-2xvq-fx4p).
