# Tenant secrets boundary and Vault Transit adapter

Dormant implementation of the MT-SECRETS-CONTRACT slice. Nothing imports this
from serving roles, changes single-site `enclave.js`, enables an owner endpoint,
or selects a default provider. It does not complete MT-CONFIG-MIN or MIG-RUNNER.
The built-in encrypted signer remains an adopted, unimplemented option behind
the same interface; a cloud-key-service adapter can implement it too. Choosing
Vault here makes no comparative cost, efficiency or production-readiness claim.

## Component contract

`createSecrets` in `component.js` requires these injected boundaries:

| Dependency | Required behavior |
|---|---|
| `providerFor(tenant)` | Resolve a provisioned tenant to its bound provider. Unknown tenants and provider failures reject; never default to another tenant or a local signer. |
| `store.insert(record)` | Durably insert `{format: 1, tenant, id, ciphertext}` with unique `(tenant,id)`. Reject duplicates; never overwrite. No plaintext or signing keys. |
| `store.get(tenant,id)` | Tenant-bound exact lookup, returning that record or no record. Store isolation is required in addition to the component's envelope checks. |
| `authorize(identity,action)` | Check current authoritative state on **every** operation and resolve exactly `true` only when permitted. Unavailable current state rejects; no JWT-only or stale-cache authorization. |
| `audit(event)` | Await durable acceptance of a redacted audit event, or reject. The event records an **authorized attempt**, not successful completion. It contains identities, operation, optional reference ID and time, never credentials, tokens, ciphertext or revealed values. |
| `maxTokenLifetimeSeconds` | Required positive integer selected by trusted policy configuration, not an owner-supplied request. No implicit lifetime default. |
| `now()` | Optional clock returning epoch milliseconds; defaults to `Date.now`. |

The transport must authenticate `{tenant,principal,consumer}` before calling
the component. These are not trusted because they appeared in a JSON body.
Identifiers are nonempty ASCII alphanumeric/underscore/hyphen strings, at most
128 characters. Public owner route names, principal mappings and provider
credential acquisition are not settled by these internal method names.

Methods:

| Method | Authority and result |
|---|---|
| `encrypt(context,id,Buffer)` | `encrypt` permission; encrypt a tenant/reference-bound envelope, insert the immutable record and return `{tenant,id}`. |
| `decrypt(context,reference)` | `decrypt` permission for the named consumer/reference; return a Buffer only after authorization, audit and authenticated envelope validation. |
| `reveal(context,reference)` | Separate `reveal` permission and audit event, not an alias for the consumer permission. The eventual owner policy must refuse operator reveal and enforce its selected re-authentication policy. |
| `signJWT(context,accessToken,lifetimeSeconds)` | `sign` permission is **tenant-wide minting authority**, reserved for a trusted token issuer, not an owner-config permission. Return an HS256 JWT with `accessToken`, tenant `aud`, `iat`, `exp` and version `kid`. Reject lifetimes outside the configured bound. |
| `verifyJWT(context,token)` | `verify` consumer permission; verify signature/key version, tenant audience, algorithm, issued time, expiry and lifetime, then return only the selected claims. Invalid tokens reject; they never become anonymous/default authority. |

Authorization linearizes at the successful current-state `authorize` check.
An already-authorized in-flight operation may finish; the next operation must
consult current state again. Two component instances must use the same
authoritative service, not separate worker-local grants. JWT verification
identifies an access-token subject; its **current grants must still be checked
on the next protected data/config/socket operation**. This module does not wire
those operations or claim distributed/socket revocation acceptance.

Ciphertext contains the tenant and immutable reference inside authenticated
plaintext, so copying a ciphertext to another reference is refused. Rotation
creates new provider key versions without rewriting records or exporting keys.
Reference deletion, credential replacement/revocation, CAS updates, rewrap and
provider relocation need separate storage/lifecycle contracts.

## Provider-neutral cryptographic interface

A tenant-bound provider exposes:

```text
signingVersion                         positive integer, operator-controlled
encrypt(Buffer) -> opaque ciphertext string
decrypt(ciphertext) -> Buffer
sign(Buffer) -> 32-byte HS256 MAC at signingVersion
verify(version, Buffer, 32-byte MAC) -> boolean
```

