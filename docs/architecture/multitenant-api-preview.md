# Explicit multitenant API preview

`nightscout multitenant api` runs the existing tenant credential exchange and
PostgreSQL collection APIs using Vault Transit. It requires an explicit JSON file:

```sh
MULTITENANT_PREVIEW_CONFIG=/operator/config/preview.json \
API_HOSTNAME=127.0.0.1 API_PORT=1337 nightscout multitenant api
```

Only `api` is available. `evaluator`, `realtime`, `vcpool`, `tenant-admin` and
`admin`, alone or in a comma-separated list, refuse with exit 64. Missing or
invalid configuration and failed database readiness refuse with exit 78 before
listening. Listener startup failure exits 1. No fallback runs `single` or MongoDB.
`nightscout single` and the single-tenant headless test server are unchanged.

## Configuration version 1

The following is a synthetic **shape**, not a provisioned deployment. Unknown
fields are rejected. The file contains environment variable **names**, never
database URLs, passwords, roots, access tokens or Vault tokens.

```json
{
  "version": 1,
  "postgres": {
    "connectionEnv": "PREVIEW_APP_PG",
    "readinessConnectionEnv": "PREVIEW_CHECK_PG",
    "namespaces": {
      "entries": "preview_data",
      "authorization": "preview_auth",
      "secrets": "preview_secrets",
      "legacy": "preview_legacy"
    }
  },
  "vault": {
    "address": "https://vault.example.test",
    "mount": "transit",
    "timeoutMs": 5000
  },
  "resolution": { "mode": "direct-alias" },
  "tenants": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "aliases": ["one.example.test"],
      "vault": {
        "tokenEnv": "PREVIEW_VAULT_ONE",
        "encryptionKey": "tenant-one-data",
        "signingKey": "tenant-one-signing",
        "signingVersion": 1
      }
    }
  ]
}
```

Provision the named credentials through the process environment. References
are exact uppercase environment names, not shell expressions or values from
another config file. They never fall back to `DATABASE_URL`, `API_SECRET` or
Mongo settings. Vault token references are consulted on each provider call;
this is not a token issuance/renewal service. Separate tenants require separate
key names and token references. The operator must supply genuinely scoped
Vault policies; the process cannot infer a token's effective policy from its
name.

Use explicit PostgreSQL connection URLs with host, user, password and database;
the only supported URL option is `sslmode=verify-full` or `sslmode=disable`.
Use verified TLS for remote databases. Readiness and serving must use different
database usernames on the same host, port and database. Namespaces must be
distinct non-system schema names. API3 flags use the shipping `lib/api3/const.json` defaults, separately per tenant;
process-wide single-tenant API3 overrides do not configure tenants. Each tenant
may supply `settings` and `extendedSettings`: only the typed display allowlist
in `lib/server/tenant-app/environment.js` is copied. Database, provider and other
process values cannot enter this client-facing environment.

The default remains API3 entries only. To opt into the implemented collection
ports, add these top-level fields:

```json
{
  "domains": ["entries", "treatments", "devicestatus", "profile", "food", "activity", "settings"],
  "legacy": true,
  "context": true
}
```

`domains` must be a unique explicit list containing `entries`. Add a distinct
`postgres.namespaces` entry for every selected additional domain. Each domain has
an independent migration ledger; do not share schemas. `legacy: true` requires
all six legacy domains because its real shipping dataloader snapshot reads
entries, treatments, devicestatus, profile, food and activity. `context: true`
adds tenant-safe status, verification and discovery routes. Neither option
enables evaluation, realtime, derived reports or other single-process services.

The listener reuses `API_HOSTNAME`/`API_PORT` (including the existing lowercase
and `CUSTOMCONNSTR_` aliases), then `HOSTNAME`/`PORT`; absent settings default
to `127.0.0.1:1337`. An explicit empty `API_HOSTNAME` binds every interface.
This preview listener is HTTP. Keep a direct listener on an operator-controlled
network; external HTTPS termination requires the explicit canonical mode below.
No Express proxy-trust setting authenticates a proxy.

