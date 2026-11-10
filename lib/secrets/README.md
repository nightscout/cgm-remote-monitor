# Tenant secrets boundary and Vault Transit adapter

Dormant implementation of the MT-SECRETS-CONTRACT slice. Nothing imports this
from serving roles, changes single-site `enclave.js`, enables an owner endpoint,
or selects a default provider. It does not complete MT-CONFIG-MIN or MIG-RUNNER.
The built-in encrypted signer remains an adopted, unimplemented option behind
the same interface; a cloud-key-service adapter can implement it too. Choosing
Vault here makes no comparative cost, efficiency or production-readiness claim.

## Component contract

The dormant [legacy credential verifier](legacy-credentials.md) adds an
optional trusted current-reference/subject-metadata port and a data-only
entries-GET bridge. It does not change the JWT envelope, export signing keys
or enable roles or owner authentication. The optional dormant tenant exchange
composition is described in [legacy credentials](legacy-credentials.md).

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
| `issueLegacyCredential(context,subjectId,withCurrentSubject)` | Sensitive trusted management issuance only: `issue-legacy` permission and durable redacted attempt audit. Derives the existing canonical raw subject credential behind the encrypted root boundary; returns only `{token}`. The wrapper fences current management/delegation/subject/credential state until transaction commit; no root or signing key leaves secrets. |
| `exchangeLegacyCredential(context,credential,currentSubject)` | Trusted issuer only: verify the path credential against current imported tenant metadata, refuse root/anonymous, await the current-subject callback, and sign the canonical subject token inside secrets. Returns only `{token,iat,exp}`. Requires an explicitly configured maximum of 28800 seconds and issues exactly that duration. |

Legacy issuance additionally requires a trusted `withCurrentSubject({tenant,subjectId}, issue)`
wrapper. It must validate current owner/actor and grant ceilings, hold subject and
credential locks across `await issue()`, write its redacted success audit in that
transaction, and return the exact callback result only after commit. A failed
commit cannot release the token. The component independently loads current
trusted tenant credential metadata, requires a matching subject, performs separate
`issue-legacy` authorization/audit before decryption and clears decoded root bytes.
Possessing data, decrypt or root authority does not imply issuance permission.
The management transport must enforce the adopted five-minute authentication
freshness before sensitive issuance; this component receives no unauthenticated
freshness claims. Reissuance exposes the same existing bearer credential, so it
uses this sensitive boundary rather than treating a legacy hash as harmless.

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
Reference deletion, consumer credential cutover/revocation and provider
relocation need separate storage/lifecycle contracts. Ciphertext-only rewrap
and CAS are defined in the rotation continuation below.

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
Append-only `0003_secrets_legacy_issuance` admits the separate `issue-legacy`
authorized-attempt audit operation and requires its encrypted root reference.
Earlier migration bytes/checksums, rewrap target-version constraints, forced RLS
and application grants remain unchanged. Apply it explicitly before composing
owner credential issuance. The exact-reference subject policy also treats
`issue-legacy` independently from `decrypt` and `reveal`.

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

## Rotation continuation: audited ciphertext rewrap

The optional provider method `rewrap(ciphertext,targetVersion)` returns an
opaque ciphertext under an explicit positive integer encryption-key version.
Vault rewraps internally: no plaintext or key material is returned to the
component. It refuses key downgrade and unexpected response versions. For an
already-current ciphertext, it still calls Vault to validate authority and the
ciphertext, then returns the original bytes so a completed retry is stable.
Provider outages and revoked credentials therefore refuse even on retries.
This operates on versions of the **same provisioned key**, not another key path
or provider.

`component.rewrap(context,reference,targetVersion)` requires separate current
`rewrap` authority and awaits an audit attempt containing the reference and
`targetVersion`. The provider rewrap runs before
`store.compareAndSwapCiphertext(tenant,id,expected,replacement) -> boolean`.
That update must compare the old ciphertext and commit the replacement as one
operation. False means `SECRETS_REWRAP_CONFLICT`; callers explicitly reload and
retry. The reference and encrypted logical value stay unchanged. A missing
capability rejects with `SECRETS_OPERATION_UNSUPPORTED`. Ordinary stores have
no CAS method; maintenance stores have no insert method.

