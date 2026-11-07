# Tenant lifecycle primitives: typed export, import and two-phase deletion

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
| `requestDeletion(connection, { tenant, ledgerNamespace, artifact })` | Phase one: records `tenant_lifecycle_requests` row with the artifact digest. Deletes nothing. |
| `executeDeletion(connection, { tenant, namespaces, ledgerNamespace, artifact, requestId, onRow })` | Phase two, one transaction: locks the request, refuses an executed or digest-mismatched request, re-reads every admitted table and refuses `LIFECYCLE_ARTIFACT_STALE` if any row changed since the export, verifies each secret record's ciphertext and key reference are present in the artifact (`LIFECYCLE_KEY_MATERIAL_UNVERIFIED` otherwise), deletes in reverse catalogue order with exact-count checks, then marks the request executed. Any refusal or interruption rolls the whole transaction back. |

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

## Decision questions left for the maintainer

- DECISION: key retention after tenant deletion. `executeDeletion` removes the
  tenant's `secret_records` and `secret_audit` rows only after their ciphertext and
  key references are verified in the artifact; the Vault Transit keys named by
  `keyNames` are never deleted, so the artifact remains decryptable. Whether, when
  and by whom the keys are destroyed (and the retention period of the artifact
  and the `tenant_lifecycle_requests` tombstone) is a policy choice, not a default.
- DECISION: re-homing a tenant under a new tenant id. The secrets component binds
  the tenant id inside the authenticated plaintext envelope
  (`lib/secrets/component.js`, `read()` checks `value.tenant === identity.tenant`),
  so an artifact imported under a different id could not decrypt its secrets.
  This module therefore requires the import target tenant to equal the artifact's.
- DECISION: ordering ordinals across databases. `food.insertion_ordinal` is an
  identity column; the import preserves its value with `OVERRIDING SYSTEM VALUE`,
  which keeps relative order inside the tenant but may interleave with another
  tenant's ordinals in the target table. Nothing joins on it today.
- DECISION: artifact size and transaction bounds. The import and the deletion are
  each one transaction with no numeric cap; a bound is a policy choice.
- DECISION: who may call `requestDeletion` versus `executeDeletion`. The owner
  authority amendment places export and deletion *requests* with the owner and
  lifecycle *execution* on the private operator plane; this module exposes both as
  functions and enforces neither authorization.
