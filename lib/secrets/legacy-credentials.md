# Dormant tenant legacy credential verifier

This is the first credential/entries-GET bridge, not an enabled server role,
owner/operator authenticator or complete API surface. The optional dormant
exchange/GET join below reuses the same credential boundary.
Single-site enclave, authorization, startup and JWT issuance are unchanged.

## Trusted import and current state

`legacy-credentials-candidate.json` is a **new, separate operator-run**
catalogue. It does not replace or alter existing checksummed catalogues.
Apply it explicitly in its own non-system namespace, then grant the serving
identity SELECT only on its two tables. Check migration readiness before
composing a serving application; the reader never migrates. Existing candidate
catalogues remain necessary for secrets, current authorization and entries.

- `legacy_credential_config` binds a tenant to an operator-provisioned existing
  secrets reference ID. There is no conventional root-reference name, HTTP
  root selector, root plaintext column, signing key or default root.
- `legacy_credential_subjects` stores the imported stable subject ID and
  `token_prefix`: exactly the shipping subject name transformation
  `name.toLowerCase().replace(/[\W]/g, '').substring(0, 10)`.
  This prefix is credential-compatibility metadata, **not identity**. It may
  be empty or contain underscores. Preserve the existing subject `_id` text
  (ObjectId hex where applicable) in both this table and current authority.
  Prefix changes must follow the existing credential/name semantics; no new
  display-name-based principal is created.

Provisioning must preserve the tenant's imported root authority and stable
subject IDs to preserve derived credentials; rotation is not required.
Identifiers outside the existing authority's supported ASCII ID contract
must be refused during import, not silently rewritten. No importer or owner
provisioning endpoint is implemented here.

`legacy-postgres.js` is a private-pool read-only forced-RLS reader. Its fresh
single-statement snapshot selects the reference and subject metadata for
 credential verification. Missing metadata, references, unsafe privileges
or unavailable current state refuse; no previous success is cached.

## Secrets operation

Inject `legacyAuthorityFor(tenant)` into `createSecrets`, backed by that
reader's `read(tenant)`. `verifyLegacyCredential(context, {apiSecret, token})`
returns only `null` or an internal principal:

```text
{ kind: 'anonymous' }
{ kind: 'root' }
{ kind: 'subject', subjectId }
```

Only an entirely absent credential is anonymous. A supplied empty, malformed,
unknown or expired credential never becomes anonymous. Invalid credentials
return null; authority/provider/audit errors reject.

The verifier decrypts the current trusted root reference **inside the secrets
boundary**, using the existing current-authority/audit-protected `decrypt`
operation. The calling service needs narrowly scoped decrypt and JWT verify
capabilities, not owner reveal or data Shiro grants. Its durable decrypt audit
records an authorized attempt, not authentication success. Root bytes are
cleared after deriving the hashes and never returned to the HTTP bridge.

Root verification and subject derivation reproduce `enclave.js` and
`authorization/storage.js`: root SHA1/SHA512 verification, SHA1 of the root
SHA1 concatenated with the immutable subject ID, the existing subject token
prefix, and the accepted subject token/hash/digest-prefix lookup forms. A
signed JWT's `accessToken` is looked up against **current** subject metadata;
names, arbitrary subject claims and a string `root` do not identify a root.
Ambiguous credential matches refuse rather than select another subject.

This does not use or reinterpret the provider's signing/HMAC operation as
legacy root hashing. Vault Transit HMAC is not the shipping derivation.
Existing provider decrypt can supply an encrypted imported root internally;
provider signing keys remain nonexportable. No plaintext fallback, new root
scheme or provider choice is introduced.

The existing tenant secrets JWT verifier/envelope is unchanged. Preexisting
single-site JWTs with unrelated keys/envelopes are not assumed portable.
Legacy raw subject/root credential compatibility is not a claim that the
tenant exchange route or every preexisting JWT deployment has client-cohort
acceptance.

## GET bridge and linearization

