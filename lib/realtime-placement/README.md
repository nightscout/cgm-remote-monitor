# Fixed-roster realtime placement interface

This module is the operator-facing core interface for the optional controlled
realtime sharding capability. Enable it only with matching runtime, cohort, alarm and deployment bindings.
Deployment acceptance is measured separately from the focused core checks. Automatic partition takeover and durable viewer
alarm replay are outside this capability.

## One intended assignment, explicit readiness

`MULTITENANT_REALTIME_PLACEMENT` is the absolute path of a bounded JSON file:

```json
{
  "version": 1,
  "rule": "sha256-u32be-v1",
  "shardCount": 2,
  "generation": 1,
  "workers": [
    {
      "id": "a",
      "incarnation": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "address": { "socket": "/run/nightscout/realtime-a.sock" },
      "consumerOrigin": "http://realtime-a:1339"
    },
    {
      "id": "b",
      "incarnation": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "address": { "socket": "/run/nightscout/realtime-b.sock" },
      "consumerOrigin": "http://realtime-b:1339"
    }
  ],
  "owners": ["a", "b"]
}
```

`shardCount` is required, 1..65,536, independent of process count. Hash the
canonical lowercase UUID text including hyphens with SHA256, take its first four
bytes as an unsigned big-endian integer, and reduce modulo `shardCount`. Workers
are a bounded fixed roster (1..1,024). Adding a worker does not change logical
assignment; only explicit `owners` changes move shards. This first capability
refuses changing the hash rule or logical shard count in place.

Each boot gets a new platform-generated UUID in `REALTIME_WORKER_INCARNATION`,
with its declared `REALTIME_WORKER_ID`. IDs/UUIDs do not prove exclusivity. Runtime
also holds one actual database owner resource per stable realtime consumer and
worker; a separate bounded owner connection adds one connection per process.
Keep the durable realtime `consumer` unchanged across boot/owner moves.

`address` is the existing fixed-instance private transport address (`{socket}` or
`{url}`), validated through `listenerConfig.instance`. It is distinct from a role
service alias. `consumerOrigin` is the private HTTP(S) backend serving the public
Socket.IO protocol, with no credentials, path, query or fragment. Edge and alarm
routing resolve canonical tenant IDs, never arbitrary request destinations.

`load(source, {internal, self, maxBytes, timeoutMs})` returns null when no placement
file is selected. `internal` is the existing resolved listener configuration, or
`listenerConfig.observer(source)` for a pure operator/router that serves no role.
An observer validates fixed destinations and refuses self admission and service
aliases; it creates no listener. `resolve([])` is not a serving configuration.
`self:true` reads both worker environment fields and validates that actual boot
against the map; routers use `self:false` (default). The returned object provides:

- `current()` — current parsed intended map, failing closed on invalid/unreadable
  files, rollback, same-generation mutation or repartition.
- `route(tenant)` — `{generation,shard,worker,incarnation,endpoint,consumerOrigin}`;
  null/unassigned owners refuse. `endpoint` is a checked private transport option.
- `owns(tenant)` and `assert(tenant, expectedRoute?)` — current self ownership.
- `inspect()` — bounded configuration identity/refusal information; it does not
  acquire ownership or establish tenant readiness.

`MULTITENANT_REALTIME_PLACEMENT` is the authoritative backend/cohort view.
`MULTITENANT_REALTIME_ROUTES` is a separate admitted edge/evaluator routing view.
`loadRoutes(source, options)` selects the latter when supplied, otherwise uses
the placement file for a single-view profile. Cohorts always use the backend
view; route staging does not change their expected digest. Mount directories,
not individual files, so atomic replacement reaches readers.

Readers can miss intermediate trusted publications and still accept a newer
monotonic map. The publisher validates every consecutive transition against the
actual prior file under its publication fence.

A map describes intended ownership. **A file rename is not readiness.** Runtime
warms a staged projection outside the active tenant roster and only activates the
actual prepared snapshot after current owner/settings/activity and final registry
membership checks. Backend handshake and alarm admission also require a warm
current owner. Cold/failed/paused targets refuse; they never fall back to another
worker or acknowledge a fabricated handoff. The operator stages the backend map,
waits for expected eligible tenants' actual readiness, then publishes the matching
edge/alarm routing view. Route views carry the same generation and mapping bytes.
A target may remain unavailable while another shard continues.

Realtime `/health` includes `placement` identity/resource state and per-tenant
`ready`; deferred tenants remain explicitly unready. An honestly idle worker has
zero configured tenants. Worker/control liveness, assignment admission and tenant
readiness are distinct. Do not use aggregate worker readiness as proof that a
particular paused tenant is ready.

## Controlled replacement

A later generation includes:

```json
{
  "transition": {
    "previousGeneration": 1,
    "previousOwners": [
      { "worker": "a", "incarnation": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { "worker": "b", "incarnation": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
    ],
    "stopped": [
      { "worker": "a", "incarnation": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
    ]
  }
}
```

