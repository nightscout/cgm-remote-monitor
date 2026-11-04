# Dormant tenant HTTP composition

`createTenantApp` and `createOperatorApp` construct separate Express applications.
They never listen, import global app state, change legacy startup, select a
database/provider, run migrations, or enable a `serve` role.

## Injected boundaries

The optional trusted `dataAccess({tenant, request})` port replaces only the
data plane's credential/current-permission callbacks. The dormant
[legacy credential/GET bridge](../../secrets/legacy-credentials.md) implements
this port for actual entries GET and POST, including anonymous policy and current
persisted Shiro authority. Owner/operator authentication remains unchanged;
other collections, history and addressed mutations explicitly refuse in that bridge.

The tenant constructor requires:

- `resolver`: the existing `lib/tenant-resolution` service. Configure public host
  aliases there for the default `direct-alias` mode, or explicitly configure
  `canonical-internal` names and a trusted immediate-peer predicate when an edge
  rewrites `Host`. Express proxy trust stays disabled; resolved-tenant headers
  never select a tenant or authorize callers.
- `verifyCredential({tenant, credential, plane})`: verify the Bearer credential
  **after** resolution, against that tenant's provisioned credential authority.
  Return authenticated `{tenant, principal, consumer}`, or null for refusal.
  The returned tenant must match. Throws fail closed with a sanitized 503.
  No principal/consumer is inferred from unverified claims or request bodies.
- `authorizeRequest(context, {plane, method, path})`: consult current authority
  on every request and return exactly `true` to permit it. The path is relative
  to the plane mount. It must distinguish owner from data permissions and
  refuse missing/revoked subjects; unavailable authority must reject. No JWT
  grants or cached authentication result substitutes for this callback.
- `tenantSettings` and `subjectPolicy`: existing service instances, including
  their own injected current-policy and management-authorization callbacks.
- `dataRouter`: tenant-aware Express middleware mounted **only** at `/api/v3`.
  It receives immutable `req.tenantContext`. Its storage and operation-level
  authorization must use that context; this seam does not adapt the legacy
  global-context API3 implementation or make it multitenant-safe.

Credential verification is deliberately an injected port, not a new token
issuer, token format, human-login system or principal mapping. An adapter using
`secrets.verifyJWT` must supply its trusted verifier service identity, map the
verified access-token subject, and check its current authority. The existing
subject-policy `authorize` method covers **secrets operations only**, not
data/owner HTTP permissions; it must not be used as a substitute HTTP ACL.

## Routes

| App | Method and path | Body |
|---|---|---|
| tenant owner | GET `/api/v1/tenant/settings` | none |
| tenant owner | PUT `/api/v1/tenant/settings` | `{expectedVersion, values}` |
| tenant owner | POST `/api/v1/tenant/settings/rollback` | `{expectedVersion, restoredFrom}` |
| tenant owner | GET `/api/v1/tenant/subject-policy` | none |
| tenant owner | PUT `/api/v1/tenant/subject-policy` | `{expectedVersion, grants}` |
| private operator | GET `/api/v1/operator/tenants/:tenant/policy` | none |
| private operator | PUT `/api/v1/operator/tenants/:tenant/policy` | `{expectedGeneration, policy}` |

These are full-document service operations, not patches. Request bodies cannot
override authenticated identity. Success returns the service result. Known
validation/refusal/conflict errors map to 400/403/404/409; unexpected failures
return only `AUTHORITY_UNAVAILABLE` (503), never exception messages, details,
credentials or stack traces. Responses are not cacheable.

The operator constructor requires a separately injected
`authenticateOperator(request)` returning authenticated `{principal, consumer}`
or null, plus `operatorPolicy`, whose injected `authorizeManagement` checks
management permission for the target tenant on every operation. The target
path is not proof of authority. No owner/data routes or tenant verifier are
installed in that app, and no operator service is supplied to the tenant app.
Deployment must bind this application to a **distinct private listener/role**
with isolated operator credentials, never mount it on the public app. Listener
and deployment integration remain dormant/out of scope.

HTTP coverage: `node_modules/.bin/mocha tests/tenant-app.test.js`.

## M3 entries HTTP integration lab

The opt-in integration tier test owns one disposable `postgres:16` Docker
container and one random-port loopback HTTP listener. It applies
`migrations/candidates/postgres-entries-v1.json` using the existing operator
migration runner, then connects through `postgres-connection` with a separate
`NOSUPERUSER NOBYPASSRLS` application role. It uses no external database,
persistent volume, production listener, or legacy startup path. Cleanup closes
its own HTTP server and pools, restores the prior tenancy mode, and removes only
its randomly named container.

Run from the CRM worktree:

```sh
NS_TENANT_HTTP_DOCKER_TEST=1 node node_modules/mocha/bin/mocha.js \
  --timeout 60000 tests/tenant-entries-http.integration.test.js
node node_modules/eslint/bin/eslint.js \
  tests/fixtures/tenant-entries-lab.js tests/tenant-entries-http.integration.test.js
node scripts/test-tiers.js check
```

Without that exact opt-in, the ten integration cases are pending and Docker is
not touched. The test binds aliases and provisioned random test credentials to
two UUID tenants. A one-client application pool exercises alternating and
concurrent requests without session tenant leakage. Fixtures have the same
`_id` and `identifier` in both tenants, plus tenant-only records. Assertions cover
own-tenant GET/PATCH/POST, explicit cross-tenant credential refusal, absent
foreign-only documents, rejected body/proxy selectors, committed distinct rows,
fresh app/pool reconnect, current-authority refusal, and sanitized fail-closed
HTTP responses for absent schema, pending migrations and checksum drift after
successful requests. Ledger changes for failure cases are fixture mutations,
not serving-side migrations. No operator application is mounted or started.

### Exact boundary and remaining work

`tests/fixtures/tenant-entries-lab.js` is a **test-only adapter**, not a mock
database/router and not a production API3 implementation:

- GET invokes the actual `lib/api3/generic/read/operation.js`, including API3
  authentication/permission checks, rendering and conditional-read handling,
  with request-local context and the M1 PostgreSQL reader.
- POST/PATCH use the actual API3 create/patch validators and purifier, then the
  existing `postgres-entries-intent` match/write operations. The latter owns its
  transaction and emits its intent event only after commit. The tenant binding
  comes only from immutable M2 `req.tenantContext`, never from JSON or selectors.
- Full legacy POST/PATCH handlers are **not** exercised: they construct
  `forCollectionIntent` directly around Mongo/cache-oriented storage, rather
  than accepting the M1 commit-owning step. Using them unchanged would lose
  that commit boundary; replacing the process-wide factory would affect legacy
  callers. The lab therefore adapts writes locally without changing those
  handlers or global authorization. POST requires a valid API3 document and
  rejects an existing identifier with 409; this is deliberately not legacy
  POST deduplication/acknowledgment response compatibility.
- Collection construction, search/history, PUT/DELETE, all response/header
  compatibility, HTTP date fallback, preconditioned writes, deduplication
  races, cache/socket consumers and non-entries collections remain unproven.
  The GET handler contains conditional-read support, but this lab does not
  assert it. Credentials/current HTTP grants are explicit fixture authorities,
  not a production issuer or durable policy integration.
- The lab invokes the real read-only migration `check` before binding its
  listener and on every data request, using the fixture's separate operator
  connection. Absent, pending or checksum-stale catalogues refuse startup; a
  catalogue that becomes stale after startup refuses requests. This proves
  ledger/checksum readiness, not detection of arbitrary physical schema
  tampering or a deployable readiness protocol. Production
  readiness/privilege separation needs its own design; serving must never run
  `migrate up`.

Local validation (2026-11-02): the opted-in Docker suite passed all ten cases;
the existing tenant-app/resolver suites passed 17 cases; focused ESLint passed.
This is bounded HTTP/storage isolation evidence, not release or production
multitenancy approval.

### Dormant tenant exchange and GET join

The optional trusted `exchange` callback mounts only
`GET /api/v2/authorization/request/:accessToken`. Construct it with
`require('./exchange')({secrets, authority, verifierContext})`. Trusted tenant
resolution precedes verification. Without that callback no exchange is mounted,
and default single startup is unchanged. The shipping exchange contract is measured
independently by `tests/authorization-exchange-contract.test.js`, using the
shipping authorization/storage/enclave modules, disposable MongoDB records and
HTTP requests. It covers path credentials, subject-only issuance, canonical
subject tokens, JWT renewal, response permissions/current display name,
current reloaded grants, expiry/removal and anonymous distinctions.

The response preserves `token`, `sub`, `permissionGroups`, `iat`, `exp`.
The path supplies the sole exchange credential; unrelated headers, query and
body fields are not authentication inputs, including AndroidAPS's empty-bearer
handshake. Accepted subject credentials and JWTs canonicalize inside secrets;
root credentials do not exchange. A missing/invalid/expired/removed subject
returns the shipping 401 status object, never anonymous defaults.

The response's `sub` is the exact current display name, not its stable ID or
token prefix. The appended operator-run `0002_subject_display_name` migration
in the [authority candidate](../../tenant-authorization/postgres-candidate.json)
adds nullable display metadata without rewriting the applied first migration.
Import exact names and update on rename; incomplete imports refuse exchange,
without invented names. Stable IDs remain identity. The fresh
`authority.subjectSnapshot` reads name, current role permission arrays and
defaults together; those response arrays do not confer future authority.
Current subject roles are ordered by role name, then defaults not already
present. Every protected GET checks current persisted Shiro grants again.