Failures reject, with sanitized errors; only a genuine signature mismatch
returns false. No operation exports key material. Ciphertext is opaque to the
component, and request callers cannot choose provider key paths. Providers must
support verification of permitted earlier signing versions. The component's
versioned JWT envelope is new: preserving `accessToken` and HS256 is not a
claim that legacy keyless-`kid` tokens, socket forms or root-header auth are
already integrated.

## Vault adapter

`createVaultTransit` requires a trusted HTTPS origin, one Transit mount,
separate provisioned data/signing key names, an explicit signing version and
an asynchronous `getToken` credential callback. Explicit loopback HTTP is
test-only. Redirects are refused. Fetches have a bounded timeout. Provider
errors/bodies and credential-callback failures are redacted; there is no
provider fallback. The adapter never creates, exports, reads or rotates keys.

Provision non-exportable keys and grant only:

```text
path "<mount>/encrypt/<tenant-data-key>" { capabilities = ["update"] }
path "<mount>/decrypt/<tenant-data-key>" { capabilities = ["update"] }
path "<mount>/hmac/<tenant-signing-key>" { capabilities = ["update"] }
path "<mount>/verify/<tenant-signing-key>" { capabilities = ["update"] }
```

The test uses AES256-GCM96 Transit keys (including Transit HMAC support).
The adapter converts Vault's versioned base64 HMAC to/from JWT base64url.
An operator rotates keys separately, then replaces the bound provider with
the new signing version. Do not retire a required old key version before its
tokens expire and ciphertext has been migrated. Transit stores **keys**, not
the application ciphertext records.

Provider ACLs do not establish Nightscout membership: broad Vault credentials
can bypass this component and reach every permitted key. Production identity,
credential scoping/renewal, TLS, persistence, unseal/recovery, HA, outage
operations, durable audit/storage adapters, public routes, root credentials and
end-to-end consumer wiring remain acceptance work. No real data is used.

## Validation

```sh
NS_VAULT_DOCKER_TEST=1 node_modules/.bin/mocha --fail-zero --timeout 30000 \
  tests/secrets.test.js tests/vault-secrets.integration.test.js
node_modules/.bin/eslint lib/secrets tests/secrets.test.js \
  tests/vault-secrets.integration.test.js
npm run test:tiers
```

The integration suite owns and removes a disposable loopback-only Vault
container pinned by image digest. It uses synthetic random credentials, no
persistent volume, and in-memory **test-only** store/audit adapters. Without
the opt-in variable, Vault tests are pending, not acceptance. Tests cover
tenant/reference substitution, named consumers, audit/authorization outages,
JWT versions/expiry, redirects/redaction, real scoped Vault calls, rotation,
revoked provider credentials, and an overbroad-provider-credential red control.

Measured 2026-11-02: **19 passing, zero pending** with the opt-in Vault suite;
ESLint reports zero errors/warnings and the tier check classifies all 463 test
files. Removing the actual component's authorization refusal makes the
cross-instance revocation test fail with `Missing expected rejection`;
restoring it passes. The owned Vault containers were removed after both runs.
These results establish this dormant boundary only, not a durable-store,
distributed-authorization or production-Vault acceptance result.

## PostgreSQL persistence continuation

`createPostgresSecrets({connectionString, namespace})` in `postgres.js` returns
`{store, audit, close}` for injection into `createSecrets`. This is an optional,
dormant PostgreSQL adapter, not a requirement on every secrets provider.
It requires explicit multitenant mode and canonical lowercase UUID tenant IDs.
No mode, schema, role or migration is changed by constructing it.

The adapter owns a private application pool using the existing tenant-bound
transaction foundation. Each insert and audit call commits independently,
with `synchronous_commit=on`, before resolving. In particular, audit must not
join a caller's uncommitted transaction: an independent connection can observe
the authorized-attempt row before the provider runs, and rolling back the
caller's transaction does not remove that row. Database/fsync/storage and
replication configuration still determine deployment durability; this is not
a disaster-recovery or failover acceptance claim.