Inject `createDataAccess({secrets, authority, verifierContext})` as `dataAccess`
into `createTenantApp`; `verifierContext(tenant)` is a trusted service identity
callback. Trusted host/proxy resolution runs first. This data-only callback
does not replace owner/operator authentication.

The first bridge supports only `GET /api/v3/entries/:identifier`, using existing
Bearer JWT and `api-secret` credential headers. Duplicate or malformed
credential headers refuse. All other data operations explicitly return 405.
Legacy v1/v2 query/body credential carriers are explicitly refused here,
never mistaken for anonymous requests; API3's shipping authenticator does not
consume those carriers. No new exchange URL, query/body credential convention, JWT format or mutation
permission rule is introduced. Existing single routes remain unchanged.

After verification the bridge awaits
`authority.authorize({tenant,principal,permission:'api:entries:read'})`.
The existing authority's single SQL statement snapshot is the data permission
linearization point. It unions current subject and anonymous-default roles,
requires current tenant configuration for root, and enforces the anonymous
no-write floor. A credential snapshot and a permission snapshot are sequential,
not one atomic cross-store transaction: a verification already in flight
may finish after a reference change. A request begun after committed
reference/grant removal performs new reads and refuses. No stale-success
window/cache is configured.

Only after that asynchronous check succeeds does a module-private WeakMap
bind the actual request object to a synchronous Shiro containing exactly
`api:entries:read`. The real API3 authentication/GET handler consumes that
binding. Nothing reads a request property, name, header or JWT as an internal
principal, and no Promise is passed to synchronous Shiro checks.

Anonymous `denied` and `status-only` cannot read entries; `readable` can.
Status serving itself remains unsupported by this entries-only bridge.
Owner routes still require their existing authenticated boundary; a tenant
data root credential is not owner/operator authentication.

## Focused validation

The optional exchange callback is documented in the
[tenant application](../server/tenant-app/README.md#dormant-tenant-exchange-and-get-join).
`exchangeLegacyCredential(context,credential,currentSubject)` reuses the verifier
and keeps its canonical derived token inside a private per-principal map.
It refuses root/anonymous, awaits the trusted current-subject callback, signs
through the authorized/audited provider, verifies the issued envelope, and
returns only `{token,iat,exp}`. That callback obtains current name and permission
arrays from the persisted authority; it is not supplied by an HTTP client.
This issuer/verifier requires an explicit eight-hour maximum and issues exactly
eight-hour tokens. Current grants and revocation are checked independently
on each subsequent GET, not copied from the exchange response or JWT.

The serving service needs decrypt, verify and sign capabilities, not root
reveal or an owner permission. Signing keys remain nonexportable. No client,
JWT format, single-site path or v1/v2 data route changes follow.

```sh
NODE_ENV=test node_modules/.bin/mocha --no-config --no-package --fail-zero \
  --reporter ./scripts/execution-reporter.js \
  tests/tenant-legacy-credentials.test.js
NS_TENANT_CREDENTIAL_HTTP_DOCKER_TEST=1 NODE_ENV=test \
  node_modules/.bin/mocha --no-config --no-package --fail-zero \
  --reporter ./scripts/execution-reporter.js --timeout 90000 \
  tests/tenant-credential-http.integration.test.js
```

The first suite compares actual shipping enclave/storage derivation and lookup
on synthetic identities. The second runs actual encrypted PostgreSQL secrets
records, persisted credential metadata/current Shiro authority, independent
worker pools and real loopback HTTP GET/storage/conditional responses. Its
synthetic service capabilities and in-memory nonexporting crypto provider are
explicit lab dependencies, not production Vault/service-policy acceptance.
The lab never enables a listener through CLI/default startup.

Full REST, POST/PUT storage-branch permissions, client-cohort coverage,
concurrent cross-process revocation races, owner/operator/lifecycle APIs,
production credential import, provider recovery and complete milestone
promotion remain outside this slice.
