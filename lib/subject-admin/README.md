# Dormant tenant subject administration

This bounded service updates and deletes existing tenant subjects and assigns
already provisioned tenant-local roles. It has no HTTP routes, listener imports,
subject creation, role CRUD, credential issuance, operator lifecycle or default
role policy. A separate dormant [HTTP factory](../server/subject-management-app.js)
composes this service as described below. Neither component completes the
owner/administration REST surface.

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

## Separately authenticated dormant HTTP factory

`createSubjectManagementApp({resolver, authenticateManagement, subjectAdmin})`
returns an Express application without opening a socket. It is never imported
or mounted by `createTenantApp` or a CLI. A deployment must separately compose
its management listener and reviewed authentication policy before exposure.

The trusted `authenticateManagement({tenant, credential, request})` callback
receives the resolved tenant, one strictly parsed bearer credential and the
request. It must authenticate management credentials and return a matching
`{tenant, principal, consumer}`, or return a false value to refuse. A host, body
field or route identifier supplies no authentication. Cross-tenant results are
refused. Data/root/JWT credentials supply no management grant through this
factory; a deployment must keep its callback separate from data verification.
The factory supplies no credential issuer, human identity provider or fallback.
The accepted service's `authorizeManagement` callback still independently
authorizes the complete action, including every proposed known role assignment.
It receives the operation and target ID, rather than proposed roles. This is
whole-operation authority; no delegable owner grant ceiling is selected here.

- `PUT /api/v2/authorization/subjects` accepts JSON
  `{_id, name, roles?, notes?, created_at?}` and returns the accepted service's
  `{subjectId, name, roles, notes, created_at}`. `_id` identifies an existing
  subject; it cannot rename the identity. Omitted roles revoke all roles;
  omitted notes and omitted/empty creation time preserve stored metadata.
- `DELETE /api/v2/authorization/subjects/:_id` returns `{}` after the committed
  deletion. It accepts no body fields; an optional body must be JSON `{}`.

Source characterization is **read-derived**: shipping
[`api2/index.js`](../api2/index.js) mounts `/authorization`, and
[`authorization/endpoints.js`](../authorization/endpoints.js) uses this PUT
body `_id` and DELETE path `_id`. Shipping
[`authorization/storage.js`](../authorization/storage.js) preserves omitted
notes and empty/omitted creation time while allowing omitted role assignment
to revoke access. The facade preserves those bounded verb/identity/omission
contracts. It does not claim API v1 or complete shipping facade compatibility:
shipping also accepts form encoding and serves derived credentials, while this
factory accepts bounded JSON and returns the existing service shape. Stable
role-ID and roles CRUD compatibility remain separate work; this factory assigns
only already provisioned tenant-local role names accepted by the service.

Bodies are limited to 64 KiB, compressed bodies and non-JSON mutation bodies
are refused, and unknown fields (including tenant/actor/derived-token fields)
are invalid. Every response sets `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`; Express signature and entity tags are disabled.
No credential or private exception detail is reflected. Supported paths with
other methods return 405 with `Allow`; unmounted paths return 404.

This factory's explicit HTTP contract, rather than a shipping status-parity
claim, maps invalid input/unknown roles to 400, credential refusal to 401,
`SUBJECT_ADMIN_FORBIDDEN` to 403, absent subjects to 404,
`SUBJECT_ADMIN_METADATA_MISSING` to 409, body overflow to 413 and unsupported
media/encoding to 415. PostgreSQL adapter
`SUBJECT_ADMIN_STORE_UNAVAILABLE`/`SUBJECT_ADMIN_STORE_UNSAFE` map to 503 with
their bounded code. Other authentication, authority and persistence exceptions
return 503 `AUTHORITY_UNAVAILABLE`. Unknown tenant aliases return 404
`TENANT_REFUSED`; malformed or conflicting tenant selectors return 400.
Malformed percent-encoded path parameters produce a sanitized 400
`REQUEST_INVALID` before authentication. Only the router's marked decode
`URIError` is classified this way; callback type/decode errors remain unavailable.

The opt-in HTTP lab uses a unique disposable PostgreSQL service and random
database, persistent writer and independent serving readers, synthetic management
authentication, and earlier JWT/raw credentials. HTTP grant removal/deletion is
checked against the same earlier JWT on subsequent protected data HTTP
operations. It also checks matching authenticated tenant identity, metadata,
concurrent replacement/deletion, audit rollback, wrong-plane refusal, the
unchanged data application's absent management mounts and loopback-only network
connections. It supplies no production identity or owner policy acceptance.

