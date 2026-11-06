# Explicit headless tenant-owner preview

`nightscout multitenant tenant-admin` selects a separate owner listener only
with `MULTITENANT_OWNER_PREVIEW_CONFIG`, `TENANT_ADMIN_HOSTNAME` and
`TENANT_ADMIN_PORT`. `api,tenant-admin` selects two sockets in one process;
API retains its independent `MULTITENANT_PREVIEW_CONFIG`. The existing listener
resolver refuses overlapping bound endpoints. Single and API defaults are
unchanged. No private operator listener is implemented by this preview.

This preview is for operator-provisioned machine/headless management credentials.
The private operator provisions the credential, session, accepted-key rows and
signatures. There is no credential issuer, refresh/recovery endpoint, legacy root
exchange or identity-provider integration here. Human idle/absolute session and
authentication-freshness promises remain unimplemented. This is not full human
management acceptance or a production token-format selection.

## Configuration and trust

The explicit bounded JSON file has this shape (synthetic public metadata only):

```json
{
  "version": 1,
  "postgres": {
    "writerConnectionEnv": "OWNER_WRITER_PG",
    "accessConnectionEnv": "OWNER_ACCESS_PG",
    "namespaces": {
      "authorization": "owner_authority",
      "credentials": "owner_legacy_metadata",
      "access": "owner_current_access"
    }
  },
  "resolution": { "mode": "direct-alias" },
  "tenants": [
    { "id": "11111111-1111-4111-8111-111111111111", "aliases": ["one.example.test"] }
  ],
  "ownerPolicy": { "catalogue": ["api:entries:read", "api:entries:create"] },
  "management": {
    "issuer": "deployment-provisioned-management-issuer",
    "audience": "deployment-owner-preview",
    "purpose": "management",
    "consumer": "owner-preview",
    "maxLifetimeSeconds": 600,
    "keys": [
      {
        "tenant": "11111111-1111-4111-8111-111111111111",
        "kid": "deployment-management-key",
        "publicKey": "REPLACE_WITH_BASE64_RAW_ED25519_PUBLIC_KEY"
      }
    ]
  }
}
```

Replace the public-key placeholder; configuration never contains private keys or
database credentials. Connection values come from the referenced environment.
Writer and current-access reader must be distinct database identities on the same
database. Namespaces must be distinct and non-system. Provision the reviewed
catalogues before startup; startup only reads migration ledgers/schema and
privileges, and refuses missing/unsafe state before opening the owner socket.

Use the exact selected-policy writer grants in
[subject administration](../lib/subject-admin/README.md), including the reviewed
`owner_fence` grants. The access reader needs SELECT on the current-access and
authority tables and the three migration ledgers; it must have no mutation,
ownership, schema creation, superuser or RLS bypass. Its readiness check reads the
credential namespace as well. The writer cannot mutate access state or unrelated
tables; its existing store validates exact reviewed subject/role/audit/policy
privileges. No application process provisions schema, subjects or actor grants.

Public keys are pinned by tenant, key ID, issuer, audience and literal management
purpose. Keys are never fetched from token metadata. Maximum lifetime defaults
to 600 seconds and can be narrowed, never widened. Data token policy keeps its
existing eight-hour limit. Unknown key, invalid token, wrong tenant/purpose,
expired or revoked credential/session/key refuses. Every operation obtains the
current persisted access snapshot; no positive identity/grant cache is added.
Authority outages use the management factory's sanitized 503 contract. Credential
refusals return its existing 401 object, with no fallback to anonymous/root/data.

The actor principal is the verified management subject; the consumer is trusted
configuration. Neither can be selected in request bodies or token extensions.
The selected owner-policy writer fences the current actor, operator ceiling,
reviewed catalogue and proposed grants in its update transaction. Existing
`PUT /api/v2/authorization/subjects` request/result shapes are preserved; selected
policy still refuses DELETE. No new permission grammar or wildcard default is
adopted. See [subject management](../lib/subject-admin/README.md) for its bounded
metadata/role-assignment scope.

## Verification boundary

Source controls replace current management state with stale active state and mix
owner handlers into the data listener; each must fail its corresponding identity
or route assertion and restore green. They use no listener/database.

The opt-in native selector is `test-multitenant --only owner-preview`. It prepares
actual CLI workers, restricted PostgreSQL identities, signed synthetic management
tokens, independent target/link/credential/audit observations, next-operation
revocation across workers, startup no-bind and SIGTERM checks. Human provider
interoperability, production JOSE/key provisioning, time/resource bounds and full
human session behavior remain unmeasured. Native cases and controls must run on
the frozen joined head before making a runtime acceptance claim.

## Prepared joined native boundaries

The native suite additionally prepares a real `tenant-admin,api` CLI process
using the existing PostgreSQL/Vault replica fixture and the separately
provisioned restricted owner writer/reader identities. It checks distinct actual
loopback sockets, a refused management PUT on the data socket with independently
unchanged owner rows/audit, and a successful owner-socket update with exactly one
audit event while the independently provisioned data rows remain unchanged.
Normal process shutdown must close both sockets. No API bootstrap is stubbed.

A second prepared case revokes SELECT on this fixture-owned reader's exact
access-credentials table. Both existing owner workers must return sanitized503
without changing either tenant's subject/link/credential/audit state. Restoring
that same grant must allow the next current-token update and one persisted audit
event. This is an actual PostgreSQL permission-refusal schedule, not a claim of
network outage or a universal connection-recovery bound. No foreign backend, role
or service is touched. These cases remain UNMEASURED until the joined native
invocation; pure configuration/authentication tests do not certify these effects.
