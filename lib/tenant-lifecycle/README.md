# Tenant lifecycle primitives: typed export, import and confirmed deletion

Dormant, opt-in research module for the Batch C early proof (tenant export/import
fidelity and tenant deletion with recoverable key material). Nothing imports it
from a serving role, no CLI command or endpoint exposes it, and it selects no
backup format, retention rule or owner capability. The artifact it writes is a
**research artifact format, not an adopted backup format**.

## What it does

The caller supplies a lower-port connection (`lib/storage/postgres-connection`)
for a private-plane role that is `NOSUPERUSER NOBYPASSRLS`, so every statement
runs under the tenant binding and row-level security bounds reads and deletes.

| Operation | Boundary |
|---|---|
| `exportTenant(connection, { tenant, namespaces, sourceCommit, keyNames })` | One `REPEATABLE READ` snapshot under `withTenant(tenant)`. Reads the non-generated columns of every admitted table, preserving `id_kind` beside the JSONB document (the `postgres-identity` codec's kind travels as a column, so ObjectId/string twins stay distinct). Secret records travel as stored ciphertext plus a key reference parsed from the Transit prefix (`vault:vN:`). No plaintext, no provider key. |
| `importArtifact(connection, artifact, { tenant, namespaces, onRow })` | One transaction. Refuses before any write when the artifact's tenant is not the target, a row's `tenant_id` differs from the manifest tenant, a key reference has no ciphertext, the target namespace's applied migration ledger (`schema_migrations` names and checksums) differs from the manifest, a table's columns differ, a catalogue is missing or unmapped, or the target already holds rows for the tenant. The artifact and live ledgers must both equal the full selected reviewed catalogue. Any identity-bearing plan refuses `LIFECYCLE_IDENTITY_IMPORT_UNSUPPORTED` before INSERT/sequence effects; same-ID tenant restoration is incomplete. |
| `requestDeletion(connection, { tenant, ledgerNamespace, artifact, now })` | Current-authorized explicit intent only; creates a requested ledger/ceremony record, deletes nothing. |
| `confirmDeletion(connection, { tenant, ledgerNamespace, artifact, requestId, now })` | Separately current-authorized operator confirms the exact request/durably verified artifact. No minimum wait. |
| `cancelDeletion(connection, { tenant, ledgerNamespace, requestId, now })` | Current-authorized cancellation under the request row lock; only requested/confirmed can become cancelled. |
| `claimDeletion(...)` / `executeDeletion(...)` | Operator claim commits before destructive work and permanently closes cancellation. Execution separately rechecks current operator authority, durable artifact, explicit quiescent window and complete admitted current data/key fidelity. Destructive rollback retains executing state; same-artifact retry reauthorizes. Upgraded ceremony/audit ledger stays outside per-tenant deletion. |

The complete current contract, trusted capability inputs and source/native acceptance
boundary are in [CEREMONY.md](CEREMONY.md). Raw/default lifecycle objects refuse
execution without a complete admission check. Compose the census-selected instance
through `admission.lifecycle.withCapabilities(...)`; do not bypass the inventory with
an old static list. The append-only ledger migration adds the ceremony table while
leaving migration0001 unchanged. Legacy pending requests are never auto-confirmed.


The admitted catalogue (`CATALOGUE` in `index.js`) lists every tenant-bound table
the reviewed candidates in this tree create, parents before children; the unit test
derives that set from the candidates' `CREATE TABLE` statements and fails when a
new tenant-bound table is not admitted. The lifecycle ledger has its own candidate
(`postgres-candidate.json`) and namespace; its rows are the deletion tombstones and
are not exported.

Error codes are `LIFECYCLE_*` with the offending `kind.table` in `detail`. Tests:
`tests/tenant-lifecycle.test.js` (unit tier, in-memory recording connection that
honours the real tenant scope and rolls back on throw). The populated PostgreSQL
and Vault run lives in the alignment repository's
`tools/lab/tenant-export-delete/` instrument.

## Current contract and remaining acceptance

- Same-ID tenant restoration must retain compatible keys and preserve current
  foreign data. Identity-bearing import is unsupported; whole-deployment rollback
  is not equivalent. See [IDENTITY-IMPORT-REVIEW.md](IDENTITY-IMPORT-REVIEW.md).
- Export and destructive admission require the complete current selected reviewed
  ledger. An artifact and database agreeing on unknown DDL is insufficient. Explicit
  older non-identity catalogue cohorts are supported; no implicit prefix upgrade.
- Entries carries an insertion ordinal; selected treatment/devicestatus/profile
  successors do too. Food does not acquire an identity in the reviewed catalogue.
  Export preserves exact values. Tenant import never regenerates them or attempts
  tenant-local sequence maintenance.
- Current authorization, durable artifact and held execution window are mandatory
  capability inputs; operator confirmation/claim/execute are distinct from owner
  intent/cancellation. Production adapters and native transaction/race evidence
  remain separate acceptance work; source protocol checks are not those outcomes.
- The adopted post-deletion retention/provider-destruction contract remains
  separate. This module implements no automatic expiry or key destruction. The
  same-ID artifact keeps ciphertext/recovery references; clone/cryptographic
  rehoming is unsupported.
- Artifact size/transaction limits and the global allocator-maintenance outage
  budget remain unmeasured. No numeric cap or safe maintenance lease is inferred
  from the source fixture.


Current lifecycle admission requires the **full exact selected catalogue ledger**
for export, artifact import and destructive admission. Unknown, stale, drifted or
reordered rows refuse; artifact/live agreement is not catalogue authority. A known
prefix requires an explicitly selected older inventory rather than current tables.
Identity-bearing tenant import is unsupported and refuses before any INSERT or
sequence effect. Same-ID TENANT restore remains OPEN: whole-deployment rollback can
revert foreign B and global API namespaces cannot transparently split A/B routing.
See `lib/tenant-lifecycle/IDENTITY-IMPORT-REVIEW.md` for the source-only maintenance
contract proposal and compatibility implications. No allocator workaround is enabled.


Physical relation admission: within every explicitly selected owned namespace,
lifecycle export/import/destructive preflight and deployment backup/restore/summary
now compare live `pg_class` metadata against the exact reviewed ordinary tables plus
the ordinary `schema_migrations` ledger. Agreement of ledgers alone is insufficient.
Unlisted ordinary/partitioned/foreign/materialized/view relations refuse; listed
partition parents/children or nonordinary relation kinds are unsupported. No unknown
relation is adopted, read for data, exported, dropped or granted permissions by the
guard. Indexes and sequences are not independent dataset entries in this guard;
known identity allocator contracts remain separate. There is no explicit allowance
for unlisted tenant tables in the selected namespace contract.

This is a read-only snapshot/transaction guard, not a namespace DDL fence. The
private operator must coordinate a stable no-DDL window with privileged migration/
maintenance jobs; restricted serving roles already lack schema DDL. Concurrent
privileged DDL exclusion has not been proved by this metadata query. Configured
37-table census is not a measurement of the database until live admission passes.
Same-ID identity tenant restore remains unsupported; this check does not close it.
