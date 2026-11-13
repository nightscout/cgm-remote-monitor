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

The prepared assignment has a UUID in `REALTIME_WORKER_INCARNATION`, with its
declared `REALTIME_WORKER_ID`. A same-worker recovery restart retains this
assignment token and map generation; its actual process/cohort incarnation,
admission ticket/nonce and platform CID/start binding must be fresh. A map token
is not process liveness or a retirement proof. Controlled changes still exclude
every current process bound to the old assignment. IDs/UUIDs do not prove exclusivity. Runtime
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
map. Private lifecycle service version4 preserves unsharded payloadversion1 and
legacy sharded payloadversion2, while map2 uses payloadversion3 with ownershipVersion2
and exact placement generation/digest/worker/assignment/shards. Legacy payload2
retains its prior exact placement fields. Static UUID cohorts and exactly one validated `registry:<namespace>` label
are distinct; mixed/guessed tenant lists refuse. Actual datastore/PID/role/birth
census remains required. Placement self-report alone cannot prove completeness.

Alarm service version3 carries the exact placement generation/shard/worker/incarnation
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


Placement readers opt into the internal atomic-publication cache. Publish complete
files through the fenced publisher's temporary-file write, fsync, atomic rename and
directory fsync; in-place changes are unsupported for this machine-owned metadata.
The cache compares target device/inode, size, nanosecond mtime/ctime, mode and the
current byte bound. Unchanged publications perform no full-file reads or parses.
One descriptor pins each accepted inode, preventing an ABA cache hit if a reader
misses multiple publications and the filesystem would otherwise reuse its inode.
The bounded reader obtains bytes and identity from that same open regular file.
A changed identity releases the previous handle before reading its replacement;
a refusal, explicit `close()` or owning runtime shutdown releases the handle.
The finalizer protects abandoned objects only; normal lifetime uses explicit close.
Valid reader symlinks follow their regular-file target and its identity. The
publisher itself requires its existing private regular-file path.

This is a constant resource per placement reader, independent of tenant count.
A selected realtime role, evaluator consumer and operation-cohort configuration
may each own a reader (up to three for their co-resident process). Direct callers
of `load`/`loadRoutes` must close their reader; these methods do not install process
signal handlers or one listener per tenant. Atomic publication does not replace
current registry, activity, settings or ownership checks.

## Bounded recovery source interface (prospective)

`publishRecovery({...publishOptions, consumer})` additionally requires the actual
old owner advisory transaction lock on the SAME publication client, after exact
platform exclusion and before map rename. It holds that lock through target warm,
route publication and COMMIT. The stable consumer and shared owner-key derivation
are mandatory; health, a census, timeout or lease age cannot substitute. A held
lock refuses before publication. With the current v1 worker-key contract a
recovery candidate retaining a stopped worker ID refuses before any transaction
or publication effect: warming that replacement while holding its same key is
unsupported. This refusal does not implement gradual rebalance. Ordinary `publish` retains its controlled-move
contract. This primitive does not schedule recovery, debit a ticket, refund crash
credits, or authorize an arbitrary live-owner takeover. Deployment's finite shared
control allocator, restart/grace/roster controller and native proof remain separate
integration requirements.

Selected sharded realtime also owns the named `realtime-inspection` v1 operation
`POST /realtime/inspect` on its existing private listener. It returns bounded cached
assignment/shard metadata, a fresh process observation identity and local
owner/quiescing state; no tenant roster is scanned and no PG/file read is made by
the observer. The result explicitly says `cached-not-lock-proof`; it is not a
readiness certificate, current owner lock proof or credit retirement. UDS filesystem
trust and explicit HTTP network trust remain unchanged. Service/version headers
route and validate the contract; they do not authenticate HTTP peers. Unselected
realtime adds no observation route.

## Assignment-scoped ownership contract 2

A fresh profile explicitly sets `NS_REALTIME_OWNERSHIP_CONTRACT=assignment-v2`
on every placement reader/publisher role. It requires map `version: 2`; an absent
selector retains legacy map1/key1, while empty/unknown selectors refuse. A reader
never changes ownership contract on a later generation. Backend and route maps
use the same format. No in-place map1->map2 conversion is implemented: a mixed
publication/profile refuses, never creating a new credit ledger or resetting an
UNKNOWN generation. Fresh preparation and shared allocator binding belong to the
deployment integration; this core change creates no plan or credit authority.

