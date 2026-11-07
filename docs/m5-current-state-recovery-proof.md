# M5 bounded current-state reconciliation

The dormant reference evaluator consumes `reconcile({maxRows,maxBytes})` from
`lib/storage/postgres-durable-replay.js`. It replaces the full admitted typed
current identity set on every acquisition, independent of floor movement or
recent timestamp windows. Hard-delete and legacy/socket activity writers retain
their existing timestamps, results, commit events and clock behavior. No live
role, scheduler, provider or default is enabled.

This implements the adopted bounded-snapshot direction in the alignment
workspace's release decision `m5-bounded-snapshot-reconciliation` and B7 §11.
The historical native `0bcdec2275c478de0307a0fd90e210d43dc56f01` characterization
and its immutable captures remain the baseline: absent deleted keys stayed
projected, and strict replay refused unstamped activity. The earlier scratch
projection-NULL bypass was diagnostic oracle sensitivity, not a production fix
or the new product's ablation. Current implementation native acceptance remains
**UNMEASURED** until the separately granted frozen-source proof executes.

## Two acquisition contracts

| API | Contract |
|---|---|
| `catchUp()` | Existing strict stamped spine: rejects unstamped/unfenced rows, replays complete equal-stamp cohorts and retains its original digest and checkpoint semantics. |
| `reconcile({maxRows,maxBytes})` | Full current snapshot: accepts absent legacy dates, validates any present dates against the same snapshot floor, excludes retained isValid:false rows and removes physically absent identities by replacement. Requires explicit per-call bounds within the constructor row ceiling. Uses its own digest. |

Both require operator-provisioned consumer/clock rows, tenant binding and the
existing forced-RLS reader. No boot DDL, schema change, clinical write or clock
write is added. A single `snapshotTransaction` uses the existing repeatable-read
transaction: lock owned consumer row, read floor, preflight count/document bytes,
page the entire typed identity set and atomically replace projection/checkpoint.
There is no timestamp predicate. Ordered `(domain,id_kind,identity)` paging keeps
string/ObjectId twins distinct. Bounds count all scanned rows including invalid
rows, and check both persisted and decoded projection envelopes before UPDATE.
Oversize refuses visibly; it never truncates or persists a partial result.

Projection/checkpoint replacement and its floor are one tenant snapshot, returned
only after COMMIT. Acquisition/bound/COMMIT failure keeps the last persisted
projection/checkpoint and last successful clinical result. The checkpoint is an
**input snapshot floor**, not an evaluated-output revision or delivery receipt.
Clinical computation remains after input COMMIT: downstream failure may retain
that successfully committed input projection while retaining the prior clinical
result. The next cycle recomputes even with unchanged floor/projection; no
checkpoint-based suppression prevents retry.

## Executable acceptance preparation

`tests/tenant-current-state-recovery-proof.integration.test.js` uses actual clocked
canonical write ports, restricted actual PG replay/evaluator and independent SQL
and current-table clinical materialization. It captures raw observations before
asserting status. Source/unit protocol tests are not native PostgreSQL evidence.

| Native vector | Required physical oracle |
|---|---|
| Canonical hard delete | Real committed physical typed-key absence, unchanged floor/null event; recovered projection and clinical output equal current tables through new handles/restart and later unrelated floor advance. Foreign tenant unchanged; canonical soft-delete positive retained. |
| Legacy and socket activity | Actual physical create/update, absent srvModified, unchanged floor/null event; full snapshot retains the changed current values, while strict `catchUp()` still refuses the unstamped spine without changing its checkpoint. |
| Row/byte/persistence refusal | Independent oversized physical inputs and before/after checkpoint/projection; explicit row and byte refusal retains last good input/clinical state. Force failure after actual checkpoint UPDATE, observe its external invisibility and rollback, then retry successfully. |
| Snapshot interleaving | Actual four-row canonical cohort; reader pauses after its first nonempty page while a different writer commits all changed values atomically. Persist complete old cohort with old snapshot floor, never mixed pages; next acquisition converges to full new current cohort. Foreign tenant unchanged. |

Existing R67 typed-twin and clinical-domain vectors remain in their original
suite and use the new evaluator acquisition; their historical measurements are
not re-attributed. New product controls are separately archived source changes:
retain absent saved keys after full scan; return saved projection on unchanged
floor (loses actual activity update); bypass row/byte checks (wrongly persists
oversize input). Each must fail at an independent physical-state assertion,
then restore on fresh ordinary source. SQL/setup errors, TypeErrors, timeouts,
missing observations or pending cases cannot qualify as semantic red.

Native execution stays opt-in with `NS_M5_CURRENT_STATE_PROOF_TEST=1`, a separately
granted disposable PG fixture, exact archived source/pinned image and independent
resource/birth observation. No MongoDB, Vault, provider or listener is needed.
Passing supports bounded current-state recovery only: no retained intermediate
transitions, notification delivery, lease/failover, retention/cadence/capacity
budget, production activation, M5 completion or new M1–M4 criterion follows.
