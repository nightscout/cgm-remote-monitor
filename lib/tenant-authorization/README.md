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
