# Data contracts after the modernization cuts

This work targets the recurring defects identified in [Ben West's architecture
review](https://bewest.github.io/rag-nightscout-ecosystem-alignment/docs/30-design/modernization/cgm-remote-monitor-architecture-review-2026-10-25.html).
We broadly agree with its diagnosis: fixing each transport independently leaves
other writers, old stored records and consumers exposed to the same class of bug.

The review is a discussion document, not an instruction to switch every proposed
policy on. This is a single-tenant MongoDB implementation; it introduces no tenancy
framework, database migration, stricter default or new public socket broadcast.

## Implemented boundaries

| Pattern | Implementation and evidence |
| --- | --- |
| P1: divergent writers | `lib/storage/write-step.js` receives persistence operations from all six v1/internal storage modules, the legacy socket, and API v3. It validates selectors, executes the driver call, preserves driver results/errors, and observes committed changes. The existing matching/coercion/reply policies remain in their adapters. The CRUD matrix pins these differences; the boundary gate and its bypass controls cover all eight adapter entry points. |
| P2: stored shapes | `read-contract.js` provides non-mutating inspection and safe scalar conversions. API v3 exposes aggregate rule counts in `Nightscout-Data-Warnings`, leaving record values in the body. Cache conversion, insertion and repeated merges tolerate object-valued dates/durations and malformed IDs without inventing replacement IDs. Unaddressable authorization subjects fail closed while remaining in the database. `diagnose:data` produces a bounded read-only aggregate report. |
| P3: validation | The existing pure Temporary Target rules now cover socket add/update/unset as well as v1, v3 and internal treatment storage. Socket add batches are checked before the first write. All adapters share effective-duration validation, including cancellation/end-time conflicts. In reject mode, partial target updates use conditional writes and revalidate changed snapshots; socket updates persist the validated duration fields. The default remains `WRITE_VALIDATION=off`. Log mode preserves data; reject mode uses the existing rules and canonical unit spellings. Logs contain rule/field names, not identifiers or readings. |
| P4: synchronization | Startup flags implausibly future server clocks without silently rewinding issued cursors. History headers are derived only from valid numeric server times; malformed returned data cannot manufacture a `NaN` cursor. Projected history loads `srvModified` for cursor headers while omitting it from the body unless requested. Existing history/restart tests remain gates. Public delivery behavior stays unchanged. |
| P5: units/identity | Preserve the existing unit and ID compatibility helpers. Exercise ObjectId, lower/upper hex and UUID shapes and all 32 ordered resend pairs among v1, v3, socket and internal entry/treatment writers. Do not invent a new conversion constant, globally relabel units, collapse same-time device statuses or require identifiers. |
| P6: blind CI | Every tiered Mocha command and legacy npm Mocha command uses `--fail-zero` and an execution reporter requiring a completed test body in each selected test file. Serial/parallel controls cover empty, all-pending and support-only runs. The production-safety/cleanup files do not count as intended coverage; the POSIX development-watch probe has an explicit Windows exception. Existing seeded file-order CI remains. Matrix writes must emit the internal commit observation, and AST controls fail when any known adapter bypasses the boundary. |

## Compatibility measurements

Baseline: dev `47723cda10cc0504d548f4a90d07a60540cca4a4` (merged cut 5).
`tests/api.crud-by-id.matrix.test.js` has 336 existing cells, with explicit
expected replies and stored ID forms. Its `CRUD_MATRIX_OUT` report can be compared
before/after; the new checks add internal callers, all four validation paths,
socket updates and malformed reads. This is **not** a rerun of the separate
alignment repository's 336-cell write-contract harness: its historical 33/66 and
38/66 divergence figures must not be quoted as current measurements.

The 32 resend cases also pass against unchanged dev. Treatments retain one record
for every pair. Entries still expose existing policy differences: a v3-to-legacy
resend can duplicate a record, and a socket-to-v1/internal resend can collide on
`_id` because those adapters match on `sysTime + type`. These are pinned baseline
behaviors, not newly introduced identity guarantees or silently fixed policies.

The persistence result is `{result, event}`. Ordinary writes return the driver's
original result, so adapters keep positional IDs, counts and errors. Conditional
updates aggregate matched/modified counts across per-document driver writes. `event` is a frozen,
data-free `storage-write-committed` observation (collection, source, operation,
committed counts and partial flag). One event is produced per changed **boundary
operation** (including a conditional batch), including the committed portion of a failed bulk operation. No event
is produced for an unchanged, wholly failed or unacknowledged operation.

This event is not a per-request transaction or an all-path `/storage` event.
Existing cache updates, `data-received` notifications and v3-only
`storage-socket-*` notifications retain their timing and payloads. A subscriber
failure must not turn an already committed write into a client retry.

`v1/internal` is an honest source label: HTTP and trusted in-process callers use
the same storage functions today. It is not an authorization decision. Permission
checks still run in their existing transport layers.

## Read and diagnostic contract

- Retain stored data. Do not repair, delete, coerce clinical values or advance
  `srvModified` while diagnosing.
- Treat malformed database values as data, not JavaScript coercion methods.
- Diagnose the fields actually returned; absent fields in a projection are not
  proof of an invalid full record. Full reads run complete target checks; projected
  reads omit cross-field checks unless all validation dependencies are present. The response header is aggregate and contains
  no identifiers or values. A record may already be excluded by an existing
  permission, soft-delete or query filter; diagnostics do not bypass these.
- Authorization is the necessary exception to permissive runtime loading: an
  unusable identity cannot authenticate. The raw record remains available to an
  administrator for diagnosis. This does not grant a replacement/default role.
- The one-day future-clock threshold is a warning, not a clinical or write limit.
  A large batch or wall-clock rollback can legitimately advance a monotonic clock.
  Never clamp it beneath an issued cursor without a client resynchronization plan.
- Existing valid numeric history cursors are preserved. Malformed server times
  remain visible when selected, but cannot supply the history ETag. A page with no
  usable server time has no usable cursor; operator diagnosis/repair is needed.

Run a bounded, read-only report against an explicitly selected database:

```
# Supply MONGODB_URI securely through the environment; do not paste it into an issue.
npm run diagnose:data -- --limit 10000
```

The limit is per collection (maximum 1,000,000). `truncated: true` means this is a
sample, not a clean bill of health for the database. Existing collection-name
environment overrides are honored. Use a read-only database account. Output
contains counts and rule names, not patient records. The report currently covers
entries, treatments, device status, profile, food and settings; it is not a full
schema validator or a clinical validity assessment.

## Remaining architecture decisions and follow-up work

These are explicit remaining items, not claims that this PR has solved them:

1. **Full write intent and event fan-out.** Move matching, server-date allocation,
   stale-ID cleanup, request-level outcomes and cache/notification orchestration
   behind the persistence boundary in measured slices. Today's wrapper is a
   common persistence/check boundary, not the complete proposed `write(intent)`
   service. The current per-path policies and partial-write semantics must remain
   pinned until a separately reviewed behavior change. No transaction or race-free
   cross-path deduplication guarantee is introduced here.
2. **Transaction and deduplication scope.** In reject mode, domain-changing
   treatment `$set`/`$unset` updates are conditional on the exact stored fields
   used by validation. A changed snapshot is reread and revalidated, with up to
   three retries; an invalid resulting target is refused (v3 HTTP 400), persistent
   contention returns 409, and a concurrent deletion is not recreated. Unrelated
   edits need not conflict. Current adapters never upsert partial treatments;
   the conditional boundary explicitly refuses upsert/unacknowledged options.
   Batch preflight checks all existing matches, but concurrent batch failures can
   still leave earlier documents committed (reported in the internal event).
   This is per-document protection, not a transaction across twins, a new generic
   update-operator API, or race-free cross-path deduplication.
3. **Read inventory.** These tests protect the touched API, cache, history boot and
   authorization boundaries. They do not prove that every plugin tolerates every
   historical BSON shape. Extend the corpus and read-entry-point coverage; the
   contract is a target, not a universal guarantee.
4. **Delivery/cursors (Q-D).** Agree client cursor advancement rules, replay/filter
   behavior and recovery before expanding `/storage`. Keep history as the durable
   source. Opaque cursors, low watermarks, multi-process clock allocation and an
   operator-approved future-clock repair remain separate work.
5. **Units/identity (Q-E).** Agree unit spellings/constants and `_id` versus
   `identifier` precedence with client authors. Mandatory identifiers and new
   natural-key deduplication require an explicit version boundary.
6. **Validation policy (Q-B).** Controller-specific ranges stay in controllers.
   Default reject mode, further domain rules and client-visible refusal handling
   require agreement. No client outreach is sent by this PR.
7. **Stronger CI gates (Q-F).** Empty/all-pending intended files now fail even
   alongside passing support files. Per-file execution cannot prove every branch
   was covered or every assertion meaningful. The complete external G1–G8
   conformance harness and broader behavioral coverage remain separate work.

Keep this implementation as a dedicated architecture PR. Do not fold behavior
changes into an already reviewed dependency cut or imply that every open question
has been resolved by green CI.
