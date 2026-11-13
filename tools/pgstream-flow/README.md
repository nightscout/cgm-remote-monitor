# Local pgstream flow proof

Dormant synthetic harness for the event-driven reset. It uses actual PostgreSQL
replay, clinical evaluator, browser frame builder, realtime protocol, Socket.IO
server and client. It does not enable a shipping role or change deployment pins.

Use an isolated disposable PostgreSQL database whose name contains `test`, with
wal2json installed, logical WAL enabled and bounded slot retention. PostgreSQL
16.16 also requires `output_plugin_libraries=wal2json`. Supply a verified upstream
binary by absolute path. Ports 19913 (adapter/socket) and 19914 (subscriptions)
must be free. Only run one harness process at a time.

```bash
export NS_TEST_POSTGRES_ADMIN_URI  # explicit local disposable database
export PGSTREAM_BINARY           # verified upstream release executable
export PGSTREAM_FLOW_EVIDENCE     # ignored retained evidence directory
node tools/pgstream-flow/proof.js
```

The test provisions synthetic A/B schemas and restricted application/reader roles.
A distinct existing checkpoint consumer persists an array envelope containing the
completed clinical result, its browser frame, input signature, settings identity,
content revision and next due instant. Acquired input remains a separate consumer.
The output subscription explicitly selects that completed-output consumer; it
never starts raw-input evaluation. HTTP success follows the output transaction.
Clinical writes never call the webhook or NOTIFY. A real connected client must
receive a subsequent frame through output CDC.

Focused controls use the same executable:

- `PGSTREAM_FLOW_ABLATE=early-ack`: respond before durable work; the durable
  clinical assertion must fail.
- `PGSTREAM_FLOW_ABLATE=drop-output`: suppress output delivery after initial
  frames; the connected-client update assertion must fail.
- `PGSTREAM_FLOW_ABLATE=drop-due-recovery`: discard the persisted-due recovery
  action; the cache-loss due assertion must fail.
- `PGSTREAM_FLOW_CRASH=before-durable`: kill the CDC process before evaluation
  and HTTP acknowledgement. The committed write must replay after restart.
- Default crash path: persist output, kill CDC before HTTP acknowledgement, then
  require redelivery to preserve the content revision and input checkpoint.
- `PGSTREAM_FLOW_STOP_AFTER_DUE=1`: finish after the independent cache-loss due
  simulation, without entering the final crash path.

Cache-loss recovery clears evaluator/config caches and timers, then reconstructs
next-due timers from persisted output. It is explicitly a cache-loss simulation,
not an OS process restart. The quiet interval counts adapter Node SQL and clinical
work; it does not instrument pgstream's own database queries. Tenant concurrency
is serialized in one adapter; this does not prove multiple-worker ownership or
restore generation fencing. Authorization uses explicit fixture adapters, not
production authority/lifecycle acceptance. Clinical notification requests are
persisted as part of output; no provider delivery/exactly-once effect is claimed.

The pinned upstream transport must pass the controls. A stopped notifier may
leave its process alive; the harness labels external stop/restart explicitly,
without claiming autonomous liveness. WAL retention configuration is recorded,
but exceeding the cap, slot invalidation and rebootstrap require separate proof.
Raw logs, config and payloads stay outside Git. No full-suite readiness, capacity,
application-dev merge or production acceptance follows from these checks.