For this exchange issuer/verifier, explicitly configure the secrets component
maximum to **28800 seconds**. Issuance is exactly eight hours; a different
configured maximum refuses exchange. The existing tenant JWT envelope
`{accessToken,aud,iat,exp}` and signing provider remain unchanged, and provider
signing keys remain nonexportable. Expiry/duration validation is distinct from
next-request subject/credential revocation and grant changes. No single-site
JWT portability is presumed.

`tests/tenant-credential-http.integration.test.js` measures the exchange-issued
JWT -> actual entries GET join using persisted PostgreSQL/RLS authority,
credential metadata, secrets/audit and independently pooled adapters. It covers
cross-tenant refusal, canonicalization, names/rename/import completeness,
current grants, bad/unknown/expired/removed subjects, anonymous modes and
signing/audit/metadata outages. Its provider is synthetic; the real Vault
boundary campaign remains separate. Unit differentials compare shipping
canonicalization. This is not a pinned-client replay or deployment acceptance.

The same dormant bridge now admits the API3 entries list route
`GET /api/v3/entries`, as well as a single addressed entry GET. Both require
only the current `api:entries:read` authority; the reserved history route and
addressed mutations remain unsupported. The list route invokes the shipping generic
API3 search handler and its existing filter parser, projection, date resolution
and response renderer. Its PostgreSQL reader converts the shipping
`findMany` filter through `utils.parseFilter` and the shared filter AST, then
uses the bounded PostgreSQL compiler. It refuses unsupported filter/sort/
projection shapes rather than approximating MongoDB answers. Differential
coverage compares live MongoDB and tenant-bound PostgreSQL for pagination,
projection, validity filtering, missing/null/type behavior and ordering.
HTTP coverage uses exchange-issued JWTs, overlapping IDs with different
tenant data, current grants across separate pools, root/anonymous policy,
reserved history rejection and read-only outcomes. This remains a bounded
entries list/read slice, not full API3 or client acceptance.

## Dormant actual entries POST

The explicit `POST /api/v3/entries` path verifies the existing credential
carriers and awaits current `api:entries:create` and `api:entries:update`
checks before binding only the granted synchronous Shiro permissions.
The shipping create handler selects the exact permission from stored identity:
a miss requires create; a matched resend, including acknowledgement/refusal,
requires update. Root remains an internally verified principal; anonymous
never writes. Subject POST requires its current exact persisted display name
for attribution: incomplete name metadata returns 401, unavailable metadata
503. Existing GET does not acquire this metadata requirement.

Trusted code may construct a **separate Collection per tenant** with the
options from `entries.js`: combined PostgreSQL storage, an owned transactional
intent factory, submitted-document validation and a create-only error hook.
Neither request fields nor JWT claims select these options. Create, insert,
replace and configured autoprune use that factory. Without injected storage
the existing Mongo/cached construction and error handling remain unchanged.
Do not share a Collection's prune throttle or bus between tenants.

The data mount reuses API3's 50MiB JSON parser and existing malformed-body
response; the actual handler still requires its real purifier. Submitted
nonrepresentable documents return 400, recognized unavailable storage 503,
and unclassified/internal stored-shape errors retain 500. Unknown ordinary,
hyphenated and Unicode literal fields are retained in JSONB, including
configured merge resends. Dotted/operator mutation paths, NUL/unpaired-surrogate
text and lossy values remain refused; fields are never silently dropped or
coerced. This is bounded representation support, not all Mongo input or
pinned-client compatibility.

Configured retention keeps its existing asynchronous OR-of-age-fields
pruning and hourly per-tenant throttle, in a separate commit boundary; no
uploader delete grant is invented. Intent notifications occur after commit;
handler socket/data-received notifications retain their existing multiplicity.
These are local notifications, not durable cross-worker socket/evaluator
delivery. Matching, validation, current grants and writing are sequential
snapshots; already authorized operations may complete after a grant change.
No stronger race/precondition guarantee is implied.

Legacy single-site request extraction can discard invalid query/body tokens
(and unrecognized authorization schemes) before anonymous resolution. The test
records that conflict separately: shipping exchange itself refuses invalid
path credentials. Do not copy extraction's anonymous fallback into tenant
authentication, silently change single-site behavior, or treat a root
credential as a subject exchange credential. Strict invalid-supplied-credential
refusal is an intentional multitenant difference. Owner/operator planes remain
separate. No client, default startup, signing envelope or v1/v2 data route is
changed by this dormant exchange/GET join.