```sh
NS_SUBJECT_MANAGEMENT_HTTP_DOCKER_TEST=1 NODE_ENV=test \
  node_modules/.bin/mocha --no-config --no-package --fail-zero --timeout 90000 \
  tests/subject-management-http.integration.test.js
```

## Service verification

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


## Selected dormant owner-policy enforcement

The existing PostgreSQL store accepts an optional trusted constructor argument:
`ownerPolicy: { catalogue: ['api:entries:read', 'api:entries:create'] }`.
These illustrative concrete permissions are not a complete reviewed role catalogue.
The caller must provide its explicit, nonempty, distinct concrete catalogue. The
existing service and separately authenticated HTTP facade still call the same store
update. No data-token/root credential is promoted to management authority and no
listener or identity issuer is enabled by this option.

In this selected mode, the store snapshots/validates the proposed update before its
first await. Inside its existing tenant-bound transaction it locks the current
configuration defaults, operator ceiling and matching management actor, then the
proposed tenant-local role definitions in name order. It evaluates the union of the
proposed role permissions and supported implicit defaults against all three sets:
code catalogue, current operator ceiling, current actor explicit delegation. The
actor must currently be active and allowed to update, with both principal and consumer
matching. Use permission alone does not supply delegation. A catalogue digest mismatch,
missing authority, unsupported wildcard, inactive actor or excess proposed grant
refuses before subject/credential/link/audit mutation. Unknown roles retain their
existing explicit refusal. Each operation obtains fresh locked state; no prior
permission snapshot is retained across requests.

Only concrete permission strings are admitted in this dormant subset. `denied`
contributes nothing; `status-only` contributes `api:status:read` and requires it to
fit the same intersection. The wildcard `readable` default and wildcard role
permissions refuse; there is no finite projection that silently accepts their wider
meaning. Unselected/default store behavior is unchanged. Selected-mode removal
refuses explicitly, pending its separate ownership/removal policy; this does not
change the existing default remove operation.

The appended `0004_owner_policy_fencing` authority candidate preserves all earlier
migrations/checksums. It adds `tenant_owner_policy` (catalogue digest, ceiling) and
`tenant_owner_actors` (tenant/principal/consumer, active/update flags, delegation),
both forced-RLS, plus harmless `owner_fence` boolean columns on these tables and the
existing configuration and role tables. Catalogue digest is SHA256 over
`JSON.stringify(catalogue.slice().sort())`; `owner-policy.js` exports the same digest
helper for operator preparation. Updating code catalogue therefore requires explicit
matching operator-policy preparation; it does not silently widen old delegation.

A selected-mode management writer needs its existing subject/link/legacy/audit
privileges plus SELECT and **only UPDATE(owner_fence)** on these four authority
tables. It receives no UPDATE of role permissions/name, operator ceiling/digest,
actor active/update/delegation fields or configuration defaults. Startup screens
forced RLS, nonownership and exact column grants; broader authority grants refuse.
The fence-column UPDATE privilege permits PostgreSQL `SELECT ... FOR SHARE`; the
application does not update the fence value or derive authority from it. Default
mode still rejects any role-column UPDATE grant. Serving authority readers retain
their separate read-only credentials.

Row SHARE locks remain until the subject/link/audit transaction commits or rolls
back, and conflict with ordinary private-operator UPDATE/DELETE. Lock order is
configuration, policy, actor, sorted proposed roles, target subject, legacy metadata.
A revoker committing before proposal locks must be observed; a proposal that already
holds the authority locks may finish before the waiting revoker. Concurrent private
operator transactions should use the same order; conflicting order can produce a
bounded transaction refusal, not permission fallback. A role change must not race
between validation and assignment. This boundary requires real lock/race controls
before claiming reproduced enforcement; code reading alone is not acceptance.

This is proposed-assignment enforcement, not a complete owner platform. Human or
refresh/session issuance, arbitrary role CRUD/wildcard compatibility, ownership
transfer/removal, and applying a newly tightened ceiling to all already stored
subject data grants remain separate integration work. The accepted data-token
reader and preview configuration are unchanged. Raw privileged operator/database
credentials remain trusted; the code and audit are not a defense against a stolen
management writer credential issuing arbitrary SQL within its existing grants.
