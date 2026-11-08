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
| `OIDC_ACCESS_CONFIG` | Private operator-selected JSON file specifying the separate Nightscout access issuer, distinct data/management audiences, provisioned public keys and bound Transit signing references. Required only when OIDC is enabled. |
| `OIDC_TENANT_ORIGINS` | Multitenant only: JSON object mapping every configured tenant ID to its canonical HTTPS origin. Register each origin's callback at the provider. |
| `OIDC_POSTGRES_CONNECTION` | Multitenant only: explicit scoped session service connection from the environment. |
| `OIDC_NAMESPACE`, `OIDC_AUTHORITY_NAMESPACE`, `OIDC_ACCESS_NAMESPACE` | Multitenant only: distinct operator-migrated human, current authorization and access namespaces. |

No secret is derived from `API_SECRET`, and enabling OIDC never provisions a
human mapping or management entitlement. Apply the additive catalogue and
service grants before starting an opted-in multitenant role. Existing operator
readiness and lifecycle admission still apply; serving code never creates tables.

The access file is separate from the provider's OIDC discovery configuration:
provider ID tokens authenticate identity and never become Nightscout authority.
Its closed version1 shape is:

```js
{
  version: 1,
  issuer: 'synthetic-nightscout-human-access',
  audiences: { data: 'synthetic-human-data', management: 'synthetic-human-management' },
  vault: { addressEnv: 'OIDC_VAULT_ADDRESS', tokenEnv: 'OIDC_VAULT_TOKEN', mount: 'transit' },
  keys: [{
    tenant: 'single', purpose: 'data', kid: 'human-data-v1',
    publicKey: '<canonical base64 of32 provisioned Ed25519 public bytes>',
    current: true, signingKey: 'human-data', signingVersion: 1
  }, /* a distinct management key is also required */]
}
```

Use canonical UUID bindings for multitenant keys. The private single human
profile accepts only the literal auth scope `single`; this is not a clinical
tenant ID and never serializes or changes storage's `SINGLE_TENANT` symbol.
Per-site issuer, audience and public-key bindings isolate sites. Default and
multitenant verifiers remain UUID strict. Arbitrary validators or auth scopes
cannot be selected by configuration or request. Human and existing headless
issuer/audience namespaces must be disjoint; a recognized failed human proof
never falls back to machine or legacy authentication.

The access issuer is Ed25519/EdDSA through the configured private Transit sign
capability, separate from the existing legacy HMAC methods. The provider's
`OIDC_SIGNING_ALGORITHM` setting does not select the Nightscout access algorithm.
Provision non-exportable Ed25519 keys and sign-only service ACLs, and separately
admit their type, public-key binding and custody through operator proof. Serving
never reads or exports private keys. The current runtime token reference is the
development/staging environment seam; production additionally requires the
adopted service-login/lease-renewal adapter. Explicit `allowInsecureLoopback:true`
in the Vault object permits developer loopback HTTP only; staging/production use
HTTPS and their operator-managed CA configuration. No default-off dependency is
added. Existing access verification is local to provisioned public keys plus
current local authority, so Vault outage refuses new signing, not otherwise
valid current access. Current accepted keys remain an authoritative store fact,
not the `current` selection in this public verification/signing file.

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
then clears its cookie. The browser subsequently calls the configured provider
logout endpoint when available; provider failure never reverses local revocation.
If the current store is unavailable, local browser material is cleared but the
response explicitly reports local revocation unconfirmed.

The existing browser consumer probes the human session before selecting legacy
headers. Current local permission groups drive its display decisions; only the
server authorizes operations. While a human session is active or uncertain,
stored legacy secrets and URL credentials remain dormant. Explicit human Sign
Out uses durable logout and also forgets this browser's legacy material, without
revoking unrelated device credentials. An unconfirmed result remains visible and
cannot trigger a success reload or silently resume legacy authority. External
provider Sign In/Renew actions reuse the existing authentication dialog.

Provider capability details accompany the session response. A provider without a
verifiable logout signal is supported with its expiry/renewal limitation
disclosed. No Authentik or Kratos runtime acceptance is implied by these routes;
the selected provider configuration needs the adopted actual reference proof.

`createEngine({store,access,now})` exports `login`, `renew`, `authenticate`, `logout` and
`logoutProvider`. Time is server-side integer epoch seconds. Management access is
bounded to 600 seconds, its idle deadline to 1800 seconds and its absolute deadline
to 43200 seconds. Sensitive authorization refuses at authentication age 300
seconds. Data sessions have neither management idle nor absolute lifetime; human
data access tokens last 28800 seconds. Renewal requires verified provider proof
for the same issuer, subject and original provider session when supplied. An
expired access token may identify a still-live session for provider-backed
renewal; it never authorizes a protected operation. Renewal preserves original
authentication and absolute timestamps and never counts as management activity.

Access credentials use the adopted `ns-access+jwt` asymmetric profile through a
required issuer/verification capability. Production private signing remains
behind the configured secrets boundary; only provisioned public keys are used
for local verification. Persisted SHA-256 token hashes are secondary issuance
bindings, never a replacement for signature, issuer/audience, purpose, subject,
session, credential-generation and lifetime checks. Token key ID, issuance time
and expiry must match the verified claims exactly. Login checks its selected
current key; renewal checks both its old token key and its newly selected issuer
key inside the current authority/session transaction. Concurrent renewal can produce multiple
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