For disposable loopback development only, `vault.allowInsecureLoopback: true`
permits HTTP to loopback Vault. It does not permit non-loopback HTTP or disable
TLS certificate verification.

### Canonical ingress

Default `direct-alias` mode refuses **all** `X-Forwarded-Host` and
`X-Resolved-Tenant` selectors. Select tenants with their configured `Host`.

To run behind an operator-controlled edge that rewrites `Host`, set:

```json
{
  "mode": "canonical-internal",
  "trustedPeers": ["192.0.2.10"]
}
```

in `resolution`, and add a distinct portless `canonicalHost` to every tenant.
The canonical name is selected from `Host`, never a forwarded public alias.
Every request, including Host-only requests, requires an exact match against
the **immediate socket's** `remoteAddress`. IPv4-mapped IPv6 peers require their
actual mapped address in the allowlist. CIDRs, hostnames, wildcard trust,
`X-Forwarded-For` and Express trust-proxy are unsupported. Unknown but
well-formed public forwarded aliases are disposable; known aliases or tenant
assertions conflicting with the canonical tenant refuse.

Allowlisting a peer is an operator trust decision: the edge must enforce
tenant routing and prevent clients from reaching the listener directly.
This is not a durable canonical registry, allocation/rename lifecycle,
workload identity, or a production transport acceptance claim.

## Operator preparation and readiness

Startup never creates roles, schemas, keys, tenants or grants and never runs
`migrate up`. Prepare and review these existing candidate catalogues explicitly:

| Namespace key | Catalogue |
|---|---|
| `entries` | `migrations/candidates/postgres-entries-v1.json` |
| `authorization` | `lib/tenant-authorization/postgres-candidate.json` |
| `secrets` | `lib/secrets/postgres-candidate.json` |
| `legacy` | `lib/secrets/legacy-credentials-candidate.json` |

For each selected additional domain, prepare
`migrations/candidates/postgres-<domain>-v1.json` in its own configured namespace.
All selected catalogues are checked read-only before the listener binds.
Legacy entries natural-order reads require the entries catalogue's insertion
ordinal migration. Fresh writes preserve their actual insertion order; ordinal
backfill on an already populated PostgreSQL table has not been measured against
a MongoDB import's natural order.

Use the existing explicit `nightscout migrate` operator command for schema
preparation; schema migration does **not** import tenant identities or roots.

The readiness credential needs schema USAGE and SELECT on each
`schema_migrations` ledger. It must not own candidate tables, have schema CREATE,
table/column mutation grants, SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or
REPLICATION. The actual migration `check` executes read-only and requires the
exact known checksummed catalogue prefix to be current.

The distinct serving credential needs schema USAGE, SELECT/INSERT/UPDATE/DELETE
on each selected domain table, USAGE on their insertion-order sequences,
read-only current authorization/legacy metadata, and the existing
secrets adapter's SELECT/INSERT on `secret_records` plus INSERT-only
`secret_audit`. The adapters reject ownership/bypass and unsafe extra grants;
all selected domain tables must have enabled **forced** RLS and no TRUNCATE/REFERENCES/TRIGGER
privileges. Serving must have no candidate-schema CREATE or elevated role
creation/replication privileges. Do not reuse the migration/operator credential.

Each configured stable tenant UUID must already have legacy credential config,
an encrypted root record at its explicit reference, and current authorization
config. Preserve imported stable subject IDs, shipping token prefixes, exact
current names and effective grants. A missing current display name is not
fabricated: exchange and subject writes refuse, while an otherwise authorized
GET remains possible. Provisioning is not atomic activation or a general
credential importer.

Readiness measures catalogue currency, privilege boundaries and these local
reference/config presences. It does **not** decrypt every root, prove provider
key/token availability, or certify all tenant data. Invalid/dangling provider
bindings and outages fail closed at request time with sanitized 503 responses.
Recovery is checked on subsequent requests, not hidden by an availability cache.

