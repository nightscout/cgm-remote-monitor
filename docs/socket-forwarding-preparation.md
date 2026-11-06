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

The dormant DATA executor calls the extracted existing socket handlers, including
purification, treatment preflight and reply/read-entitlement rules. It resolves
their callback vector after their existing write/result work; a selected native
PostgreSQL port supplies its owned commit boundary. Source comparison covers the
bounded pattern below; actual database and client parity require the opt-in lab.
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

## Canonical DATA executor and source checks

`socket-write-handlers.js` extracts the existing four DATA handlers, their
purifier/domain preparation, matching rules and write-intent calls. The single
listener still uses those handlers with live connection authorization getters.
`tenant-socket-write-executor.js` invokes precisely those handlers from the
trusted API composition, binds the verified tenant, and resolves their unchanged
callback argument vector. It admits only main-namespace DATA writes; it does not
implement main-namespace alarm ack.

A trusted storage port must supply its owned `intentFactory`; a missing factory
refuses. Mongo without a selected port keeps the existing write-intent fallback.
The PostgreSQL collection constructor explicitly admits source `socket`, retains
socket-specific write rules and legacy predicate translation, and uses the
existing transaction/clock/event wrapper. Socket is never relabelled as REST.
No listener or default selects the forwarding executor.

```bash
NODE_ENV=test TZ=UTC node node_modules/mocha/bin/mocha.js --exit \
  --timeout 5000 tests/tenant-socket-forwarding.test.js \
  tests/socket-write-handlers.test.js tests/postgres-collection-intent.test.js \
  tests/write-intent.socket.test.js
node scripts/test-socket-data-controls.js /tmp/ns-socket-data-controls
```

Source tests compare the frozen pre-extraction listener with the shared DATA
handlers over recording storage. Pinned AAPS DATA pattern replay includes
withheld client handling/retried treatment add, device status add, update by
returned `_id`, unset and remove, exact callback vectors, stored values and one
logical retried row. Only server-owned clocks are normalized; identity kinds and
clinical values remain distinct. Stable explicit synthetic ids make this source
comparison independent of generated identifiers. It is not a real socket,
database, Android binary or clock acceptance claim.

The DATA source controls must fail for an early acknowledgement while the
canonical insert remains blocked, and for bypassing the current client authority
so a foreign role reaches context acquisition. Both must restore green. The
original broader dispatcher source controls remain separately available.

## Focused runtime selector (prepared, not run)

```bash
node scripts/test-multitenant.js --only tenant-socket-data-forwarding \
  --record /tmp/socket-data-forwarding-record.json
```

This opt-in suite uses actual Socket.IO clients, a same-head single Mongo
reference, current restricted PostgreSQL subject authority, canonical PostgreSQL
DATA ports with the durable tenant clock, and independent typed stored-value
oracles. All schemas/roles and the Mongo reference database have random owned
names. Transport identity and credential-to-principal lookup are explicit lab
injections; no production workload authenticator or cryptographic client verifier
is claimed. The pinned sequence is **pattern replay, not an Android binary**.

Predicted positives: exact supported callback/stored-value parity; retry leaves
one logical row; socket source; foreign credential refusal without effects;
client callback and intent only after API COMMIT; forced post-write abort leaves
no success identity, data, event or clock advance. Prepared controls for the
runtime owner: early callback plus forced abort must expose acknowledged missing
write; replacing current subject authority with transport role must fail the
foreign-subject oracle; bypassing the port transaction must fail independent
visibility/event/rollback/clock checks. Runtime controls and all actual socket/DB
outcomes are **UNMEASURED** until a coordinator-owned slot runs them.

Production transport/credential-origin resolution, actual pinned client binaries,
resource/latency bounds, current delivery revocation and durable alarm ack/snooze
remain open. The main-namespace ack gap above still requires a supported contract;
no ack row, evaluator behavior or M5/M6 completion is inferred from DATA work.
A later frozen batch owns full/browser/enabled corpus and final prcheck.
