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
| `importArtifact(connection, artifact, { tenant, namespaces, onRow })` | One transaction. Refuses before any write when the artifact's tenant is not the target, a row's `tenant_id` differs from the manifest tenant, a key reference has no ciphertext, the target namespace's applied migration ledger (`schema_migrations` names and checksums) differs from the manifest, a table's columns differ, a catalogue is missing or unmapped, or the target already holds rows for the tenant. Identity columns are written with `OVERRIDING SYSTEM VALUE`. |
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

- Restore preserves the original tenant ID and compatible retained key material.
  New-tenant cloning/import establishes new secrets/credentials; data sync does
  not transfer source authority. No cryptographic rehoming workflow is implemented.
- Deleted-tenant keys and artifact remain for the adopted 30-day window, then an
  operator destroys keys through a separately reviewed provider capability. This
  module never destroys keys or proves after-window refusal. Pre-deletion
  confirmation/cancellation is a separate open ceremony contract.
- The joined catalogue includes accepted owner configuration authority. Use
  `createLifecycle({ catalogues })` for reviewed M5 extensions; whole-deployment
  admission in `../tenant-operations/catalogues.js` independently refuses omitted
  candidate files and includes the separate lifecycle ledger in deployment backup.

- Ordering ordinals across databases. `food.insertion_ordinal` is an
  identity column; the import preserves its value with `OVERRIDING SYSTEM VALUE`,
  which keeps relative order inside the tenant but may interleave with another
  tenant's ordinals in the target table. Nothing joins on it today.
- Artifact size and transaction bounds. The import and the deletion are
  each one transaction with no numeric cap; a bound is a policy choice.
- Execution authority: who may call `requestDeletion` versus `executeDeletion`. The owner
  authority amendment places export and deletion *requests* with the owner and
  lifecycle *execution* on the private operator plane; this module exposes both as
  functions and enforces neither authorization.
