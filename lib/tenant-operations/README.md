# Original-tenant deployment recovery operations

Dormant, explicitly invoked Batch C library. No serving route, listener, startup
migration, provider, role default or CLI is enabled. Nightscout is a secondary
display for CGM and pump data. The NDJSON artifact remains a research format.

These operations preserve raw physical snapshot fidelity. Tenant-local same-ID
clinical restore instead publishes forward history corrections/deletions and keeps
current authority, checkpoints and live clock state; see the
[lifecycle contract](../tenant-lifecycle/README.md). Whole-deployment rollback is
not that logical operation and can revert other tenants.

## Source boundary and evidence

This source joins accepted A74, R69 lifecycle and the backup/upgrade continuation.
The historical f77 representative PostgreSQL proof remains attributed to
`f77c025f8e797775faca0e179cc84fc3ca9c5874`: entries/clock, five cases and four
physical semantic controls/restorations. It does not verify the subsequent whole
catalogue, filesystem callback or explicit privilege-plan implementation.
Whole populated native/assembled acceptance is **UNMEASURED** until the coordinator
reviews the frozen plan and grants a focused run. Full/browser/corpus acceptance
belongs to the coherent assembled candidate.

## Explicit catalogue admission

`deploymentAdmission({ root?, namespaces, selection?, extensions?, instances? })` reads reviewed
JSON migration catalogues under `lib/` and `migrations/candidates/`. It never selects
all database schemas. It refuses an unadmitted candidate, missing namespace,
omitted/extra table, unsupported DDL, shared namespace or unknown selection.
Current assembled whole-C selection: **23 candidate files, 21 physical instances, 37 tables**; the three
socket-order successors are explicit alternative selections, not additional domains.

The lifecycle list owns tenant export/import/delete order. It now includes A74's
`tenant_owner_configuration_authority`. The deployment plan additionally includes
the separate `tenant_lifecycle_requests` tombstone ledger; ordinary tenant exports
exclude that ledger. Every table must be tenant-bound. Non-generated columns are
read from PostgreSQL during capture; generated columns are recomputed on restore.

| Kind | Tables |
|---|---|
| entries, treatments, devicestatus, profile, food, activity, settings | One corresponding clinical/document table each |
| clock | tenant_write_clock |
| checkpoint, evaluator_checkpoint | Separate tenant_consumer_checkpoint table in each actual namespace |
| authorization | tenant_authorization_config, tenant_authorization_roles, tenant_authorization_subjects, tenant_authorization_subject_roles, tenant_subject_admin_audit, tenant_owner_policy, tenant_owner_actors |
| access | access_tenants, access_credentials, access_sessions, access_keys |
| subject_policy | subject_policy, subject_policy_audit |
| operator_policy | tenant_operator_policy |
| tenant_settings | tenant_settings, tenant_settings_history |
| owner_configuration | tenant_owner_configuration_authority |
| legacy | legacy_credential_config, legacy_credential_subjects |
| secrets | secret_records, secret_audit |
| lifecycle | tenant_lifecycle_requests, tenant_lifecycle_ceremony |
| alarm_suppression | tenant_alarm_suppression |
| notification_outbox | tenant_notification_heads, tenant_notification_requests, tenant_notification_state |

Exact frozen alarm/outbox catalogue JSON is now present as recovery input, with
explicit pinned extensions in the prepared fixtures. This assembled source includes frozen B runtime ancestry; runtime acceptance is
UNMEASURED here. Earlier C-only snapshot capsules retain their historical scope. Any later catalogue must be explicitly admitted. Each extension must pin its canonical candidate digest; a changed
catalogue refuses until its explicit admission is updated. No active peer source or guessed schema is imported:

```js
const admission = operations.deploymentAdmission({
  namespaces: explicitNamespaces,
  selection: Object.fromEntries(['treatments', 'devicestatus', 'profile'].map(kind =>
    [kind, 'migrations/candidates/postgres-' + kind + '-socket-order-v1.json'])),
  instances: [{ kind: 'evaluator_checkpoint', of: 'checkpoint' }],
  extensions: [{ kind: reviewedKind, candidatePath: reviewedJsonPath,
    candidateDigest: reviewedCandidateDigest,
    tables: reviewedParentFirstTables, secrets: reviewedCiphertextTables }]
});
// admission.catalogues: operator migration/backup plan
// admission.census: selected/alternative paths, checksums and table inventory
// admission.lifecycle: tenant-scoped lifecycle instance with the same extensions
```

The census recognizes reviewed CREATE TABLE and parent-first LIKE inheritance.
Other table-creation forms refuse for review. A different source `root` must be an
explicit reviewed immutable archive; its own catalogue versions/table census are
used. The source and target admissions remain separate throughout upgrade.

