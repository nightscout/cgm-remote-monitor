# Deployment catalogue and schema migrations

The platform operator takes a PostgreSQL backup and preserves the corresponding Vault
keys before upgrading. Whole-database point-in-time recovery, snapshots, dumps and
restores use the platform’s PostgreSQL and Vault tools.

The application supplies its reviewed catalogue, validates ledger compatibility, runs
migrations and checks the resulting schema. A migration failure reports the affected
catalogue and completed steps. The operator chooses a recovery point and controls
traffic and database recovery.

`createDeploymentOperations(options).upgrade(connection, {source, sourceCommit, migrate})`
returns `{record}`. `checkRecord(record)` checks the target inventory against the
running binary. Original-tenant export, restore and deletion use the
[tenant lifecycle module](../tenant-lifecycle/README.md).

## Explicit catalogue admission

`deploymentAdmission({ root?, namespaces, selection?, extensions?, instances? })` reads reviewed
JSON migration catalogues under `lib/` and `migrations/candidates/`. It never selects
all database schemas. It refuses an unadmitted candidate, missing namespace,
omitted/extra table, unsupported DDL, shared namespace or unknown selection.
A deployment-operational catalogue with no tenant data (`lib/pool-membership`, `lib/change-stamps`)
is censused with disposition `operational, no tenant data`, pinned by digest in
`OPERATIONAL`, and never enters a tenant artifact; a changed one refuses.
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
| human_session | human_identities, human_sessions, human_access_tokens, human_logout_events (OIDC human sessions; same treatment as access) |
| subject_policy | subject_policy, subject_policy_audit |
| operator_policy | tenant_operator_policy |
| tenant_settings | tenant_settings, tenant_settings_history |
| owner_configuration | tenant_owner_configuration_authority |
| legacy | legacy_credential_config, legacy_credential_subjects, legacy_data_keys |
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
// admission.catalogues: operator schema migration plan
// admission.census: selected/alternative paths, checksums and table inventory
// admission.lifecycle: tenant-scoped lifecycle instance with the same extensions
```

The census recognizes reviewed CREATE TABLE and parent-first LIKE inheritance.
Other table-creation forms refuse for review. A different source `root` must be an
explicit reviewed immutable archive; its own catalogue versions/table census are
used. The source and target admissions remain separate throughout upgrade.