Contract2 derives the actual owner key from consumer + worker + assignment UUID
in a distinct v2 key domain. Same-assignment crash restart retains that key and
map generation, but needs fresh process/admission identities and declared finite
capacity; a live old backend still blocks it. A genuinely new assignment can
warm while the publisher holds the OLD assignment's actual key. Exact old process
exclusion is still mandatory. All map2 publications must use `publishRecovery`,
which requires explicit `recoveryLimits` (`maxLogicalMoves`, `maxAssignmentChanges`,
`maxAffectedTenants`). Omitted limits, omitted actual warm/route callback, or the legacy publisher refuse before effects.
The old-assignment lock is held on the same publication client through warm/routes
and COMMIT. Old live locks and unknown platform proof refuse.

Results distinguish logical worker-to-worker shard moves from all changed
assignment shards and affected tenants, including `retainedWarmTenantUpperBound`. These tenant counts conservatively include
all affected registry tenants (also deferred ones), not completed initialization;
`warmWorkBasis` states that upper-bound basis. Actual eligibility/readiness remains
the fixed deployment callback obligation. Moving a
few logical shards still stops/restarts the old worker and warms its retained
shards under a new assignment. A small logical batch does not imply a small warm
cost or uninterrupted retained-shard sessions. Both bounds are enforced before
platform stop/publication. An unavailable intermediate assignment is not a
successful move. Existing stable consumers/checkpoints and alarm request/attempt
identity remain unchanged; no durable viewer replay is added.

Coordinated private versions: lifecycle participant4 (sharded payload3 adds
`ownershipVersion: 2`), alarm delivery3 (exact mode in sharded tuple), realtime
inspection2 (cached mode). Legacy payloads remain only under legacy profile/key1,
not as fallback for assignment-v2. Per-role source/config/ticket binding and full
native process/PG/clinical qualification remain prospective integration gates.

### Fixed admitted recovery activity reader

The fixed selected recovery entry uses `publishRecoveryActivity(options)`.
`publishRecovery` remains the earlier publication primitive; it does not supply
activity and is not a substitute for the selected single-client entry.
The new entry is assignment-v2 only and refuses ambient tenant/window authority.
Its `afterAssignment(result, {readActivity})` receives only the bounded affected
registry tenant reader. It uses the SAME admitted publication backend and READ
ONLY transaction; no pool, nested transaction or caller-selected SQL is exposed.
The ordinary activity factory and this reader share the existing exact reader
RLS/grant/owner screen. Ordinary factory queries and transaction ownership stay
unchanged.

The assertion-only `connectionAdmission.assertRecoveryTransaction(client)` reads
private actual-driver records: exact plan2 realtime-recovery singleton capability,
completed same-backend DB verification, healthy/unfrozen transport, no pending
query/auth/end and CURRENT actual ReadyForQuery T. A private protocol-ready bit
is cleared on statement submission/ErrorResponse, and must agree with the actual
driver ready phase. Empty queues after ErrorResponse do not prove the later
Ready packet arrived. Started plan2 Terminate requires this same current-ready
proof for I/T/E; a premature end remains uncertain even after supplied peer EOF.
Never-connected closure and legacy plan1 behavior stay unchanged. It changes no snapshot/ACK wire or
constructor authority. The fixed reader separately verifies actual role/OID,
database/OID, PID/birth, postmaster epoch, READ ONLY and NOSUPERUSER/NOBYPASSRLS.
The host binds system identifier; SQL does not claim to observe it or gain a new
pg_control_system privilege. Server/client statement budgets are fixed at one
second for these reader queries. Native endpoint/epoch/RLS proof remains required.

Each sequential read enters canonical tenant ALS, sets the transaction-local GUC,
uses the fixed tenant predicate and restores the metadata GUC. Active, paused and
suspended remain distinct: target readiness must require warm active tenants and
skip only the paused/suspended tenant's warm requirement. Missing/unknown activity
refuses. Registry revision must still be checked each readiness pass.

Concurrent, foreign, late or unawaited reads poison the scope. Before COMMIT the
publisher closes it and drains its tracked query/GUC work; it never queues
ROLLBACK behind an unknown active query. Callback primary and cleanup errors are
retained. A late read during an already-dispatched COMMIT cannot undo that COMMIT:
it emits no new query and the publication result refuses rather than reporting
success. The fixed class entry must retain uncertainty unless actual physical
outcome is proved; no retry/refund follows from an error property or cached health.
