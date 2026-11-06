# Dormant socket forwarding preparation (D23)

`lib/server/tenant-socket-forwarding.js` is an explicit request-handling core,
not a listener, public wire protocol or runtime composition. No existing single
or multitenant boot path imports it. `realtime` gains no storage reference or
write grant. There is no new transport/provider, workload authenticator, API
route, credential issuer, retention rule, timeout or numeric resource default.

## Constructor boundaries

`createForwarder({ contextForSocket, transport })` obtains the current trusted
tenant and credential for each write, forwards the unchanged namespace/event
argument vector, and relays the exact acknowledgement arguments only after its
transport promise resolves. A failed or ambiguous forward yields no acknowledgement
and no automatic retry; the existing client's behavior owns retry scheduling.
`bind(socket, namespace)` registers only explicit supported write events. It does
not implement authorize/subscribe or credential storage and is not called by the
existing websocket server. Forwarder failure returns only `{ delivered: false }`,
never raw provider errors or credentials, and logs nothing.

`createApiReceiver({ authenticateTransport, resolveTenant, authorizeSocket,
executeWrite, persistAlarmAck })` separates internal transport admission from
the socket client's authority. Tenant resolution independently supplies the
expected tenant; a mismatching forwarded tenant refuses. Current client authority
must be resolved on every operation using the socket's credential, even when the
transport workload is trusted. It passes the exact event arguments and fixed
`source: 'socket'` to an explicitly injected executor. Omitted alarm persistence
refuses; it cannot fall back to clinical writes. Errors are fixed finite codes.

The execute callback must adapt the existing socket handler/write step without
reimplementing its validation, matching, permissions or reply semantics, and
must resolve only after commit/result confirmation. That actual adapter is
**not implemented here**: current handlers also own purification, treatment
preflight and reply/read-entitlement rules in `websocket.js`. The source tests'
injected executor is not clinical storage or proof those rules already match.
There is no HTTP serializer or production transport authentication implementation;
those require explicit trusted composition, bounded requests, credential privacy
and cross-tenant current-authorization acceptance before runtime wiring.

## Pinned AndroidAPS pattern provenance

`tests/fixtures/socket-forwarding/androidaps-3.4.2.3.json` records the actual local
tag resolution and SHA256 of each inspected source. Synthetic pattern helpers
capture NSClient v1's authorize fields, dbAdd/dbUpdate envelopes, alarm ack argument
order and the acknowledgement fields consumed by the client. This is
**source-pinned pattern replay, not Kotlin/Android binary execution**. It does not
model the complete WorkManager/upload queue or assert an ack timeout.

At pinned commit `05a3433598ac49a3ecafcbd218fc5c1fc39c8719`:

- NSClientService.kt:281 creates the configured socket, :374 sends authorize,
  :603 sends dbUpdate, :621 sends dbAdd, :630 sends alarm ack, and :644 calls
  the upload selector on resend.
- NSAddAck.kt:31-35 consumes the first JSON-array result's `_id`;
  NSUpdateAck.kt:29-35 consumes `result` (`success` or existing `Missing _id`);
  NSAuthAck.kt:13-17 consumes read/write/write_treatment.
- Add-ack worker updates the original object's Nightscout ID/confirmation only
  after the callback is processed. A withheld acknowledgement and re-invoked
  add can therefore be represented by the pattern, but no real Android scheduler
  or server dedupe result is claimed here.

There is a **read-derived namespace gap** to resolve before alarm wiring:
NSClient v1 emits ack on its configured main socket, while current
`websocket.js` has no main-namespace ack handler; the server's alarm ack handlers
are in `api3/alarmSocket.js:168,239` on `/alarm`. The dormant dispatcher can carry
either namespace to an explicitly injected callback, but this does not adopt a
new durable meaning for an otherwise unhandled baseline event. Compare actual
baseline delivery and settle the supported namespace/ack-row contract before
claiming unchanged alarm behavior. Ack-row shape, retention and evaluator
restart acceptance remain absent and are not replaced by callback counters.

## Source checks and authored controls

```bash
NODE_ENV=test TZ=UTC node node_modules/mocha/bin/mocha.js --exit \
  --timeout 5000 tests/tenant-socket-forwarding.test.js
node scripts/test-socket-forwarding-controls.js /tmp/ns-socket-source-controls
```

These use injected callbacks only: no Socket.IO listener, HTTP server, database,
Vault, clinical writer, evaluator or external notification. Tests preserve all
four data events, per-operation credentials, no early/failed acknowledgement,
strict transport/client/tenant separation, ack tenant arguments and exact reply
vectors. Repeated dbAdd reaches the injected API twice; actual write-step dedupe
must later establish one stored result. Authored scratch controls acknowledge
early, replace client authority with role authority, and drop tenant on ack;
each must fail its property assertion, then restore green. Working source is
never changed by the control runner.

## Required focused runtime campaign (not run)

After the adopted D23 entry conditions and a runtime slot are satisfied, compose
the actual socket executor and internal API adapter in an isolated two-tenant
fixture. Replay the pinned envelope sequence against same-head single/Mongo
baseline and forwarding reader/API with independent stored-value oracles. Keep
single boot unchanged. Include treatment/devicestatus add, withheld add callback
and retry, update by returned `_id`, unset/remove and supported alarm namespace.

Predicted green: identical supported acknowledgements and stored values, one
logical stored add on retry, socket source label, no clinical writes on realtime,
current client authority, tenant-local persisted ack observed after evaluator
restart. Predicted red controls: acknowledge before API confirms then fail the
write (acknowledged-but-absent row); substitute role credential (foreign write
refuses without effects); omit ack tenant (cross-tenant/restarted state mismatch).
Outage must not synthesize an acknowledgement. These actual assertions are
**UNMEASURED**, as are hop latency, client timeout behavior, resource bounds,
provider/transport identity, current delivery revocation and durable ack/snooze.
No M5/M6, default enablement or application-ready claim follows from this source
preparation. Later frozen runtime batch gets full/browser/enabled corpus and
final prcheck once; no leaf campaign is requested here.