The adapter uses `createMongoStore({collection,tenant,consumer})` with
one operator-provisioned **single-site human-authority aggregate**, separate from
clinical storage's unchanged `SINGLE_TENANT` scope. The private authentication
binding is not a clinical tenant identifier. One document owns current accepted
signing-key state, human mappings/grants and sessions; accepted-key state is never
copied into each principal. No PostgreSQL or multi-document MongoDB transaction
is required. Synthetic provisioning shape:

The single serving collection is `human_authority` under the existing
`MONGO_AUTHENTICATION_COLLECTIONS_PREFIX` (default `auth_`). Its document ID is
`authorityId('single')`; it is provisioned privately before login is admitted.

```js
{
  _id: authorityId(privateSiteBinding),
  tenant: privateSiteBinding,
  revision: 1,
  keys: [{ kid: 'current_data_key', purpose: 'data', active: true }],
  principals: [{
    id: principalId(privateSiteBinding, configuredIssuer, providerSubject),
    issuer: configuredIssuer,
    providerSubject,
    subject: 'local_subject',
    consumer: 'oidc',
    enabled: true,
    generation: 1,
    credentialGeneration: 1,
    purposes: ['data'],
    permissionGroups: [['api:status:read']]
  }],
  sessions: [],
  logoutEvents: []
}
```

Login never inserts a principal or key. Adding `management` is an explicit local
management entitlement, distinct from legacy root/data wildcards. Every operation
checks current global key acceptance and that principal's current grants. Operator
edits increment `revision`; mapping generation or credential generation changes
invalidate existing sessions. Current key retirement affects the next protected
operation and provider-backed renewal, even with a valid signature and cached
provisioned public key. Logout may still invalidate its known session after
retirement without receiving a grant or issuance entitlement.

Primary majority reads and journaled-majority atomic replacement compare the
aggregate revision, global keys, principals, sessions and event history together.
A racing logout, key retirement or grant edit causes a fresh evaluation, including
when a signer call is in flight. Read-only authentication also commits a revision
CAS. An unavailable store refuses rather than serving a cached grant/key snapshot.

The implementation has defensive admission bounds of 64 principals, 128 sessions across
the site (32 per principal), 128 retained token selectors per session, 1024 retained
logout event IDs and 8 MiB serialized aggregate size. Exhaustion refuses rather
than evicting live selectors, grants or replay protection. Issuance may reclaim
revoked or expired management sessions. These are defensive bounds,
not measured operating capacity. Native acceptance of the new aggregate remains
UNMEASURED; earlier per-principal opaque-token results do not prove it.

## Multitenant PostgreSQL adapter

`await createPostgresStore({connectionString,namespace,authorityNamespace,
accessNamespace,consumer})` requires explicit multi mode and a non-superuser,
non-bypass-RLS connection. Apply `candidate.json` through the explicit migration
runner to the human-session namespace. Serving startup performs no DDL. The
catalogue adds RLS-forced `human_identities`, `human_sessions`,
`human_access_tokens` and `human_logout_events` tables. Additive migration
`0002_signed_access_binding` preserves the first catalogue and adds the token
key ID and issuance timestamp. Historical opaque-prototype rows have no key
binding and cannot authorize a signed-profile request; no opaque fallback or
backfilled invented signing key is allowed.

Operator-provisioned identity rows bind configured issuer/provider subject to a
current local subject and access credential, explicit purposes, enabled state
and generation. Current authority joins the existing access tenant/credential
and subject/role records in the session transaction, plus SELECT-only
`access_keys` state for every old and newly selected signing key. Issuance and
renewal require all selected keys to be currently accepted for the exact purpose.
An already-authorized operation may finish if key retirement commits while it is
in flight; the next protected operation obtains the current refusal. Management additionally
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

Earlier `nsh_` opaque-access prototype evidence is retained as a nonconforming
implementation result. It does not satisfy the adopted asymmetric access-token
contract. Signed-profile signature, issuance binding, current key retirement and
current-authority source controls are separate from that prototype capture.
Native persistence, actual private signing and actual browser evidence require
new attributed reserved execution.

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
It creates a randomly named collection, provisions only synthetic identity/grants/accepted keys,
and exercises the actual driver and aggregate adapter through two workers. Its
scheduling barrier retains actual database operations while forcing logout/grant
updates between a renewal/read and its CAS. It drops only the owned collection
and closes its independent clients. The engines run in one Node process and use distinct MongoClient pools; this is not a separate-process claim. Optional `HUMAN_SESSION_NATIVE_ENGINE` and
`HUMAN_SESSION_NATIVE_STORE` load physically mutated scratch modules for semantic
controls. These are instrument hooks, not production switches. Parse and lint
checks do not imply an actual MongoDB run.


`tests/human-access-vault-native.js` is a separately reserved, finite Vault
instrument. It refuses before transport without both native/Vault reservation
flags, explicit loopback service/admin credential and an exact single or UUID
authentication binding. It creates a unique owned Transit mount, nonexportable
Ed25519 keys and sign-only tokens, then consumes production configuration and
issuance. It checks forbidden read/export/mutation paths, unchanged legacy HMAC
behavior and local verification after deliberately revoking a still-valid
signing capability. Token revocation is a signer-refusal case, not proof of a
network outage. Owned tokens, policies, mount and public scratch configuration
are removed with verified closure; unknown outcomes fail.

Its optional awaited `consume({accessConfigPath,accessSource,tenant,mode})`
callback can run an explicitly bounded native HTTP child using the same private
sign-only capability. The callback receives no administrator capability. A
standalone Vault pass does not imply HTTP, browser or database acceptance;
claim those boundaries only from an actual attributed child run. The external
reservation must bound the entire composite and independently prove process,
listener and service closure. Inert guard tests perform no Vault transport.