The API's private process capability is restricted to configured tenants,
their fixed provider keys, current legacy root references and
decrypt/sign/verify operations. It cannot encrypt/reveal/rewrap or be selected
by client principal/consumer strings. Current data grants are read on every
operation; exchanged eight-hour credentials do not freeze grants. Anonymous
writes are never enabled.

## Serving and stopping

The credential exchange remains
`GET /api/v2/authorization/request/:accessToken`. Explicitly selected domains
mount actual shipping handlers:

| Surface | Admitted capabilities |
|---|---|
| API3 entries, treatments, devicestatus, profile, food, settings | create, read/search, replace, patch, logical/permanent delete and history |
| Legacy v1 and actual inherited v2 entries | read/current/model/format, POST/object/array/resend/preview, DELETE and count/slice/echo/time helpers |
| Legacy treatments, devicestatus, profile, food, activity | their existing collection handlers and supported mutations; no invented entries PUT/PATCH or API3 activity |
| Optional context | legacy status/verifyauth, v2 permissions/trie, API3 version/status/lastModified and root `/api/versions` |

Unknown collections and methods refuse; owner/operator management paths remain
unmounted (404). Public query semantics are not extended to arbitrary MongoDB
features. The PostgreSQL compiler still refuses unrepresentable predicates,
sorts and read options. Legacy entries time helpers translate only their
bounded literal pattern grammar; this is not general PCRE support. Existing
shipping preconditions and error envelopes remain in the handlers.

Legacy authentication runs after shipping body parsers and consumes selected
body credentials before writes. Presented invalid credentials never become
anonymous. Every protected mutation reads current persisted grants and exact
subject names. v1/v2 storage, API3 collections, clocks and snapshot frames are
tenant-local. Snapshot reads use the genuine shipping loader and caches;
partial snapshots fail. Tenant data-size statistics sum only RLS-visible
documents. Attribution of shared physical index pages is unmeasured, so
`indexSize` is omitted rather than replaced by a database-wide number or zero.

Use a configured Host and tenant credential when probing data. The generic
`healthcheck --role api` version probe is for the single-tenant headless app;
this preview does not expose a global unauthenticated version route.

SIGTERM/SIGINT close the existing listener boundary and all acquired PG pools.
Partial initialization and bind failures close acquired resources. The existing
10-second shutdown bound remains; in-flight connections can be closed rather
than drained. Vault uses per-call bounded HTTP requests and no owned background
provider worker. Tokens, keys and root plaintext are not printed in diagnostics.

This is an explicit static-config preview, not production HA, durable tenant
registry, owner/operator administration, automatic provisioning, realtime,
evaluation, connector actors or the complete multitenant platform.

## Reproduce the executable acceptance

With Docker available and dependencies installed:

```sh
set -a
. tests/ci.test.env
set +a
ulimit -n 64000
TZ=UTC TEST_SHUFFLE_SEED=41574423920 TEST_ENV_FILE=/dev/null \
NS_MULTITENANT_PREVIEW_PROCESS_DOCKER_TEST=1 \
node node_modules/mocha/bin/mocha.js --require ./tests/hooks.js --timeout 120000 --exit \
  tests/multitenant-preview-process.integration.test.js
```

The opt-in suite provisions its own synthetic PostgreSQL 16 and pinned Vault
containers on random loopback ports, prepares schemas and roots explicitly,
then launches **`bin/nightscout.js multitenant api` as an actual child process**
from outside the package. Credentials exist only in process environments or
memory. It checks two-tenant exchange/POST/read/search, persistence across
restart, explicitly selected domains through legacy/API3 handlers and real
snapshots, overlapping tenant IDs, cross-version reads/history, metadata,
foreign credentials, current revocation, provider outage/recovery,
direct/canonical trust refusal, prebind readiness and privilege rejection, late
failure cleanup and signal shutdown. Its owned files, children, pools and
containers are removed on teardown.