Use `createPostgresSecretsMaintenance` with a **separate** non-owner login:

```sql
GRANT USAGE ON SCHEMA ns_secrets_lab TO secrets_maintenance;
GRANT SELECT, UPDATE (ciphertext) ON ns_secrets_lab.secret_records TO secrets_maintenance;
GRANT INSERT ON ns_secrets_lab.secret_audit TO secrets_maintenance;
```

Do not grant INSERT on records, table-wide UPDATE or mutation of
`tenant_id`, `id` or `format`. The adapter verifies its expected role shape,
including column UPDATE grants, and refuses swapped ordinary/maintenance
identities. Raw database credentials still confer their granted privileges:
CAS and audit are component behavior, not a database rule against a compromised
maintenance credential. Keep this identity off owner/data request paths.

The matching Vault credential needs only:

```text
path "<mount>/rewrap/<tenant-data-key>" { capabilities = ["update"] }
```

It needs no encrypt/decrypt/HMAC/key-management permission. Operator key
rotation is still explicit and external to this component.

### Post-deletion key destruction custodian

`createVaultTransitCustodian({address,getToken,keyAllowed})` is the operator
credential the tenant lifecycle uses after the 30-day retention window
([lifecycle README](../tenant-lifecycle/README.md#post-deletion-key-retention)). It
sets `deletion_allowed`, deletes each key, and confirms absence by a lookup that
distinguishes 404 from 403. `keyAllowed({tenant,mount,name})` must admit each key
from trusted provisioning before any provider call. Its policy names only the
tenant's keys:

```text
path "<mount>/keys/<tenant-key>/config" { capabilities = ["update"] }
path "<mount>/keys/<tenant-key>"        { capabilities = ["read", "delete"] }
```

The serving credential never holds these capabilities. Errors carry only fixed
codes. Deleting a Transit key is irreversible. The append-only
audit records **authorized attempts**, including failed/conflicting/no-op
rewraps, not an outcome or proof of fleet-wide completion.

The candidate catalogue appends `0002_secrets_rewrap`, preserving `0001` and
its checksum. It adds the `rewrap` audit operation and constrained
`target_version` column. Run the existing explicit operator migration/check
before this adapter version; it does not migrate at boot. Tests apply `0001`
first and then upgrade through the actual runner, rather than silently
replacing already-applied DDL.

Failure/retry rules:

- Provider failure or refused database update leaves the original stored
  ciphertext; retain old key versions and retry explicitly.
- Concurrent updates have one CAS winner; a stale worker refuses rather than
  overwriting the winner.
- A lost reply after commit has an uncertain outcome. Reload and retry at the
  same target version; the stored bytes and immutable reference remain stable.
- Reject downgrades. Never retire an old key version based on one successful
  rewrap: inventory all live records, in-flight operations, signing tokens,
  backups and recovery requirements first. There is no automatic retirement.

Replacing a connector's actual credential is different: call `encrypt` with a
**new reference ID** and new plaintext, then use the consuming configuration
API's version/precondition to switch its reference. Do not overwrite the old
reference or claim this rewrap method revokes that old credential. Atomic
consumer cutover, rollback and upstream credential revocation remain deferred
to the configuration/integration lifecycle.

The combined command above covers real Vault rewrap persisted through
PostgreSQL, a rewrap-only provider ACL, ciphertext-only DB privileges,
competing workers, pre-commit refusal and a simulated lost reply **after the
real CAS commits**. That is an interrupted-call test, not a process-SIGKILL
proof. A disposable key-retirement control shows old ciphertext refuses while
the rewritten reference still reveals the same synthetic value. The initial
privilege probe exposed PostgreSQL `name[]` being returned as text by the
driver; selecting `text[]` makes the column-grant comparison type-correct.
No production key version is retired.

Measured 2026-11-02: **33 passing, zero pending** in the combined secrets,
Vault and PostgreSQL suite. ESLint reports zero errors/warnings; all 464 test
files remain classified. The owned disposable databases and Vault containers
are removed. This completes the bounded rewrap slice, not backup/restore,
process-crash acceptance, consumer credential cutover or production readiness.

## Synthetic backup/restore and process-crash acceptance

The combined command above now includes a recovery lab in
`tests/postgres-secrets.integration.test.js` and an isolated child worker in
`tests/fixtures/secrets-rewrap-worker.js`. Both Docker opt-ins remain required.
It changes no production code, existing migration/checksum, entries adapter or
runtime consumer. The worktree was fast-forwarded to integration `6943dccb`
before this continuation.

### Backup/restore boundary

The lab creates two non-dev, single-node Vault Raft servers using the pinned
image above, loopback-only published ports, test-only HTTP and disposable
container storage. It initializes each independently and retains synthetic
root/unseal credentials only in the test process. Non-exportable Transit keys
are provisioned explicitly by the fixture; the application adapter still
does not provision or export them.

With test writers quiescent, the lab takes actual encrypted Raft snapshots
before and after rotating both data and signing keys, plus a PostgreSQL
custom-format `pg_dump` of ciphertext, audit and migration state. Archives stay
in process memory and are never committed. The source Vault is removed before
snapshot recovery. The database archive is restored using
`pg_restore --exit-on-error` into a distinct empty database, and the explicit
operator runner checks its restored catalogue state.

Acceptance checks:

- Every stored reference, ciphertext and audit event is identical immediately
  after database restoration. Restored RLS still hides unbound/foreign rows;
  ordinary credentials cannot read audit or update ciphertext.
- Ciphertext without its data key refuses, using a fixture credential whose
  key lookup confirms absence rather than merely an ACL denial.
- Restoring the older Vault snapshot recovers version-1 ciphertext and JWTs,
  but explicitly refuses version-2 ciphertext and signatures.
- Restoring the complete snapshot with the retained source unseal credential
  recovers both data/signing versions. Original immutable references reveal
  the original synthetic values; earlier/current JWTs verify through scoped
  credentials. Keys remain non-exportable.
- Original audit events remain intact, new attempts append, and removing the
  recovered Vault causes provider-unavailable refusal without fallback.

This is a logical database and single-node encrypted-key snapshot rehearsal,
not a deployment backup product. The restored database shares the disposable
PostgreSQL cluster: roles/passwords already exist, and `pg_dump` does not back
up cluster globals. Production role provisioning, authenticated transport,
current authorization state, external credentials and consumer configuration
are not recovered here. The lab retains the required unseal credential
separately; it does not prove recovery without it, credential-renewal behavior,
HA, coordinated online snapshots, remote archive integrity/retention,
RPO/RTO, disk/power-loss durability or fleet-wide key-retirement readiness.
The single-share unseal setup and forced snapshot restore are lab-only.

### Actual worker termination and retry

The worker uses the real component, scoped rewrap-only Vault credential,
maintenance-only PostgreSQL identity and committed audit adapter. Parent/child
IPC carries synthetic fixture credentials, never command-line arguments.
The parent waits for explicit checkpoints and sends **SIGKILL** to that owned
child, then asserts its exit signal:

- After Vault rewrap/audit, **before CAS**: the original ciphertext and durable
  authorized-attempt audit remain. A new process reloads and completes rewrap.
- **After the actual CAS resolves following commit**, before the component
  returns: the new ciphertext and audit survive termination. A new process
  retries the same target version and preserves committed ciphertext bytes.

Both paths preserve the reference/value and append a separate retry attempt.
Checkpoints wrap the actual adapter call, not a simulated database result.
A mutation that skips CAS only in the post-commit worker makes acceptance fail
because the stored ciphertext is still version 4 instead of version 5.
Restoring the actual CAS passes. This tests application-process termination
at those two boundaries, not a kill during PostgreSQL commit, database/Vault
process failure, host failure or a completed consumer credential cutover.

Measured 2026-11-02 on integrated baseline `6943dccb`: **34 passing, zero
pending** in the combined secrets/Vault/PostgreSQL command. ESLint reports
zero errors/warnings, all **465 test files** are classified, and
`git diff --check` passes. The initial Raft fixture needed a longer bounded
initialization timeout; the restore fixture also needed to handle HTTP 204's
absent response body. Both were corrected before the reported combined run.
Owned Vault/PostgreSQL containers and worker processes are removed. No
upstream push, serving enablement or production-readiness claim is made.
Settings/subject-policy APIs, MongoDB migration support and the built-in
encrypted-signer implementation remain unfinished, separate work.
