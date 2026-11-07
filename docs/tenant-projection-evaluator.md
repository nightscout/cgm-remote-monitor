# Dormant recovered-projection clinical computation

`lib/data/tenant-projection-evaluator.js` composes the explicit durable
current-row replay component with the shipping computed-view loader/plugin pass.
No server imports it by default. It opens no listener, timer or provider and does
not enable a runtime role.

## Trusted composition

Construction supplies one UUID tenant, its replay handle and restricted tenant-bound
PostgreSQL connection, an existing safe tenant environment, language, a tenant-local
statistics function, and explicit total projection row/byte bounds. These are trusted
constructor inputs, never HTTP selectors. An evaluation:

1. Refuses a conflicting current tenant scope or overlapping local cycle.
2. Awaits `replay.catchUp()`, which resolves after its projection/checkpoint COMMIT.
3. Validates the complete recovered projection against the constructor bounds and
   six admitted clinical domains.
4. Runs the existing v1 storage adapters, current PostgreSQL filter/sort compiler,
   computed-view bounds and shipping data loader over an immutable encoded projection.
5. Executes the accepted `views.evaluateCycle` single plugin pass, returning its
   properties and privately computed alarm requests. It retains this instance's
   last successful result; downstream read/computation failure leaves that result.

The private acquisition helper was already present on the parent. The only joined
independent-profile hunk is the exact `evaluateCycle` definition/export from
`2ee8b493d76ddf92bf53d5e5c9cf0d9d0d2dbb35`. No old profile tree, subscriber,
bootevent stage, server launcher or notification handoff is copied over current fixes.

`lib/storage/postgres-projection-read.js` substitutes only the native reader's one
validated `FROM` source with a parameterized JSONB recordset. It synthesizes `_id`
from the encoded document while retaining `id_kind`; existing query/filter/order
and legacy translation code is unchanged. The facade exposes read methods only,
rejects unexpected SQL and natural insertion ordering, enforces its fixed tenant
before every query, rejects duplicate typed identities and freezes its input JSON
before asynchronous work. No temporary/clinical table or DDL/write authority is
used. Both a read/byte bound and a database statement timeout need to be supplied
by the owning runtime; no capacity is inferred from this reference.

## Recovery meaning

The durable checkpoint belongs to the **current-row projection**, not a completed
clinical evaluation or delivered notification. If computation fails after checkpoint
commit, the next cycle reads the persisted projection and computes again even when
no new write occurred. A newly constructed evaluator likewise reconstructs the
working data rather than resuming an advanced cursor into an empty cache. Explicit
later-instant calls recompute time-dependent properties at the same checkpoint.
This module supplies no wake/poll cadence or catch-up/subscription protocol.

The plugin instance and retained result belong to one constructor-bound tenant.
Conflicting-scope reads of the retained result refuse. Closing an instance prevents
late publication after outstanding reads, but does not claim cancellation of those
queries. Existing view/caller policies remain: selected query bounds, future records,
statistics inputs, typed unions and read errors. A pure current-row projection is
not a retained transition history or a versioned settings/profile snapshot contract.

The private view notification service computes request/emission values, as the
existing views helper does. They are returned for research comparison, **not handed
off to a provider or durable notification service**. No every-transition, ack/snooze,
external exactly-once, clinical notification recovery or complete M5 acceptance is
claimed. Transport/provider, leasing, settings invalidation, scheduling and operational
acceptance remain separate.

## Checks

Pure source/interface checks and one scratch tenant-guard ablation:

```bash
NODE_ENV=test TZ=UTC node node_modules/mocha/bin/mocha.js --exit \
  tests/tenant-projection-evaluator.test.js
node scripts/test-tenant-projection-controls.js <fresh-private-output>
```

Actual SQL and clinical recovery are opt-in and remain unmeasured until executed:

```bash
node scripts/test-multitenant.js --only tenant-projection-evaluator \
  --record <fresh-private-output>/run.json
```

The prepared PostgreSQL cases compare recovered clinical properties with independent
physical-table materialization under the same pinned clock/statistics, restart the
consumer, cover typed twins and known newest glucose, advanced empty bootstrap,
A/B retained state, read-failure retention/retry, explicit quiet reevaluation and
producer SIGKILL after commit before publication. Synthetic histories only.

Required native semantic controls before accepting recovery: removing identity kind
from replay map key must lose the newest typed-twin clinical reading; skipping full
bootstrap at an advanced empty projection must lose the independently stored current
reading. Fresh unmutated archives must restore positives. The source-only tenant-guard
control does not establish those database/clinical properties.
