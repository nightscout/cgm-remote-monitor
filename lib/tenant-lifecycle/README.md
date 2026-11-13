# Tenant lifecycle: export, logical restore and confirmed deletion

Explicit private-plane library. Serving roles do not expose a restore endpoint or
CLI through this module. Its typed artifact remains a research format. The caller
supplies a lower-port PostgreSQL connection for a `NOSUPERUSER NOBYPASSRLS`
private role; tenant binding and forced row-level security bound data access.
Vault provider keys are never exported. They are deleted only by the explicit
operator `destroyRetainedKeys` call after the 30-day post-deletion retention
window ([key retention](#post-deletion-key-retention)).

## Export and restore

`exportTenant(connection,{tenant,namespaces,sourceCommit,keyNames})` captures one
`REPEATABLE READ` snapshot of the complete selected reviewed catalogue. It preserves
typed `id_kind`, public documents, private insertion ordinals and tenant counter
floors. Secret records remain ciphertext with recovery references, never plaintext
or provider keys. Export requires current exact migration ledgers and physical
relation inventory; agreement between unknown artifact/database schemas is insufficient.

`createLifecycle({catalogues}).importArtifact(connection,artifact,{tenant,namespaces,
ledgerNamespace,maintenanceClaim,onRow,onCommitted,now})` selects logical reconciliation when the
selected catalogue contains the current tenant-local insertion schema and clock.
`restoreLogical(connection,artifact,options)` exposes that operation explicitly
with the same options and constructor-owned catalogue selection. Obtain its
connection and opaque claim from the actual controller:

```js
await controller.withRestore(tenant, { artifactDigest: artifact.digest },
  async ({ connection, maintenanceClaim }) => lifecycle.importArtifact(
    connection, artifact, {
      tenant, namespaces, ledgerNamespace, maintenanceClaim,
      onCommitted: summary => publishCommittedSummary(summary)
    }));
```

The controller holds A's real exclusion capability and outer DATA transaction.
Restore asserts it before effects and before returning to commit. A callback's
`quiesced:true`, a caller boolean or a lease expiry cannot replace that capability.
B has independent tenant locks and counters; this operation requests no shared
allocator reset or global write pause. See [maintenance-window.md](maintenance-window.md)
for the controller's precise cohort and failure contract.

Logical restore reconciles the union of captured and currently retained clinical
identities. Entries, treatments, devicestatus, profile, food and settings use their
existing history protocol: changed captured records receive forward `srvModified`,
missing captured records receive normal new-record server dates, and current-only
records become forward soft-deletion records. Existing changed records retain their
live `srvCreated`; unchanged public documents retain live server metadata. Clinical
fields come from the artifact. Private insertion numbers may change: rows are
allocated in artifact relative order from A's retained current counter floor.

Activity has no v3 history protocol. It uses physical snapshot replacement/removal
and the controller's actual cache/socket/evaluator invalidation, preserving its
existing full-read behavior. No activity incremental-history guarantee is added.

Current access, credentials, authorization, secrets, owner configuration, checkpoints,
alarm suppression, notification outbox and private lifecycle authority/window/audit
state remain current. Logical restore does not rewind them from an old artifact.
Historical IDs hard-purged before restore and absent from both sources remain
outside the existing retained-history scope; this is not an all-time or all-client
cache convergence guarantee.

## Admission and commit boundary

A live provisioned tenant clock is required. Its floor remains authoritative and
must be valid and at least every observed current clinical `srvModified`. Restore
also refuses a live floor below the known captured clock or any captured clinical
`srvModified`; malformed or missing captured clock evidence refuses before effects.
Restore checks its current exact ledger, relation inventory, columns, forced tenant policy
and effective role privileges before effects. The private role needs schema USAGE,
clock SELECT and **column UPDATE(last_stamp)**, plus SELECT on its migration ledger.
Clock INSERT, DELETE, tenant_id UPDATE, schema CREATE, ownership and elevated roles
are refused. Provisioning that live floor is a separate operator action; an empty
or deleted tenant without a trustworthy retained clock cannot silently recreate it
from an old artifact.

Selected clinical ledgers must be current. Captured clinical ledgers must be known
reviewed prefixes. Current ordered tables additionally require exact insertion
schema/trigger/ACL and floor admission. Missing live floor, a floor behind observed
metadata, ambiguous or reassigned public identifiers, unavailable artifact ordering,
unknown schema/history semantics, foreign tenant rows and forged claims refuse.
Clone/cryptographic rehoming is unsupported. Legacy shared-identity component import
still refuses `LIFECYCLE_IDENTITY_IMPORT_UNSUPPORTED` before sequence effects.
Component-only raw import retains its separate exact/empty-target contract.

`onRow({kind,written,action})` runs within logical restore; throwing rolls back A's
data and clock/counter changes. It is not a committed notification. `onCommitted`
is registered through the controller's actual `connection.afterCommit` seam and
runs only after acknowledged outer DATA commit, before invalidation/activation.
It must not reuse the closed restore connection or require ordinary A admission
while A is suspended. Rollback and ambiguous DATA commit do not automatically
publish. Failed restore normally retains durable suspension; an uncertain commit
requires persisted-state inspection. Activation response loss may mean A is already
active. There is no automatic retry, expiry-based reopening or exactly-once
notification replay promise.

## Physical backup and deletion

Logical reconciliation deliberately changes public history metadata. Raw physical
backup fidelity and whole-deployment rollback belong to
[tenant operations](../tenant-operations/README.md); they preserve a separate exact
snapshot contract, including forensic control state. A whole-deployment rollback
can affect B and is not tenant-local logical restore.

Deletion retains its distinct current-authorized request/confirm/cancel/claim/execute
ceremony. The complete capability and recoverable-key contract is in
[CEREMONY.md](CEREMONY.md). Compose the census-selected lifecycle through
`admission.lifecycle.withCapabilities(...)`; do not substitute an old static list.
Private control relations remain outside ordinary tenant artifact/deletion data.
No retention expiry or provider key destruction is automatic.

## Post-deletion key retention

Release decision `tenant-deletion-key-retention` (option (a), 30 days), in
`key-retention.js` and lifecycle migration `0005_tenant_lifecycle_key_retention`:

- **Completeness before removal.** Inside the destructive transaction, before any
  row is deleted, the artifact must name every provider key the trusted
  `keyInventory({tenant})` capability returns (`[{mount,name}]`, names only) and
  hold every live ciphertext with its key reference. Otherwise deletion refuses
  (`LIFECYCLE_KEY_NAMES_MISSING`, `LIFECYCLE_KEY_REFERENCE_MISSING`,
  `LIFECYCLE_KEY_REFERENCE_UNKNOWN`, `LIFECYCLE_KEY_MATERIAL_UNVERIFIED`) and
  nothing is removed. `exportTenant` fills `keyNames` from the inventory when the
  caller does not supply them.
- **Retention.** The same transaction records `tenant_lifecycle_key_retention`
  (`retained`, `retain_until = executed_at + 30 days`, key names and the count of
  key references; never ciphertext). Provider keys are not touched.
- **Restore gate.** `importArtifact` and `restoreLogical` require `ledgerNamespace`
  and, inside their own transaction before the first write, refuse a tenant with a
  record in `destroying`/`destroyed` (`LIFECYCLE_KEYS_DESTROYED`) or a `retained`
  record whose window has ended (`LIFECYCLE_RETENTION_EXPIRED`). Inside the window
  the restore proceeds and marks the record `restored`. A tenant never deleted has
  no record and is unaffected.
- **Destroy.** `destroyRetainedKeys(connection,{tenant,requestId,ledgerNamespace,
  namespaces,intent,now})` requires the operator plane through `authorize`, the
  exact intent string `destroy-retained-keys:<tenant>:<requestId>`, an ended
  window, and zero rows for the tenant in every admitted table (a same-ID tenant
  that is live again keeps its keys). It commits `destroying` with the actor, asks
  the `keyCustodian` capability to delete and confirm absence of each key
  (`lib/secrets/vault-transit-custodian.js`), then commits `destroyed` with the
  actor. A provider failure leaves `destroying` (restore still refuses) for an
  explicit retry. Destruction cannot be undone: ciphertext under those keys, in
  the database or any retained artifact, no longer decrypts.
- **Export file removal.** In the same step, after the provider confirms the keys
  gone, the `removeArtifact` capability removes the export artifact the retention
  record knows by digest (`tenant-artifact-<digest>`;
  `createFilesystemArtifactRemover({ directory })`). The path is built only from
  the configured private directory and the recorded 64-hex digest; a symlink or
  non-directory with that name is refused, never followed. The outcome is written
  in the same row that records `destroyed` (`artifact_removal`: `removed`,
  `absent` or `failed`, plus a fixed `artifact_removal_code` when failed; never a
  path) and returned as `artifact`. A missing file (`absent`) or a file that
  cannot be removed (`failed`) never blocks key destruction. `destroyRetainedKeys`
  refuses with `LIFECYCLE_ARTIFACT_REMOVER_REQUIRED` before any state change when
  the capability is absent. A repeat call on a `destroyed` record reports the
  recorded outcome and does not retry the removal. Only the file this module
  knows is removed: copies made elsewhere (backups, downloads, other hosts) are
  the operator's responsibility.
- **Time** is the injected `now` of each call; the window constant is not
  configurable. The record's CHECK constraints also refuse a `restored_at` outside
  the window and a destroy start before `retain_until`.

The export file is removed by the destroy step above, not by a timer: nothing deletes it before an operator runs destroy after the window.

The catalogue admits validated typed migration table descriptors, with counters
before clinical rows and reverse deletion order. Physical admission compares live
`pg_class` against the exact selected ordinary tables plus `schema_migrations`.
Unknown relations, partitions and inheritance refuse. This is a point-in-time
metadata check, not exclusion of concurrent privileged DDL: the operator must
coordinate the selected no-DDL window.

## Evidence boundary

The logical-restore source/protocol cohort has 86 passing focused tests, including
actual history-handler/cache-model, profile first-match, activity-reader and
controller commit-outcome checks. Authored missing-tombstone and stale-stamp
controls make the cache test fail; restored source passes. Protocol doubles are
not native PostgreSQL role, advisory-lock or independent-process evidence.
Native joined acceptance is pending for this capability; final full/browser/corpus
acceptance belongs to the coordinator's coherent candidate. No readiness or M6
completion claim follows from the focused source cohort.