The next generation must equal the previous generation plus one. Every changed
old owner, and every removed/reincarnated worker including an idle worker, requires
a stopped confirmation. A stopped incarnation cannot remain in the new roster.
A reusable ordinal, lease expiry, connection loss, route removal or a healthy
replacement is not a stopped confirmation. Confirm the exact old platform process
incarnation terminated or was effectively fenced. If that cannot be established,
leave the affected shard unavailable.

Call `require('./publish').publish(options)` with:

| Option | Contract |
|---|---|
| `file` | Absolute backend placement file, in an operator-owned directory. |
| `candidate` | Complete next JSON map, including transition. |
| `internal` | Existing resolved listener configuration used to validate fixed instance addresses. |
| `client` | Dedicated direct PostgreSQL client, kept open through the complete operation. |
| `controlNamespace` | Existing tenant operation-window namespace. |
| `registry` | Admitted `tenant-registry/postgres.create` page/revision reader. |
| `maxTenants` | Explicit deployment bound, default10,000/max100,000. |
| `confirmStopped({worker,incarnation})` | Async trusted platform verifier returning exactly true only for confirmed termination/effective fencing of that exact old boot. |
| `stopOwners({worker,incarnation})` | Optional async actual platform drain/stop callback. Required for planned moves whose old process is still alive. It runs inside the exclusive publication fence. |
| `afterAssignment(result)` | Optional async callback after backend rename, before fence COMMIT: start declared boots, wait for actual eligible target readiness, then atomically publish matching route bytes. |
| `maxBytes` | Explicit map/transport byte bound, default1MiB. |
| `source` | Optional configuration-reader environment, default process environment. |

The helper takes the exclusive global publication lock, admits the existing
control schema, validates the actual old map, pages a complete stable registry
revision, and checks affected operation windows active under exact tenant bindings.
It then invokes planned stops inside that fence, verifies termination again, and
fsyncs/atomically renames the new map. It runs `afterAssignment(result)` while the same exclusive fence still holds,
then returns `{generation,digest,affectedTenants}` after COMMIT. The callback
should read and copy the authoritative backend bytes rather than regenerate IDs. It writes no clinical row or per-write index.

Sharded maintenance `cohort.pin` holds the corresponding shared session lock on
its actual dedicated maintenance client until `releasePin`. Thus a pinned restore
prevents planned stopping as well as publication; a planned move prevents a new
pin. The global fence covers canonical cohort maintenance, not every activity or
deletion writer. Fresh target admission must still refuse a concurrent pause,
suspension or deletion. Already in-flight work retains its bounded uncertainty.

Already-confirmed crashed-owner recovery needs no `stopOwners` callback. A raw
restart command is not a controlled sharded replacement. The deployment adapter
must match each worker/incarnation to an actual platform process, preserve the
stop evidence, and wait for target readiness before consumer route admission.

A failure after file rename is uncertain publication. Inspect the authoritative
file and recover through a fresh confirmed generation. Never restore an old map,
republish a stopped incarnation or reset checkpoints to make rollback look valid.
Process termination stops new old-owner work; it does not recall bytes already
transmitted or turn a reconnect into alarm replay.

## Database and cohort binding

The publication identity requires only schema USAGE plus SELECT on control
`schema_migrations`, `tenant_lifecycle_windows`, `tenant_lifecycle_operations` and
the reviewed registry enumerator grants. It has no clinical/counter write rights
and no privileged tenant-data read exception. Keep the platform verifier outside
the clinical roles. Use existing exact schema/function owner and RLS preparation;
never broaden PUBLIC execution for the lifetime identity.

Every fixed realtime participant row adds `worker:<id>` and its actual instance
address. Include every real worker, including idle and draining actors. The
operation configuration and remote `createRemote({...,placement})` use the same
map. Private lifecycle service version2 preserves unsharded payloadversion1 and
adds sharded payloadversion2 with exact placement generation/digest/worker/boot/
shards. Static UUID cohorts and exactly one validated `registry:<namespace>` label
are distinct; mixed/guessed tenant lists refuse. Actual datastore/PID/role/birth
census remains required. Placement self-report alone cannot prove completeness.

Alarm service version2 adds the exact placement generation/shard/worker/incarnation
request field in sharded mode. The logical notification route ID, request and
attempt identity remain stable across endpoint movement. A transport failure is
uncertain; do not transparently retry or synthesize device receipts. Upgrade
private peers together; there is no v1 fallback that strips ownership information.

During staged publication an unchanged logical shard accepts an older, positive,
nonfuture alarm route generation only when worker, incarnation and shard still
match the current authoritative assignment. This keeps unrelated tenants available
while a moved target warms. A moved old incarnation or future generation refuses.
The target must hold its actual owner resource, remain active, and be fully warm
before handoff effects. There is no fallback to a different worker.

Target projection acquisition stays private until current activity, settings,
registry membership and ownership are rechecked. Slow or failed preparation does
not join the healthy tenant scheduler. Paused and suspended targets remain deferred
without checkpoint advancement; an empty or all-deferred worker can be healthy.
The deployment readiness callback must use authoritative activity to distinguish
an intentionally deferred tenant from a missing eligible target.
