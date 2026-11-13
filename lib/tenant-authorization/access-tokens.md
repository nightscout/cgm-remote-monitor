# Explicit multitenant local access-token verification

New-format tokens use Ed25519 signatures and `typ: ns-access+jwt`. The explicit
API preview accepts them through the same `data-access` admission, permission and
handler flow as legacy credentials. Default single and existing eight-hour
legacy exchange/HS256 verification are unchanged. There is no second REST stack.

## Configuration and operator preparation

In the explicit preview JSON, add `postgres.namespaces.access` naming a distinct
operator-prepared namespace, and an `accessTokens` object:

```json
{
  "issuer": "deployment-selected-issuer",
  "audience": "deployment-selected-data-audience",
  "keys": [
    {"tenant": "11111111-1111-4111-8111-111111111111", "kid": "version1", "publicKey": "BASE64_RAW_ED25519_PUBLIC_KEY"}
  ]
}
```

The public key is the canonical base64 encoding of the 32 public bytes. It is
public information, not a signing private key or shared HMAC secret. Tenant IDs
must already be configured. Duplicate key bindings/material refuse; tenants do
not share signing keys. The loader never fetches a request-selected key URL.
`accessTokens` absent preserves existing behavior. Invalid/partial configuration
or unsafe/missing schema refuses before binding; boot is read-only.

Apply the separate checksummed `access-candidate.json` through the existing
operator migration runner before startup. It is a candidate schema, not automatic
global migration discovery. The existing serving identity needs schema USAGE
and SELECT on access_tenants, access_credentials, access_sessions and access_keys;
it must not own tables, bypass RLS or mutate authority. Readiness needs its normal
schema/ledger inspection grants in this additional namespace. The independently
provisioned issuer/operator writes state; the API authority reader stays read-only.

Operator preparation binds tenant active status, a stable subject/credential ID,
credential generation, session ID/subject/credential/generation/expiry/purpose,
and accepted key ID/purpose. Credential and session generations must agree.
Sessions cannot cross a tenant/credential/subject composite foreign key. Subject
roles and current anonymous defaults stay in the existing authority namespace.

The new JWT contains `iss`, `aud`, `tid`, `purpose`, `sub`, `sid`, `cv`, `iat`,
`nbf`, `exp`. The trusted issuer signs inside the secrets provider. It must persist
the matching session/credential state before use. These claims contain stable IDs,
not the legacy raw accessToken or root secret. Data tokens are capped at eight
hours; management-purpose tokens are refused by the data verifier. Complete human
session/refresh issuance, owner ceilings and an automatic legacy-to-new exchange
rollout remain separate acceptance work; this path does not manufacture them.

## Current authorization and failures

After local cryptographic/claim validation, one tenant-bound PostgreSQL statement
reads current tenant/session/credential/key state, subject name and complete current
role/default permissions. Every handler permission and write attribution uses that
operation's snapshot. No authority snapshot survives into another request. The
snapshot's SELECT is the authorization linearization point: a prior authorized
operation may finish; the next one after committed revocation refuses.

The normal transaction foundation still uses BEGIN, tenant binding, SELECT and
COMMIT; one logical snapshot is not one wire message. Authoritative reads must
use the primary or an equivalently current deployment connection. No stale TTL
grant cache, lagging-replica revocation guarantee or pool-capacity claim is added.

Cached public keys allow ordinary new-token requests during Vault outage when
current PostgreSQL authority is available. Current key acceptance still fences
retirement. Unknown keys/invalid tokens refuse; PostgreSQL authority outage refuses
before data handlers; no legacy credential fallback occurs for a recognized new
token. Actual secret operations/legacy verification retain their Vault dependency.
Production key distribution/rotation, provider identity, cold-key handling, load
bounds and in-flight failure recovery remain deployment acceptance work.

`tests/multitenant-preview-process.integration.test.js` exercises the actual
executable/config/handlers with synthetic operator-prepared state, per-tenant
Vault-generated keys, independent processes, shared handler attribution, current
revocation, forced-RLS/privilege startup refusals and provider/database outages.
