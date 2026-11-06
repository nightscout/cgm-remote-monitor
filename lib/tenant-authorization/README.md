# Tenant authorization candidate

This is a read-only persistence adapter and a separate, operator-run candidate
migration. It is not registered with the server, does not enable a listener or
role, and does not change single-tenant authorization.

`postgres.js` accepts an immutable resolved tenant ID, an internal principal,
and the Shiro permission required by the handler. It never derives permission
from an HTTP method or path. The principal boundary is trusted input:
`{ kind: 'anonymous' }`, `{ kind: 'subject', subjectId }`, or
`{ kind: 'root' }`. No production credential verifier, credential-to-stable-
subject mapping or token format is implemented in this adapter. The separate
[legacy credential/GET bridge](../secrets/legacy-credentials.md) now supplies
verified internal principals and current exact-read authority in a dormant
composition. In particular, callers must not construct `root` from request
data or JWT claims.

Each authorization call obtains a fresh PostgreSQL snapshot in its own tenant-
bound transaction. Tenant configuration and role assignments are read in one
statement; that statement's snapshot is the authorization linearization point.
A committed change is observed by the next operation across independent adapter
pools. Configured `denied`, `readable`, and `status-only`
defaults expand to the existing Nightscout Shiro permissions. Authenticated
subject permissions are the union of those defaults and the subject's
tenant-scoped role permissions. Anonymous permissions use only those fixed
defaults; role rows cannot grant anonymous writes. Root is allowed only after
the tenant configuration exists and is still an internal verifier-produced
principal, not a credential feature of this candidate.

The candidate catalogue defines tenant-composite subject/role links and forced
RLS. An operator must apply it explicitly and grant the serving identity
SELECT-only access as part of a separately reviewed deployment. The opt-in
integration test creates and removes its own disposable PostgreSQL container:

```sh
NS_TENANT_AUTHORITY_POSTGRES_DOCKER_TEST=1 \
  node_modules/.bin/mocha --no-config --no-package --fail-zero \
  --reporter ./scripts/execution-reporter.js --timeout 30000 \
  tests/tenant-authorization-postgres.integration.test.js
```

The tests use synthetic principals and data. They measure adapter and database
behavior only; authentication, principal verification, HTTP wiring, deployment
readiness/listener contracts, and production provisioning remain unmeasured.
The opt-in PostgreSQL suite also kills its owned container while an authority
pool has an idle connection, then verifies the pool error handler runs, the
next authorization query rejects as unavailable, and a child process exits
without an unhandled error.

## Current exchange metadata

The appended `0002_subject_display_name` candidate migration adds nullable
`display_name` to existing stable subjects. The first migration and checksum
are unchanged. Apply through the operator-only migration runner, never from a
serving process. Imported rows initially retain their IDs and have no invented
name. Preserve the exact shipping subject name on import, and update it on
rename together with the legacy presentation prefix (which still follows the
shipping name transformation). Name is display metadata, not identity. When
both namespaces use the same database, update both in one operator transaction.

`subjectSnapshot({tenant,principal})` is a read-only exchange adapter for a
verified subject. One fresh tenant-bound SQL statement reads current name,
roles, permission arrays and defaults. Missing subject/name returns null;
invalid or unavailable authority rejects. The response is `{sub,
permissionGroups}`, with arrays of permission strings as in shipping
authorization, not serialized Shiro objects. Role groups use the existing
role-name order, then defaults not already present. They are informational
response metadata, never cached authorization for a later data operation.
The separate exact-permission `authorize` callback remains mandatory for
protected GET. Table and column write privileges are refused at startup.

## Bounded subject administration

The append-only `0003_subject_management_metadata` migration adds nullable
notes/creation metadata and a redacted mutation audit table. The separate
[subject administration service](../subject-admin/README.md) updates existing
subjects and known-role links with legacy credential metadata in one transaction.
This authority reader remains read-only; serving credentials do not acquire
management grants or routes.

## Dormant selected owner ceiling

Both `postgres.js` and `access-postgres.js` accept the optional trusted constructor
argument `ownerPolicy: { catalogue: ['api:entries:read'] }`. No runtime configuration
selects this mode. Omitting the option retains the existing reader behavior and
does not read owner-policy tables.

Selected readers require subject identity and a concrete catalogue using the same
reviewed terminal operation universe as the subject-management writer. The current
catalogue digest and operator ceiling are joined into each existing authority SQL
statement. Effective groups are intersected with the code catalogue and that
snapshot's ceiling. Missing or mismatched policy, malformed/unknown permissions,
wildcard roles and the `readable` default refuse. `denied` and `status-only` retain
their defined concrete expansion within the intersection. The legacy reader
rejects root and anonymous principals in selected mode. The new-format reader
already requires subject/session claims; it does not acquire a root bypass.

Startup additionally requires nonownership, forced RLS and SELECT-only access to
the owner-policy table. The reader never edits stored grants. Code-catalogue
changes require explicitly matching operator digest preparation; unknown future
permissions do not silently enter effective authority. This bounds the current
tenant ceiling, not the current authority of whichever actor issued an old grant:
the subject-role assignment has no delegation lineage.

Selection and rollout require separate PostgreSQL, cross-worker revocation and
actual-client compatibility verification. The source probe
`node scripts/probe-owner-policy-clamping.js --selected --require-clamp` exercises
the dormant option using synthetic SQL responses only. It establishes no database,
client, production policy or performance acceptance.
