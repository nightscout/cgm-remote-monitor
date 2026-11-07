# Deployment backup, restore, upgrade and rollback primitives

Dormant Batch C source prototype. No serving path, role default, CLI or endpoint
loads this module. Its NDJSON artifact is a versioned research format; adoption,
operator authorization and production backup/key recovery remain separate work.
Nightscout is a secondary display for CGM and pump data.

## Interface and ownership

`require('./lib/tenant-operations')` exports `plan`, `backup`, `restore`, `upgrade`,
`rollback`, `verifyArtifact`, `serialize`, `deserialize`, `artifactName`,
`summarize`, `compareSummaries` and `assertSameSummary`, plus `FORMAT` and `VERSION`.

The caller owns one dedicated, idle operator `query(text, values)` connection
returning `{ rows, rowCount }`. Do not share it with a pool, serving transaction
or another operation. Backup and restore explicitly require PostgreSQL
`rolsuper` or `rolbypassrls`; FORCE RLS otherwise permits an internally consistent
empty backup. This is a private operator interface, distinct from R69's
NOBYPASSRLS tenant-scoped export/import/delete interface. No authorization or
listener activation is supplied here.

All operations accept an explicit ordered plan:

```js
const catalogues = [
  { kind: 'entries', namespace: 'deployment_entries',
    catalogue: reviewedEntriesCandidate, tables: ['entries'], secrets: [] }
];
```

Each namespace must be distinct, valid and outside `public`/system namespaces.
Tables must be tenant-bound, with `tenant_id`; preserve parent-before-child order.
The plan validates and checksums the injected migration catalogue. It does not
discover database tables or certify that the caller listed the entire deployment.
Any newly admitted domain needs a plan/inventory review before capture.

R69 owns `lib/tenant-lifecycle` and its `admittedCatalogue()` inventory. Where
that independent lane is assembled, its interface adapts explicitly:

```js
const catalogues = lifecycle.admittedCatalogue().map(({ candidate, ...entry }) => ({
  ...entry,
  catalogue: candidate,
  namespace: namespaces[entry.kind]
}));
operations.plan(catalogues); // Missing namespace mappings refuse here.
```

This module does not import that unjoined lane or implement its deletion workflow.

## Reviewed inventory and limits

Read-derived inventory from lifecycle head
`fd827e350a185ad73c838b013b25fe889434b036`, compared with application base
`83582e876dd193f4448f44c28e379fb5464a26c7`: 16 catalogue kinds, 29 tenant-bound
tables. This is an inventory review, not a restored-deployment measurement.

| Kind | Tables |
|---|---|
| entries | entries |
| treatments | treatments |
| devicestatus | devicestatus |
| profile | profile |
| food | food |
| activity | activity |
| settings | settings |
| clock | tenant_write_clock |
| checkpoint | tenant_consumer_checkpoint |
| authorization | tenant_authorization_config, tenant_authorization_roles, tenant_authorization_subjects, tenant_authorization_subject_roles, tenant_subject_admin_audit, tenant_owner_policy, tenant_owner_actors |
| access | access_tenants, access_credentials, access_sessions, access_keys |
| subject_policy | subject_policy, subject_policy_audit |
| operator_policy | tenant_operator_policy |
| tenant_settings | tenant_settings, tenant_settings_history |
| legacy | legacy_credential_config, legacy_credential_subjects |
| secrets | secret_records, secret_audit |

The independent lifecycle ledger `tenant_lifecycle_requests` is outside R69's
export inventory. A deployment including it must explicitly add its reviewed
candidate, namespace and table to this plan to preserve deletion tombstones.
`schema_migrations` is captured separately as ledger names/checksums and recreated
by migrations; its `applied_at` values are not restored. PostgreSQL roles, passwords,
role membership, ownership, arbitrary ACLs, extensions, server configuration,
provider state, Vault key material and filesystem data are outside the artifact.
Generated columns are recomputed by the target schema. Ciphertext stays opaque;
Transit version references travel, but decryptability depends on separately
retained matching keys. Restore never selects retention or destroys keys.

The recording-client unit fixture covers entries, clock, access and secrets.
The prepared native suite uses entries and clock. Neither proves the full
inventory, real secret decryptability, populated policy/FK restoration, large
artifacts or bounded resource consumption. All rows/files are held in memory.

## Operation contracts

