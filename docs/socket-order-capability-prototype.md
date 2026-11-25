# Optional socket insertion-order capability experiment

This isolated prototype evaluates the existing `naturalOrder: true` contract for
socket treatments and device status. It is not adopted ordering policy, transparent
schema compatibility, a production role, or complete socket/client acceptance.
Current production catalogue selection, default port options and Mongo paths stay
unchanged. The accepted source and the failed joined-source capture stay separate.

## Concrete option prepared

Two optional successor catalogues copy the complete old `0001` migration and its
checksum unchanged, then append one `0002_*_socket_order` migration. The new step:

1. Adds a temporary `CHECK(false) NOT VALID` constraint.
2. Validates it, requiring the table to be empty.
3. Drops that temporary guard, adds generated-always identity `insertion_ordinal`,
   and indexes tenant plus ordinal.

The existing migration runner wraps each migration and ledger insertion in one
transaction and holds its namespace advisory lock. ALTER TABLE's lock protects the
empty check through column creation. A populated table must fail constraint
validation; the transaction must leave its rows, columns, constraints and old ledger
unchanged. Actual PostgreSQL behavior remains unmeasured until the prepared run.
No old applied migration/checksum or migration inspector is edited.

`tenant-socket-order-port.js` is an optional trusted constructor. It checks the
explicit successor catalogue through a separately supplied direct readiness
connection before returning a socket-source port with `naturalOrder: true`. It
never migrates and has no production caller. The generated sequence requires the
explicit serving privilege used by the fixture. Namespace/domain/catalogue are
trusted composition, never a socket argument. A stale ledger refuses before a
caller can bind the selected listener. Existing unselected ports still refuse a
nonunique bounded read without sort.

This uses PostgreSQL fresh insertion order, not an `_id` or date substitute. The
canonical socket exact query can match multiple rows: treatment NSCLIENT_ID or
fallback time/event/client identity; device status NSCLIENT_ID or created_at.
Mongo may choose index-dependent unsorted order. The experiment uses its actual
same-head unindexed reference and reverse-lexical IDs, checks exact selected IDs,
callbacks and both stored documents, and makes no all-index-order claim.

## Required startup/upgrade matrix

These are predictions, not measured database results:

| Schema/ledger | Old catalogue check | Optional successor check | Selected prototype |
|---|---|---|---|
| Old empty domain | passes | `MIG_STALE` | refuses before bind |
| Old populated domain | passes | stale; upgrade fails empty guard | refuses; existing rows unchanged |
| Successor created/upgraded while empty | `MIG_UNKNOWN` | passes | fresh-order reads enabled explicitly |

The existing inspector refuses applied names absent from the reviewed catalogue.
Consequently an old binary checking its old catalogue **cannot share the upgraded
schema**, even though old explicitly sorted reads can still use its rows. Rolling
back application code alone is not a supported rollback. The current migration
runner has no down action. Operators must preserve an independently restorable
pre-upgrade state or use a separately reviewed namespace/cutover plan; no automated
rollback, ledger deletion or manual migration-history repair is proposed here.

An imported/populated domain has no established source ordinal provenance and is
not eligible for this upgrade. A newly generated ordinal does not prove past
Mongo order. The prototype provides no importer preserving source ordinals and no
attestation for later operator/raw imports. Imported-order equivalence and populated
client support are outside admission. Selecting these catalogues for a shared
existing preview would therefore be a breaking startup change and requires a
separate decision informed by the actual matrix.

A second option, not implemented, would track an independent capability ledger to
preserve old catalogue checks. That requires a new cross-namespace migration and
provenance contract. The current experiment does not introduce that architecture.

## Prepared experiment and markers

```bash
node scripts/test-multitenant.js --only tenant-socket-order-capability \
  --only tenant-socket-data-forwarding --record <private-output>/run.json
```

The first suite prepares three actual-PG cases covering both domains: startup
matrix, atomic populated refusal, and fresh generated order retained through edits
with default refusal/explicit-sort behavior unchanged. The second retains four
actual socket cases and explicitly selects successor preparation. The pinned
AAPS pattern is synthetic replay, not an Android binary run.

Its first case covers fresh/retried insertion, then two matching stored records
with the first inserted ID sorting lexically last. Actual Mongo acknowledgements
must select that first identity twice; PostgreSQL must return the same callback
and leave both independently stored identities unchanged. This characterizes only
the stated fixture, not every Mongo planner/index configuration.

The held-COMMIT fixture now observes its actual row inside the owned transaction
before signaling the hold; pre-write errors reject the barrier rather than time
out into a misleading state. The post-write abort fixture asserts the actual row
inside that transaction and requires a reached marker before accepting independent
rollback/clock/event assertions. The original rollback green from the failed
joined run remains vacuous and is not overwritten by this preparation.

Prediction: seven functional positives, zero pending/failing, one shared disposable
PG16 and Mongo fixture, no Vault/provider or production enablement. Runtime requires
an explicit coordinator grant and exact-head/resource preflight. Preserve first
unexpected result and stop before repair or retry. The old-binary `MIG_UNKNOWN`
and populated refusal are required expected results, not gaps to bypass. Native
controls, comprehensive tests and later admission remain separate.