The records table enforces immutable `(tenant_id,id)` uniqueness, format 1,
and ciphertext of at most 1 MiB. Duplicate writes reject with
`SECRETS_REFERENCE_EXISTS`; driver error details are redacted. Reads return
only that tenant/reference, or no record. Audit accepts only the contract's
exact fields and valid operation/reference combinations, refusing additional
payload fields rather than logging them. The application has INSERT-only audit
access: it cannot read, alter, delete or truncate audit records. This is not a
cryptographically tamper-evident log, and database operators remain privileged.

Startup refuses superuser/BYPASSRLS identities, table owners/members of owner
roles, missing tables, disabled/unforced RLS, missing INSERT/record SELECT,
audit SELECT or table-wide mutation privileges. These checks are a safety
screen, not proof of every PostgreSQL policy, column-level grant, role
relationship, server setting or migration checksum. Use the reviewed catalogue
and least-privilege deployment review; the app must not control the schema,
role grants or RLS policies.

### Explicit operator migration candidate

`postgres-candidate.json` is a checksummed **experimental** catalogue for a
dedicated secrets namespace. It is not a production-approved catalogue or a
global Nightscout schema baseline. It creates `secret_records` and
`secret_audit` with forced tenant RLS, without granting an application role.
There is no boot migration. After reviewing this candidate, an operator can
exercise it only against a disposable lab database:

```sh
# NS_SECRETS_MIGRATION_URI must be an explicit, direct operator connection.
node bin/nightscout.js migrate up --backend postgres \
  --namespace ns_secrets_lab --catalogue lib/secrets/postgres-candidate.json \
  --connection-env NS_SECRETS_MIGRATION_URI --direct
node bin/nightscout.js migrate check --backend postgres \
  --namespace ns_secrets_lab --catalogue lib/secrets/postgres-candidate.json \
  --connection-env NS_SECRETS_MIGRATION_URI --direct
```

Separately provision a non-owner `NOSUPERUSER NOBYPASSRLS` application login.
Using its actual role name in place of `secrets_app`, grant only:

```sql
GRANT USAGE ON SCHEMA ns_secrets_lab TO secrets_app;
GRANT SELECT, INSERT ON ns_secrets_lab.secret_records TO secrets_app;
GRANT INSERT ON ns_secrets_lab.secret_audit TO secrets_app;
```

The operator connection never belongs in the application pool. Grant review,
schema ownership/default privileges, baseline/import, catalogue distribution,
backup/restore, retention/export, credential replacement/deletion, and serving
schema-compatibility wiring remain separate work. There is deliberately no
application audit-reader API or broad lifecycle mutation method.

### Combined persistence acceptance

```sh
NS_SECRETS_POSTGRES_DOCKER_TEST=1 NS_VAULT_DOCKER_TEST=1 \
  node_modules/.bin/mocha --fail-zero --timeout 30000 \
  tests/secrets.test.js tests/vault-secrets.integration.test.js \
  tests/postgres-secrets.integration.test.js
node_modules/.bin/eslint lib/secrets tests/secrets.test.js \
  tests/vault-secrets.integration.test.js tests/postgres-secrets.integration.test.js
npm run test:tiers
```

Measured 2026-11-02: **30 passing, zero pending**; ESLint has zero errors or
warnings, and all 464 test files are classified. The operator runner applies
and checks the actual candidate in disposable PostgreSQL 16. Tests cover two
independent adapters, overlapping tenant IDs, a competing insert, unbound and
foreign-row RLS refusals, append-only audit privileges, startup refusals,
audit-before-provider visibility, caller rollback, database restart, and a
real scoped-Vault ciphertext persisted/reopened/revealed through PostgreSQL.
Stopping Vault makes the component refuse decrypt, without fallback. Disabling
the actual records RLS exposes the other tenant's rows to an omitted-predicate
query; startup refuses that broken configuration. All owned containers are
removed.

The first restart check failed because Docker reassigned its ephemeral host
port; the harness now rediscovers the port before reconnecting. The corrected
combined run is the reported result. The restart is a database/container
restart on existing container storage, not a volume backup/restore or
power-loss experiment. Vault remains a disposable development server.

These are persistence and boundary checks, not distributed authorization,
owner-policy API, HTTP/socket consumers, human identity, evaluator/events,
MIG-RUNNER MongoDB support, or production-Vault acceptance.