## Durable filesystem artifact callback

`createFilesystemBackup({ directory, io?, backup? })` implements the existing
injected upgrade callback. The default `io` is Node's filesystem promises API;
`io`/`backup` injection supports narrow fault controls. No peer filesystem is used.

The destination is an absolute, same-owner private directory, with an existing
parent. A newly created root and its parent are synced. Each artifact is written
to one owned private staging directory with exclusive files (0600), and each file
is fsynced. Tables/staging directories are synced; the artifact is reloaded and
verified before atomic rename. The published parent is synced, then the artifact
is independently reloaded and verified again before the callback resolves.
`saveArtifact(artifact, { directory })` and `loadArtifact({ directory, name })` expose
the same persistence/readback boundary without a database.

A write, sync, rename or readback failure refuses. Only this invocation's staging
directory is removable. Failure after rename retains the published artifact and
reports failure; operators can inspect/reload it, but no migration may infer success.
An existing artifact name is never overwritten. This is a local POSIX filesystem
contract, not a power-loss/storage-device or distributed-filesystem acceptance claim.

The kernel's default `backup` still returns memory-only data. Whole-deployment
operations below force the durable callback before migration. They do not rotate,
expire or destroy artifacts or keys. Optional registry checks retain their literal
contract (every seen tenant must be registered); historic lifecycle tombstones can
outlive registry rows, so do not silently apply that check to a deletion archive.

## Whole-deployment interface

```js
const target = operations.createDeploymentOperations({
  directory: privateArtifactDirectory,
  root: reviewedTargetSourceArchive,
  namespaces: targetNamespaces,
  selection: targetSelection,
  extensions: targetExtensions
});
const { record, artifact } = await target.upgrade(operator, {
  migrate: explicitNewMigrationRunner,
  sourceCommit: targetCommit,
  source: { root: reviewedOldSourceArchive, sourceCommit: oldCommit,
    namespaces: oldNamespaces, selection: oldSelection, extensions: oldExtensions }
});
```

All namespace maps and extensions are explicit; the wrapper re-enumerates current
admission before each operation. `source` is mandatory for upgrade. It supplies the
actual old inventory, fully applied ledgers and old source commit; the target
admission supplies the proposed new inventory. Existing kinds must preserve their
namespace, existing tables/order and migration checksum prefix. New namespaces
must be absent. No down migration, dropped table or silent data transformation is
accepted by this append-only transition contract.

Upgrade prechecks the target, persists only the OLD inventory, verifies the captured
source ledgers, then runs the explicit target migration runner. It checks all target
ledgers/tables, projects old writable columns from the upgraded source and compares
old row digests/counts/per-tenant counts with the retained artifact. Added columns
can change full target shape; lost/changed old data refuses with the artifact and
partial application record retained. Separate runner transactions can remain
committed after failure; the workflow is not globally atomic.

The record names source and target inventories, backup digest and applied steps.
`older.checkRecord(record)` refuses a newly added unknown kind or newer ledger;
per-namespace old migration checks alone cannot detect a wholly new namespace.
This is an explicit operator readiness contract, not an automatically wired serving
startup gate. A rollback requires the matching upgrade record and old admission:

```js
const older = operations.createDeploymentOperations({ directory: privateArtifactDirectory,
  root: reviewedOldSourceArchive, namespaces: freshOldNamespaces,
  selection: oldSelection, extensions: oldExtensions });
await older.rollback(operator, artifact, {
  migrate: explicitOldMigrationRunner, upgradeRecord: record,
  upgraded: Object.fromEntries(record.targetCatalogues.map(item => [item.kind, item.namespace])),
  acl: explicitOldRoleGrants
});
```

Rollback verifies the record/old artifact binding, recorded target ledgers and old
binary refusal. It preflights ALL fresh old target namespaces before preparation,
then migrates those old namespaces and restores the old artifact once. Upgraded
namespaces, including newly added kinds, remain untouched for investigation.
Writes after the backup are absent from the restored target. No traffic cutover,
writer pause, deployment lock or recovery scheduling is implicit: stop competing
writers/operators and keep targets exclusive for the entire workflow.

## Restore identity and privileges

Restore preserves every original tenant UUID and compatible retained ciphertext/key
reference. `tenant`, `targetTenant`, `mapTenant` and `clone` options refuse. New-tenant
cloning/import needs new destination secrets and credentials; ordinary data sync
never transfers credential authority. No transparent decrypt/re-encrypt workflow,
provider selection or cloning acceptance is supplied.

Whole-deployment restore/rollback refuses legacy blanket `acl: { role }`. It accepts
an explicit `acl: { grants: [...] }` or null (operator-only restored data, no grants):

