# APNs provider maintenance (M09)

Upgrade `@parse/node-apn` from installed 5.2.3 to 8.1.0, the latest release
verified against the registry and [upstream releases](https://github.com/parse-community/node-apn/releases)
on 2026-09-06. Its runtime policy explicitly supports Node 22 and 24. The
intervening major releases drop older Node versions; the API remains CommonJS.
Retain the provider: native HTTP/2 and crypto do not replace APNs token handling,
response classification, retries and session management by themselves.

The new provider directly requires node-forge 1.4.0, so remove the redundant
root override. `npm ls` confirms this is the sole node-forge consumer. It shares
debug 4.4.3 and jsonwebtoken 9.0.3 with the existing graph, removing five nested
package paths (debug, jsonwebtoken, jwa, jws and ms). No other retained package
version changes. The full npm audit has zero known advisories at review time.

## Behavior and regression coverage

Provider.send now uses allSettled and returns individual transport rejections
in `failed`. Loop must still report failure rather than success, invoke its
completion once, and tear down the provider. The notification implementation
now explicitly emits the default priority 10 header. Loop's unspecified
push-type and its topic, APS and custom payload contracts are retained. The
Live Activity `events` to `event` change does not affect Nightscout's consumers.

`tests/apn-transport.test.js` uses the actual public Provider and Notification,
a generated EC signing key, an owned certificate and a loopback TLS/HTTP2
server. A scoped loader supplies only the provider's fixture address/CA options;
it executes the actual Loop notification code. No Apple server or real device
is contacted, and TLS validation is enabled.

Over two cycles, the tests verify:

- JWT ES256 signature, issuer and key ID; request method, device path, topic and
  priority; temporary override/cancel, carbs/absorption and bolus payloads;
  notes, origin and the five-minute payload expiration interval.
- BadDeviceToken rejection, transient 503 retry with identical payload,
  exhausted retry limits and one completion per notification.
- An untrusted certificate prevents any notification request reaching the server.
- HTTP/2 sessions close and both heartbeat timers are cleared after success
  and failure. The new SDK has separate normal/broadcast heartbeat timers.

Existing APN lifecycle and Loop environment-selection tests remain in place.
The owned transport tests supplement them; they do not establish real Apple
account credentials, device receipt or delivery timing. No runtime Loop code,
notification policy or UI is intentionally changed. All six generated browser
JavaScript bundles are byte-for-byte identical to the preceding MIME build.

## Resource tradeoff

Compared with the preceding MIME candidate, summing each production package's
own regular files (excluding nested node_modules to avoid double counting):
282 paths / 60,325,080 bytes becomes 277 paths / 60,348,921 bytes. Removing
five nested copies and an override simplifies the graph, but the newer SDK's
published files offset that reduction: net **23,841 bytes larger**. This is a
maintenance upgrade, not a claimed package-size or runtime-memory saving.

## Validation

Run `tests/apn-transport.test.js`, `tests/apn-lifecycle.test.js` and
`tests/loop-server.test.js` on both supported Node floors. Run the full backend
suite, clean install/production build, npm dependency resolution and audit,
then require the existing hosted CI/CodeQL matrix and merge-tree verification.
No additional CI environment is introduced.
