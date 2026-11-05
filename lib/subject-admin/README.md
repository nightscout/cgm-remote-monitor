# Dormant tenant subject administration

This bounded service updates and deletes existing tenant subjects and assigns
already provisioned tenant-local roles. It has no HTTP routes, listener imports,
subject creation, role CRUD, credential issuance, operator lifecycle or default
role policy. It does not complete the owner/administration REST surface.

## Trusted service boundary

`createSubjectAdmin({store, authorizeManagement})` requires an authenticated
`{tenant, principal, consumer}` context. Its trusted `authorizeManagement(actor,
{operation, subjectId})` callback must explicitly resolve `true` for `update` or
`remove`; denials and authority outages never fall back to data/root credentials.
The caller composes existing current authority with its separately reviewed
management permission/authentication policy. No permission name, owner ceiling
or root shortcut is selected by this service. Context strings alone do not
authenticate a caller. The callback authorizes the complete bounded management action, including any
already known role assignment; it does not receive proposed roles or enforce an
owner grant ceiling. Deployments needing delegable subsets must supply a reviewed
policy boundary before exposing this service. The test callback is synthetic
management authority.

- `update(context, subjectId, {name, roles?, notes?, created_at?})` returns the
  committed stable subject ID and fields. Name is required. Omitted roles mean
  remove every assigned role, matching the shipping form-encoding/save behavior.
  Supplied roles must already exist in this tenant; unknown/default-but-unstored
  roles refuse rather than silently provision a role. Role permissions and IDs
  cannot be changed here. Duplicate names/roles are not an alias for identity.
- Omitted notes preserve stored notes; `notes: ''` clears them. Omitted/empty
  creation time preserves the stored value; a previously absent value receives
  the save time, as in shipping storage. Supplied metadata is bounded to text
  notes and a parseable creation timestamp. The service rejects derived token
  fields and other unknown input. Previously absent migrated notes are returned
  as `null`, rather than the absent Mongo property. This is a service contract, not a complete compatibility
  facade for every historical Mongo value.
- `remove(context, subjectId)` removes its role links, legacy credential metadata
  and authority row together. Absent subjects refuse with
  `SUBJECT_ADMIN_NOT_FOUND`. Existing authority without its credential metadata
  refuses with `SUBJECT_ADMIN_METADATA_MISSING`; it is not silently repaired.

The subject ID is never changed. Rename updates the exact display name and
shipping-derived token prefix in the same transaction. The root-plus-ID digest
stays stable: shipping raw-token suffix matching and JWT accessToken lookup can
continue after rename. Rename is not revocation. A hash of the old full canonical
token includes the old prefix and is not given a new compatibility alias.
Grant removal and deletion take effect for operations whose current authority
read begins after commit, including the same earlier issued JWT/raw credential.
An operation already authorized may finish. No end-to-end stream invalidation
or concurrent cross-store credential/authority snapshot is claimed.

## Operator-run persistence and grants

Append-only `0003_subject_management_metadata` in the existing authority
candidate adds nullable notes/creation metadata and an append-only redacted audit
table. The earlier migrations/checksums stay unchanged. Old rows receive no
fabricated historical values. Apply explicitly with the migration runner; the
writer and serving processes never migrate. Both namespaces must be in the same
database, with both existing candidates fully applied.

Use a separate non-owner `NOSUPERUSER NOBYPASSRLS` management writer. For example:

```sql
GRANT USAGE ON SCHEMA authority_namespace, credential_namespace TO subject_writer;
GRANT SELECT, UPDATE, DELETE ON authority_namespace.tenant_authorization_subjects,
  credential_namespace.legacy_credential_subjects TO subject_writer;
GRANT SELECT ON authority_namespace.tenant_authorization_roles TO subject_writer;
GRANT SELECT, INSERT, DELETE ON authority_namespace.tenant_authorization_subject_roles TO subject_writer;
GRANT INSERT ON authority_namespace.tenant_subject_admin_audit TO subject_writer;
```

The writer screens forced RLS, ownership, exact table/column privilege shape,
and prohibited privileges at startup. The existing serving authority/credential
readers remain SELECT-only and reject writer credentials. Roles remain read-only
even for this writer. Composite foreign keys require same-tenant known roles.
This is privilege-shape screening, not full role/policy authenticity attestation.

Each call uses a private pool and one tenant-bound transaction with
`synchronous_commit=on`. Locking the stable subject and credential row serializes
same-subject updates/deletes. Role links use their existing tenant-composite
foreign keys. Concurrent updates keep last committed replacement semantics;
there is no new optimistic version protocol. A missing role, persistence error
or audit insertion failure rolls back every field/link/metadata change. Audit
contains tenant, authenticated actor, consumer, stable target ID, operation and
time, never name, notes, credentials or role payload. Raw writer credentials
remain trusted privileged persistence access; application validation and audit
are not protection against stolen database credentials.

## Verification

```sh
NS_SUBJECT_ADMIN_POSTGRES_DOCKER_TEST=1 NODE_ENV=test \
  node_modules/.bin/mocha --no-config --no-package --fail-zero --timeout 90000 \
  tests/subject-admin.test.js tests/subject-admin-postgres.integration.test.js
```

The integration suite owns and removes a unique PostgreSQL container. It uses
independent serving pools, the actual secrets credential verifier, an earlier
signed JWT, encrypted synthetic root bytes and the current Shiro reader. Its
in-memory nonexporting crypto provider and management callback are explicit lab
dependencies. It verifies metadata preservation/clearing, stable-ID rename,
current grant/deletion refusal, overlapping tenant identities, known-role bounds,
concurrent replacements, final-audit rollback, serving privilege refusal and an
RLS exposure control. Production provider/deployment policy acceptance remains
with their existing gates.
