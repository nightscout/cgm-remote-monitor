# M5 current-state recovery uncertainty probe

Source preparation, based on application `7015fbae42e5c3e2f26acf79488e5a7328ff3b29`.
Native results are **UNMEASURED**. This probe characterizes dormant reference
primitives; it changes no product behavior and adds no M1–M4 criterion.

The adopted B7 durable-delivery contract keeps hard deletes outside the stamped
row spine and defers tombstones. D23 assigns writes to API, including forwarded
realtime writes. Neither decision establishes absent-row reconciliation or every
intermediate transition recovery. Those decisions live in the alignment workspace,
in `docs/30-design/tenancy/durable-event-delivery-contract-2026-11-06.md` and
`docs/30-design/tenancy/multitenancy-decisions.md`.

## Executable characterization

`tests/tenant-current-state-recovery-proof.integration.test.js` extends the actual
PostgreSQL replay/evaluator fixtures through
`tests/fixtures/m5-current-state-proof.js`. Each canonical write uses its real
clocked collection port, not raw fixture insertion. Socket create is one document
per write, as in the real socket caller. Legacy entries use the existing natural
insertion-order policy; activity does not acquire that policy.

| Case | Read-derived prediction and independent observations |
|---|---|
| Hard delete | Two distinct typed entry identities produce newest clinical value 222. Canonical socket delete physically removes that ObjectId; transaction is committed, floor unchanged and intent stamp null. Restricted replay and new evaluator handles retain the absent typed key/value 222, while independently materialized current tables yield survivor value 111. A new handle and a later unrelated stamped legacy write do not repair absence. Foreign tenant stored values, floor and checkpoint remain unchanged. |
| Diagnostic bootstrap and soft-delete positive | In scratch only, set the persisted projection to SQL NULL while retaining the advanced checkpoint, source rows and digest. Full bootstrap is predicted to restore typed identity and clinical parity. Canonical v3 soft-delete then retains an invalid stamped row and removes its key from the recovered projection. |
| Legacy and socket activity | Actual create and update physically store the intended activity values but allocate no dates. Capture committed transaction, null event stamp, unchanged floor, absent srvModified and reader refusal `REPLAY_UNSTAMPED_OR_UNFENCED_ROW`, with unchanged checkpoint and foreign tenant. Both canonical sources are separate cases. |

`M5_CURRENT_STATE_OBSERVATION` records independent SQL tables/floor/checkpoint,
canonical event metadata, real transaction identity/status and clinical results
before strict verdicts. Nonfinite numbers and undefined values are tagged in raw
JSON, while assertions retain the original values. Clinical comparison uses the
actual physical-table view materializer; it never constructs expected clinical
properties from recovered projection contents. Typed identity checks use independent
physical `id_kind` metadata. The existing R67 clinical-domain properties and their
controls are not re-attributed or repeated here.

## Meaningful diagnostic control and restoration

Only an explicitly selected scratch control
`NS_M5_CURRENT_STATE_DIAGNOSTIC=skip-bootstrap`, together with
`NS_M5_CURRENT_STATE_ARCHIVE_CONTROL=1`, bypasses the diagnostic projection reset.
On a fresh fixture it must reach the independently observed physical absence,
advanced floor/checkpoint and stale recovered key, then fail exactly at
`M5_ABSENCE_DIAGNOSTIC_RESTORED typed physical identities`. A SQL error, TypeError,
timeout, missing physical deletion, missing marker or pending test is invalid.
This is a diagnostic absence-oracle sensitivity control, not a production
reconciliation ablation. A fresh ordinary run restores the scratch reset and
must pass all three characterizations with zero pending.

A passing characterization establishes the predicted limitation on its executed
source. It does **not** establish a shipping defect, a selected reconciliation or
tombstone policy, distributed runtime recovery, retained clinical transitions,
notification delivery, M5 completion or activation. A refuted hypothesis stops
this capability for review; the probe must not substitute a different writer,
soft delete or stamped activity to obtain the expected result.

## Execution boundary

The suite remains opt-in and is registered in the integration tier and
`scripts/test-multitenant.js`. Source/loading checks can run without services;
disabled cases are pending, never green native evidence. Native execution needs
a separately granted disposable PostgreSQL fixture and private capture runner.
The prepared runner must pin the existing image by exact ID, refuse pulling,
archive the exact source, retain raw observations before verdict, and remove only
its recorded labelled container and volumes. Independent before/after baseline
and child PID/start-time observation belong to the private ownership envelope.
No provider, listener, MongoDB, Vault, application build or comprehensive campaign
is needed for this bounded proof.
