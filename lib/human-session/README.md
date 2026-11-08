# Optional human sessions

The common engine consumes verified provider identity and uses a separately
provisioned current local authority adapter. Provider identities do not provision
subjects, owner relationships, root authority or grants. Legacy credentials and
their existing exchange remain separate.

## Explicit serving configuration

`ENABLE=oidc` opts in; omitting it requires neither a provider nor the additional
session tables. Single mode uses the existing MongoDB connection and the fixed
internal binding `single`. The API preview and tenant-admin role use the same
protocol/lifecycle implementation with their PostgreSQL adapter. The realtime
role accepts the opt-in human cookie/bearer through its existing private API
authority bridge. Keep each role's ingress on the adopted trusted boundary.

The following values are private process environment settings. Do not put
secrets in tenant display settings, client extension configuration or committed
configuration files.

| Variable | Meaning |
|---|---|
| `OIDC_ISSUER` | Exact HTTPS issuer used for trusted discovery. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Provisioned confidential client; configure `client_secret_post` at the provider. |
| `OIDC_SIGNING_ALGORITHM` | Optional pinned ID/logout token algorithm: RS256 (default), PS256, ES256 or EdDSA. Unsupported algorithms refuse; no negotiated downgrade. |
| `OIDC_ORIGIN` | Exact canonical HTTPS origin, with no path or trailing slash. |
| `OIDC_COOKIE_KEY` | Canonical base64 encoding of 32 random bytes shared by workers serving the same origins. It seals pending browser flows and binds CSRF tokens; rotating it expires pending flows. |
| `OIDC_TENANT_ORIGINS` | Multitenant only: JSON object mapping every configured tenant ID to its canonical HTTPS origin. Register each origin's callback at the provider. |
| `OIDC_POSTGRES_CONNECTION` | Multitenant only: explicit scoped session service connection from the environment. |
| `OIDC_NAMESPACE`, `OIDC_AUTHORITY_NAMESPACE`, `OIDC_ACCESS_NAMESPACE` | Multitenant only: distinct operator-migrated human, current authorization and access namespaces. |

No secret is derived from `API_SECRET`, and enabling OIDC never provisions a
human mapping or management entitlement. Apply the additive catalogue and
service grants before starting an opted-in multitenant role. Existing operator
readiness and lifecycle admission still apply; serving code never creates tables.

The shared routes live under `/api/v2/oidc`: same-origin JSON POST `login` and
`renew`, GET `callback`, GET `session`, JSON POST `logout`, and signed provider
POST `backchannel-logout`. Login/renew accept `purpose` (`data` by default or
`management`) and `transport` (`cookie` by default or `bearer`). A start response
contains the trusted provider navigation location; it is not an access token.
The callback sets the purpose's host-only HttpOnly/Secure/SameSite cookie or
returns a direct bearer in a no-store JSON response. Neither token enters a URL.
Select the same purpose for `session` and `logout`. Cookie state-changing calls
require the exact configured Origin and the `x-ns-csrf` value returned by that
purpose's session response. Headless bearer callers remain independent of CSRF
cookies. A provider page handles user authentication; no password/recovery UI is
implemented here.

Management and data cookies coexist. Protected data requests never advance
management idle. Successful classified management routes advance idle without
moving the absolute/authentication clocks; secret reveal and privileged
credential/grant changes additionally require current authentication freshness.
Existing legacy sign-in/sign-out retain their separate browser-forgetting
meaning. Explicit OIDC logout invalidates only its selected local human session,
then clears its cookie and optionally returns a trusted provider logout location.
If the current store is unavailable, local browser material is cleared but the
response explicitly reports local revocation unconfirmed.

Provider capability details accompany the session response. A provider without a
verifiable logout signal is supported with its expiry/renewal limitation
disclosed. No Authentik or Kratos runtime acceptance is implied by these routes;
the selected provider configuration needs the adopted actual reference proof.

`createEngine({store,now})` exports `login`, `renew`, `authenticate`, `logout` and
`logoutProvider`. Time is server-side integer epoch seconds. Management access is
bounded to 600 seconds, its idle deadline to 1800 seconds and its absolute deadline
to 43200 seconds. Sensitive authorization refuses at authentication age 300
seconds. Data sessions have neither management idle nor absolute lifetime; human
data access tokens last 28800 seconds. Renewal requires verified provider proof
for the same issuer, subject and original provider session when supplied. An
expired access token may identify a still-live session for provider-backed
renewal; it never authorizes a protected operation. Renewal preserves original
authentication and absolute timestamps and never counts as management activity.

Access credentials contain 256 random bits. Persistence keeps their SHA-256
verifiers, not recoverable bearer copies. Concurrent renewal can produce multiple
valid access credentials bound to the same session. Durable logout invalidates
that session before any provider operation. Every protected operation reads
current local authority and session state. Call `authenticate` with `activity:
true` only for a successfully authorized qualifying management route. Background
data/stream delivery and renewal must pass `activity:false`. Management writes
still require their own mutation-time current authority/policy checks.

`logoutProvider({tenant,event})` accepts only the configured provider adapter's
verified issuer, event ID, issued-at and subject and/or provider-session binding.
Adapters atomically retain the event ID and invalidate matching current sessions;
duplicate delivery does not invalidate explicitly new sessions. A signal-less
provider has no immediate provider-origin revocation guarantee. Existing local
access remains bounded by its own expiry and current local authority.

