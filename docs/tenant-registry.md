# The tenant registry

In registry mode the multitenant roles read their tenants from a PostgreSQL
registry instead of a tenant list in each role's configuration (decision
`tenant-registry` in the 16.0.0 release records). Tenants are created by the
admin role's provisioning operation (decision `provisioning-split`), reached
through the [operator REST API](internal-service-api.md#operator-rest-api-admin-listener)
or `nightscout admin provision`. A role configuration that selects `registry`
refuses a tenant list beside it.

## Catalogue

[`lib/tenant-registry/postgres-candidate.json`](../lib/tenant-registry/postgres-candidate.json),
migrations `0001_tenant_registry` and `0002_tenant_registry_human_keys`, in its own namespace. It is a deployment-operational
catalogue in the census (`lib/tenant-operations/catalogues.js` `OPERATIONAL`):
never part of a tenant artifact, export, erase or restore.

| Object | Holds | Access |
|---|---|---|
| `tenant_registry` | `tenant_id`, `state` (`active` or `removed`), `signing_version` | FORCE row-level security on `app.current_tenant_id`; `SELECT` granted to reader identities, which therefore see only the tenant they have bound |
| `tenant_registry_hosts` | `host` (lower-case, no port), `tenant_id`, `kind` (`alias` or `internal`) | no grant to any login role; read only by the definer functions |
| `tenant_registry_keys` | public Ed25519 verification keys per tenant (`access`, `management`, `human-data`, `human-management`) | FORCE row-level security; `SELECT` to reader identities |
| `tenant_registry_clock` | one `revision` counter | no grant; moved by a statement trigger on every change to the three tables above, in the same transaction |

Pause and suspend are not registry state: they stay in `tenant_activity`, read
per request as before.

## Database functions

Each is `SECURITY DEFINER`, `plpgsql`, owned by the NOLOGIN catalogue owner, with
`search_path` pinned to the registry namespace by the deployment grants,
`EXECUTE` revoked from `PUBLIC`, and granted only as listed
(`require('lib/tenant-registry/postgres').grants(...)`). The functions that bind a
tenant reset `app.current_tenant_id` on exit, so no binding reaches the caller.
Every call made by the reader (`lib/tenant-registry/postgres.js`) also returns the
three functions' catalogue version (`pg_proc` row version and owner attributes);
a version the reader has not admitted runs the full attribute check (owner,
security mode, language, result type, body, pinned settings, no `PUBLIC` execute)
before any row is used, and an altered function is refused with
`TENANT_REGISTRY_FUNCTION_UNSAFE` (the pattern of decision `change-stamp-definer-function`).

| Function | Returns | Executable by | Never reveals |
|---|---|---|---|
| `tenant_registry_lookup(host text, kind text)` | zero or one row `(tenant_id, state)` for that exact host of that kind | resolvers: api, tenant-admin and realtime | any other host, any list of hosts or tenants, prefixes or partial matches, keys or signing versions |
| `tenant_registry_revision()` | the aggregate revision, a `bigint` | resolvers and enumerators | which tenant or host changed |
| `tenant_registry_tenants(after uuid, page_size integer)` | up to `page_size` (1..10,000) active tenant ids after `after`, in id order | enumerators: evaluator and realtime | hosts, removed tenants, keys, signing versions |

The resolver reads these through one statement each; the per-tenant attributes
(signing version, public keys) are read with that tenant bound, from the
row-level-secured tables, never through a definer function.

## Lookup, cache and refresh

`lib/tenant-registry/resolver.js` keeps the `resolve(request)` contract and refusal
codes of `lib/tenant-resolution`: an unknown host is `TENANT_HOST_UNKNOWN` as with
a static list. Hosts are looked up on a tenant's first request and kept in a
bounded LRU (`maxTenants`, default 10,000) with a separate cache of at most 1,024
unknown hosts. One `tenant_registry_revision()` statement per `refreshMs` (default
2,000 ms) per process is the change signal; when it moves, every cached answer is
looked up again on its next use, so a tenant provisioned while a role runs is served
within one refresh interval plus one lookup, and a removed tenant (hosts deleted,
state `removed`) is refused within the same bound. If the poll has not succeeded
within three intervals nothing cached is used.

Evaluator and realtime follow registry revisions while running. A newly provisioned
tenant remains waiting until its settings, owned checkpoints and role resources
are prepared; bounded admission then makes it visible and schedules its first
acquisition. Failed preparation retries without requiring another registry change.
Removal hides the tenant before cancellation/drain, and a membership recheck after
preparation prevents a removed tenant from reappearing. Paused or suspended new
tenants wait without data work; independent activity reads observe their resume.
Empty registry startup is supported; static lab lists keep their existing contract.
`registry.waiting` reports pending admission in health and evaluator inspection.
The source contract and focused native controls are described in
[the D6 contract](d6-change-feed.md).

## Fixed names

Nothing per tenant is stored to find these (`lib/tenant-registry/rules.js`):

- Vault Transit keys `tenant-<purpose>-<tenant id>`, purpose `data`, `signing`,
  `access`, `management`, `human-data` or `human-management`. The purpose comes first so one role-level policy can
  use prefix globs (`path "<mount>/decrypt/tenant-data-*"`). Each role in registry
  mode has one Vault credential (`vault.tokenFile` or `vault.tokenEnv`).
- The operation-window advisory lock key: 1 + the first 62 bits of
  `sha256('nightscout-tenant-lock-v1:' + id)`, written into
  `tenant_lifecycle_windows.lock_key` at provisioning; an operation configuration
  with `registry: { namespace }` in place of `locks` derives it. The window row,
  read inside every transaction, remains the fence.

## Provisioning

`lib/tenant-registry/provision.js` implements the admin operation. For one tenant
(idempotency key: its id) it creates or adopts the six Vault keys, then writes in
one transaction: the registry row, hosts and public keys; the encrypted root secret
record and its audit; the legacy root reference; anonymous access `denied`; the owner
policy; access tenant and key rows; the write clock; one checkpoint row per
configured consumer; the lifecycle window (lock key by rule; lifecycle migration
`0008` adds the insert policy this needs); the activity row and audit; and the settings/operator-policy rows and settings history. The
registry row is the commit point. Subjects, roles, credentials, sessions and data
are lab priming, done through each tenant's own data API, not provisioning.


An existing tenant with the same hosts is accepted only when its required
provisioning records are present. A missing registry key, activity/settings row,
checkpoint or other required structural record returns `TENANT_PROVISION_INCOMPLETE`
(409). It never silently recreates state or issues another root secret. This check
allows settings, permissions and activity state to change after provisioning and
does not require retained audit history.

`DELETE /v1/tenants/{id}` removes host aliases and marks the registry tenant
removed only after its deletion ceremony has executed. Repeating removal is
idempotent; a removed id cannot be re-provisioned. Data deletion, key retention
and ceremony confirmation keep their existing contracts.

## Human OIDC in registry mode

The API and tenant-admin roles use the registry for public verification keys and
resolve each login origin from the request's registered public alias. The origin
is `https://<alias>`; a trusted internal name or unregistered forwarded host is
not an OIDC origin. The identity provider's provisioning adapter must register
every alias callback URI, `<origin>/api/v2/oidc/callback`.

`OIDC_ACCESS_CONFIG` (or its private file) selects the registry instead of a
per-tenant key list:

```json
{
  "version": 1,
  "registry": true,
  "issuer": "https://human-issuer.example.test",
  "audiences": { "data": "human-data", "management": "human-management" },
  "vault": { "addressEnv": "OIDC_VAULT_ADDRESS", "mount": "transit", "tokenFile": "/run/vault/token" }
}
```

The deployment still supplies issuer/client configuration, the cookie key and
human-store PostgreSQL identity/namespaces. `OIDC_ORIGIN` is not needed in registry
mode and `OIDC_TENANT_ORIGINS` is refused. Human and headless verification
issuer/audience namespaces remain disjoint. Vault human signing keys are
`tenant-human-data-<id>` and `tenant-human-management-<id>`, with registry/access
kids `human-data-1` and `human-management-1`. Signing remains scoped by the
role's Vault policy; cookie, CSRF, renewal and current-authority checks are unchanged.

Provider clients are cached per resolved tenant and origin, default 128 entries
(`OIDC_PROVIDER_CACHE_MAX`, 1..10,000). Concurrent discovery is bounded to the
smaller of eight or that cache bound; failed discovery is not retained. Public-key
access is materialized per tenant on demand, follows the registry entry revision,
and keeps at most the configured registry tenant-cache bound. These bounds are
resource limits, not an operating-envelope claim.

Static tenant lists require `MULTITENANT_STATIC_TENANTS=lab`, with a startup
notice. Fixtures convert to provisioning before static mode is removed. The
connector pool reads [durable connector definitions](tenant-connector.md) from
tenant settings and uses the registry as its tenant roster.


## Realtime effective settings

Registry realtime requires `tenantSettings` with a separate read-only connection
and the D15 settings/operator-policy namespaces, as API and evaluator do. The
shared presentation reader supplies committed units, plugins and thresholds to
`readCurrent`/`readAll`; a missing or unsafe settings store refuses instead of
substituting server defaults. The current identity incorporates settings version
and effective values. Registry membership stays separate from presentation state.