| Operation | Boundary |
|---|---|
| `backup(connection, { catalogues, sourceCommit, registry?, now? })` | One REPEATABLE READ READ ONLY transaction captures every listed namespace's applied ledger, non-generated columns and rows across all tenants. Refuses unknown/drifted/empty ledgers, bound identities and malformed tenant rows. Optional `registry: { kind, table }` requires every seen tenant to occur in that table. Returns artifact, not files written to storage. |
| `serialize(artifact)` / `deserialize(files)` | Map between the in-memory artifact and `manifest.json` plus `tables/<kind>.<table>.ndjson`. No filesystem I/O. `deserialize` is parsing; call `verifyArtifact` or `restore` for integrity validation. Digests detect corruption and internal inconsistency, not malicious replacement of an entire self-consistent artifact. |
| `restore(connection, artifact, { catalogues, acl?, onRow? })` | Verify manifest/file digests, counts, tenant bindings and key references before BEGIN. Validate optional `acl: { role }` syntax before BEGIN. Inside one transaction, check unbound identity, exact table inventory, compatible supplied catalogue, exact applied target/artifact ledger equality, exact writable columns and emptiness of every table before INSERT/GRANT/setval. Target namespaces must already be prepared at the artifact's ledger version. Use OVERRIDING SYSTEM VALUE for identities, advance their sequences, grant the explicitly named role, then read back counts/digests/per-tenant counts before COMMIT. |
| `upgrade(connection, { migrate, catalogues, sourceCommit, registry?, now?, backup? })` | Precheck every new catalogue with `status`; refuse if nothing pending. Capture backup, compare captured ledgers with the precheck, then run each pending `up`, then every `check`. Returns `{ record, artifact }`. Migration/postcheck failure attaches `.artifact` and `.applied`. Separate runner transactions mean earlier migrations can remain committed after failure. |
| `rollback(connection, { migrate, artifact, catalogues, upgraded, acl?, restore? })` | Use the older binary's catalogues and absent target namespaces. Verify artifact, ACL, exact older catalogue ledgers and target/source separation. The older `check` must return current or `MIG_UNKNOWN` on every upgraded namespace, with at least one `MIG_UNKNOWN`. Inspect **all** target namespaces for absence before any `up`. Prepare targets sequentially, restore once, then run older `check` on all targets. Upgraded namespaces stay unchanged. Returns an explicit statement that writes after backup `takenAt` are absent from the restored target. |

`migrate(action, { namespace, catalogue })` is an injected wrapper over
`lib/migrations/postgres.run`, closing over the explicit operator connection URL
and `direct: true` attestation. The runner owns its own connections and commits.
No down migration or automatic traffic cutover is attempted.

Stop writers, migrations and competing operators for the entire upgrade/rollback
workflow and keep restore targets exclusive. The prechecks are not a deployment
lock; concurrent changes after them can invalidate the result. Backup alone
provides a consistent read snapshot, but cross-system/Vault state is not in it.
The recorded `takenAt` is captured before the backup transaction and is a time
label, not a commit watermark or replay offset.

The default backup callback keeps the artifact in memory. Before using upgrade
operationally, inject `backup` that captures, verifies, durably stores and reads
back the artifact before its promise resolves. An ordinary returned artifact
cannot recover a process crash during migration. The module cannot attest the
callback's storage durability. Preserve the artifact and partial application
record on failure; do not infer whole-workflow rollback or retry preparation into
existing namespaces. Inspect partial preparation, choose new absent target
namespaces and retain the upgraded source for investigation.

Validation refusals occur before restore writes. Execution failures (constraints,
missing roles, privileges, connection loss, oracle mismatch, `onRow` interruption)
can occur later; restore attempts ROLLBACK. Failed rollback itself raises
AggregateError and leaves the outcome uncertain. PostgreSQL sequence `setval`
changes are not transactional: row rollback does not promise pristine sequence
state. A rerun on the same prepared empty tables resets nonempty restored identity
sequences from restored maxima. No callback may perform external side effects if
it expects database rollback to undo them.

ACL recreation grants schema usage, SELECT/INSERT/UPDATE/DELETE on listed tables,
SELECT on their migration ledgers and USAGE/SELECT on all sequences in each listed
schema. The named role must already exist. It does not revoke existing grants,
create roles, grant BYPASSRLS, restore arbitrary privileges or guarantee that a
preexisting role has no extra rights. Use dedicated reviewed namespaces and roles.

## Checks and pending native proof

Database-free units, without global hooks:

```bash
./node_modules/.bin/mocha --no-config --no-package --fail-zero tests/tenant-operations.test.js
```

The suite distinguishes file-digest refusal before statements, ACL prewrite
refusal, independent source/oracle detection of a self-consistent lost tenant row,
a lying insert followed by rollback, interruption and rerun, and older-catalogue
refusal/rollback. It checks all rollback targets before preparation, including an
empty existing schema and cross-kind alias of a source namespace. It is a
recording SQL model, not PostgreSQL acceptance.

`tests/tenant-operations.integration.test.js` is explicitly opt-in and requires
a focused runtime grant. With the flag absent it registers pending tests and
opens no services. After a
grant, this command creates one owned disposable PostgreSQL 16 Docker container,
random loopback port and ephemeral credentials, and removes exactly that container:

```bash
NS_TENANT_OPERATIONS_PG_TEST=1 ./node_modules/.bin/mocha --no-config --no-package --fail-zero tests/tenant-operations.integration.test.js
```

It is prepared to measure native type/identity behavior, grants and RLS, digest
and ACL refusal, independent row loss, lying insert/rollback, interruption/rerun,
old-catalogue refusal and later-target freshness. The representative five-case baseline and final restoration, plus four native
semantic controls and their targeted restorations, passed on exact
`f77c025f8e797775faca0e179cc84fc3ca9c5874`; the alignment programme's dated
`reports/tenancy/backup-upgrade-native-f77-2026-11-06.md` records the scope and hashes.
Full-inventory restoration, durable storage/key recovery and assembled application
acceptance remain coordinator-owned pending work. A disabled
suite, syntax check or registration count is not native evidence.
