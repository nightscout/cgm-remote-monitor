# Dormant durable current-state replay

This is the first producer/consumer slice under adopted B7. It opens no listener,
enables no role and sends no notification. Process events are wake-ups, never a
durability source. Single/Mongo behavior is unchanged. No provider, lease,
retention horizon, freshness target or performance capacity is selected here.

`lib/storage/postgres-durable-replay.js` accepts an operator-composed connection,
explicit checkpoint/clock tables and domain tables, a trusted consumer identity,
projection version, page size and total row bound. These are constructor inputs,
never request parameters. Call `catchUp()` inside the UUID tenant scope; it returns
only after its transaction acknowledges COMMIT. Callers own scheduling and current
authorization; this component grants neither socket delivery nor clinical access.

## Explicit transaction and recovery contract

The existing PostgreSQL connection keeps its default transaction behavior. Its
new `snapshotTransaction(fn)` capability declares REPEATABLE READ explicitly and
refuses to nest or silently upgrade an outer transaction. This consumer requires
that capability: independently pooled reads do not imply a shared snapshot.
Snapshot failure, including concurrent-checkpoint serialization errors, propagates;
no stale success or implicit retry is returned.

One `(tenant, consumer)` row is locked, then its checkpoint, projection and clock
floor are read within that snapshot. Domain rows are paged by stamp, domain and
typed identity, using explicit C collation for keyset continuation. A complete
equal-stamp cohort is assembled before application. The snapshot's entire change
set and encoded projection are committed with the checkpoint in one transaction.
Exceeding the caller's total row bound refuses the entire cycle without partial
checkpoint progress. These are correctness bounds, not measured capacity limits.

The encoded projection is a reference engineering choice that makes restart
explicit. A compatible recovered projection resumes from its checkpoint; a missing
or version-incompatible projection performs a full bootstrap in the same snapshot,
including rows below an already-advanced checkpoint. A structurally corrupt
compatible projection refuses. The projection version digest includes the table
mapping and caller-supplied projection version; changed consumer transformations
must supply a new version. The component never pairs an advanced cursor with an
uninitialized empty cache.

Soft deletes remove the addressed typed record from the projection. Duplicate
wake-ups return the same recovered projection with `changed: false`. Overwrites
before replay converge to the latest visible state; an update during a paged scan
is isolated by the declared snapshot and appears on a later cycle. This is not
recovery of every intermediate transition, notification exactly-once delivery or
cross-process evaluator acceptance. Hard deletes, raw writers, notification
handoff/outboxes and retained transition history remain outside this slice.

## Operator candidate and bookkeeping authority

`migrations/candidates/postgres-consumer-checkpoint-v1.json` is a new explicit
candidate catalogue. It changes no prior migration bytes, runs no boot-time DDL,
forces tenant RLS and revokes PUBLIC access. An operator provisions the checkpoint
row and expected digest; a missing row refuses. The projection starts SQL NULL to
require bootstrap. Clock floors and imported stamping must be independently safe;
missing/invalid/future source stamps or a rewound floor refuse.

The reference reader has SELECT on its admitted clinical tables and tenant clock,
plus SELECT and UPDATE only on checkpoint/projection/digest columns of the
bookkeeping table. It has no clinical INSERT/UPDATE/DELETE, clock mutation,
checkpoint creation, DDL or table ownership. This is an explicitly injected
bookkeeping capability and does not change D23's data-reader classification for
realtime. No role launcher is wired here. Tenant RLS restricts rows; consumer
identity and domain mapping are trusted workload construction, not a per-socket
selector or a new workload authenticator.

## Verification commands and status

Source-only tests and authored scratch mutations:

```bash
NODE_ENV=test TZ=UTC node node_modules/mocha/bin/mocha.js --exit --timeout 10000 \
  tests/tenant-durable-replay.test.js tests/postgres-connection-failure.test.js
node scripts/test-durable-replay-controls.js /tmp/ns-replay-source-controls
```

After the coordinator grants a database slot, run the focused disposable-PostgreSQL
suite with the corpus runner (only one shared PostgreSQL; no Mongo/Vault):

```bash
node scripts/test-multitenant.js --only tenant-durable-replay --record /tmp/ns-replay-run.json
```

The seven database cases cover real producer SIGKILL after COMMIT before intent
publication, recovered projection and duplicate wake-up, advanced-cursor bootstrap,
typed equal-stamp pages and soft deletes, concurrent overwrite during a scan,
checkpoint RLS and clinical-write refusal, consumer rollback, incompatible version
rebuild and bounded refusal. The writer process receives disposable credentials
only through its private environment. The fixture records its unique schemas and
roles, and drops only those resources; the corpus owns its container and volumes.

Source-only checks cannot establish SQL syntax, PostgreSQL snapshot/RLS behavior,
process recovery or privilege isolation. All real-PG cases remain UNMEASURED until
that command executes on the actual candidate. Later Runtime Batch B runs full,
browser, enabled corpus and final prcheck once on the assembled frozen head.
No milestone promotion or application-ready claim follows from this leaf.