```js
const acl = { grants: [
  { role: 'data_reader', kind: 'entries', table: 'entries', privileges: ['SELECT'] },
  { role: 'checkpoint_writer', kind: 'checkpoint', table: 'tenant_consumer_checkpoint',
    privileges: ['SELECT'], columnPrivileges: { UPDATE: ['checkpoint', 'projection', 'contract_digest'] } },
  { role: 'clinical_restorer', kind: 'clock', table: 'tenant_write_clock',
    privileges: ['SELECT'], columnPrivileges: { UPDATE: ['last_stamp'] } },
  { role: 'clinical_restorer', kind: 'clock', table: 'schema_migrations', privileges: ['SELECT'] }
] };
```

This abbreviated example is not the full deployment role matrix. Enumerate every
role/table/column at the integration boundary, preserving read-only clinical DATA/
evaluator access and narrowly owned settings/checkpoint/ack/outbox effects. No
wildcards, ALL privileges, DDL grants or write access to migration ledgers are
accepted. Sequence rights must be requested explicitly and resolve only that
table's identity sequences before writes. Schema USAGE is limited to the named
role/kind. Roles must already exist; no role creation, membership, BYPASSRLS or
revocation of preexisting rights is implied. Fresh reviewed roles and denied-write
checks are required to establish least privilege in native acceptance.

Kernel restore validates artifact/file integrity, ACL syntax/columns/sequence
bindings, exact target ledgers/columns and every table's emptiness before INSERT/
GRANT/setval. It restores in one transaction, reads back the restored rows and
compares its oracle before COMMIT. Errors attempt rollback; failed rollback leaves
outcome uncertain. PostgreSQL sequence setval is not transactional, so row rollback
does not promise pristine sequence state. The legacy low-level `{ role }` kernel
interface remains only for historical representative callers.

## Remaining acceptance

Focused source tests use recording clients plus owned temporary filesystem
artifacts. They do not establish PostgreSQL privilege/type/FK/sequence behavior or
hardware durability. The next native plan must populate every selected table,
include deletion tombstones and ciphertext references, exercise actual new M5
namespace transition/older-tool refusal/fresh old restore, and independently deny
foreign/cross-capability writes. Retained-key destroy/after-window refusal needs
its own explicit provider boundary under the adopted retention decision; none is
implemented or silently enabled here. Numeric resource/cadence budgets remain
unmeasured. The coordinator owns the frozen candidate and one assembled campaign.

The [whole populated native plan](acceptance-plan.md) names the source boundary,
explicit privilege matrix, pending actual M5 extensions and required controls.

Deletion now requires the [confirmed ceremony](../tenant-lifecycle/CEREMONY.md);
complete recovery inventory includes both lifecycle ledgers. No provider/key
destruction or all-credential blackout is inferred from that ceremony.


### Explicit physical catalogue instances

Joined realtime and evaluator use distinct checkpoint namespaces and principals.
The source census counts unique candidate files; recovery counts every physical
instance. Keep `checkpoint` mapped to the actual realtime namespace and declare:

```js
instances: [{ kind: 'evaluator_checkpoint', of: 'checkpoint' }]
// namespaces.evaluator_checkpoint is the actual evaluator checkpoint namespace.
```

This bounded interface admits only reviewed checkpoint duplicates. Each instance
has independent artifact keys, ledgers, rows, namespace and ACL kind. Namespace
aliasing, duplicate instance keys and supplied namespace mappings omitted from the
admission refuse. Both `createDeploymentOperations` and lifecycle re-admission
retain these declarations. `tests/fixtures/tenant-deployment-checkpoints.js` binds
actual consumer config/digests/principals and emits instance-keyed seeds/grants;
never collapse its rows into a dictionary keyed only by SQL table name.

With both instances selected the projected B+C inventory is23candidate files,
21physical instances and37tables; the historical C0a one-checkpoint configuration was
20instances/36tables. These are source inventory measurements, not native results.


The assembled SQL-core instrument is `tools/lab/tenant-whole-c/run.py`; start with
`--check` for source-only syntax/causal-signature checks. Its README/manifest bind
all five cohorts, independent observer, controls, current SQL authority and actual
writer birth/quiescence inputs. Native execution requires the parent's explicit
fixture/grant/outage/role contract; no instrument case has run merely by joining it.


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


Ordinary inheritance is also unsupported. A selected ordinary relation can have
parents or descendants in another namespace while remaining `relkind=r` and not
a partition. Admission therefore checks both `pg_inherits.inhrelid` and
`inhparent` for each selected relation, including the migration ledger, and refuses
any participation. It does not adopt foreign descendants or substitute `ONLY` to
silently narrow the operation. This remains metadata-only point-in-time admission,
not a concurrent privileged-DDL fence. The configured 37-table selection and
same-ID tenant-restore gap retain their prior scope.