## Single MongoDB adapter

`createMongoStore({collection,tenant,consumer})` takes an actual MongoDB driver
collection, a fixed internal single-site binding and trusted consumer spelling.
It requires no PostgreSQL or multi-document MongoDB transactions. One aggregate
document is authoritative for the opted-in human's explicit local mapping,
grants and sessions. It is not a cache of legacy subject roles. The operator
provisions the document; login never inserts it. Synthetic shape:

```js
{
  _id: principalId(fixedSiteBinding, configuredIssuer, providerSubject),
  tenant: fixedSiteBinding,
  issuer: configuredIssuer,
  providerSubject,
  subject: 'local_subject',
  consumer: 'oidc',
  enabled: true,
  generation: 1,
  revision: 1,
  purposes: ['data'],
  permissionGroups: [['api:status:read']],
  sessions: [],
  logoutEvents: []
}
```

Adding `management` is an explicit local management entitlement. Do not import
legacy root/data wildcards as management membership. All operator edits increment
`revision`; changing the mapping/credential generation increments `generation`
and invalidates existing human sessions. Grants are read directly from this
document at each operation. Primary majority reads and journaled majority atomic document
replacement compare mapping, grants, revision and sessions, so a racing logout or
grant change causes a fresh evaluation. Even read-only authentication commits a
revision CAS; an unavailable store refuses rather than serving cached grants.

Provision indexes on `{tenant:1,'sessions.tokens.hash':1}` and
`{tenant:1,issuer:1,'sessions.providerSession':1}` through operator migrations.
There are bounded admission limits of 32 live sessions per principal, 128 retained
access-token selectors per session, and 256 retained logout event IDs. Capacity
exhaustion refuses issuance/event processing with `HUMAN_SESSION_CAPACITY`; it
never drops live selectors or forgets replay protection to manufacture success.
Issuance reclaims revoked or already-expired management sessions. No operating
capacity is inferred from these defensive bounds. A sid-only event that maps to
multiple principal documents refuses as unsupported instead of selecting an
arbitrary identity. The configured provider must honor issuer-scoped session IDs.

## Multitenant PostgreSQL adapter

`await createPostgresStore({connectionString,namespace,authorityNamespace,
accessNamespace,consumer})` requires explicit multi mode and a non-superuser,
non-bypass-RLS connection. Apply `candidate.json` through the explicit migration
runner to the human-session namespace. Serving startup performs no DDL. The
catalogue adds RLS-forced `human_identities`, `human_sessions`,
`human_access_tokens` and `human_logout_events` tables.

Operator-provisioned identity rows bind configured issuer/provider subject to a
current local subject and access credential, explicit purposes, enabled state
and generation. Current authority joins the existing access tenant/credential
and subject/role records in the session transaction. Management additionally
requires an active `tenant_owner_actors` relationship for the configured
consumer. Data permissions remain the current subject roles and existing default
role policy; they never create management membership.

The service role needs SELECT on the four human tables and existing current
authority tables, INSERT/UPDATE on `human_sessions`, and INSERT on
`human_access_tokens`/`human_logout_events`. It must not own tables, bypass RLS,
write identity mappings or current grants, or DELETE/TRUNCATE them. Startup checks
table and column privileges and forced RLS. Session-row `FOR UPDATE` serializes
renewal, idle activity and logout. Tokens/events and session changes commit in
the same transaction with synchronous commit. Protected management mutations
retain the consuming service's policy/grant fence.

## Verification scope

`tests/human-session-lifecycle.test.js` exercises the actual engine and aggregate
adapter using a synthetic collection double, including concurrent CAS, current
grant changes, exact expiry boundaries, provider-session binding and durable
logout. Those checks do not constitute native MongoDB/PostgreSQL, HTTP, browser
or provider acceptance. Native consuming-boundary acceptance is a separate
reserved-runtime integration step. `HUMAN_SESSION_TEST_SOURCE` lets a negative
control load a physically mutated scratch copy of the engine; production code
contains no bypass switch.

`tests/human-session-postgres-native.js` is an explicit native instrument, excluded
from ordinary suite discovery. It needs reserved, isolated PostgreSQL admin and
non-bypass application identities in `HUMAN_SESSION_PG_ADMIN_URL` and
`HUMAN_SESSION_PG_APP_URL`. It creates uniquely named owned schemas, applies the
actual catalogues and exact service grants, runs two actual adapters and removes
only those owned schemas. It exercises current grants, RLS, explicit management
membership, two-worker logout, blocked renewal after committed revocation and
durable provider-logout replay. Preparing or parsing this instrument does not
constitute executing it.

`tests/human-session-mongo-native.js` similarly requires a reserved window
(`HUMAN_SESSION_NATIVE_RESERVED=1`) and an explicit `HUMAN_SESSION_MONGO_URL`.
It creates a randomly named collection, provisions only synthetic identity/grants,
and exercises the actual driver and aggregate adapter through two workers. Its
scheduling barrier retains actual database operations while forcing logout/grant
updates between a renewal/read and its CAS. It drops only the owned collection
and closes its client. Optional `HUMAN_SESSION_NATIVE_ENGINE` and
`HUMAN_SESSION_NATIVE_STORE` load physically mutated scratch modules for semantic
controls. These are instrument hooks, not production switches. Parse and lint
checks do not imply an actual MongoDB run.
