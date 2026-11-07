# Minimum scalar tenant settings

Bounded MT-CONFIG-MIN continuation after `1dd8990b` (subject authority).
Only the reviewed `DISPLAY_UNITS` and `SHOW_SECONDS` catalogue subset is
implemented. The optional headless owner/settings and presentation-read
composition is described in [the source implementation note](../../docs/owner-settings-preview.md);
its native acceptance remains UNMEASURED. No migration runs at boot, and existing
secrets/subject-policy/entries migration bytes are unchanged.

## Catalogue and merge contract

| Name | Accepted owner values | Code default / existing source |
|---|---|---|
| `DISPLAY_UNITS` | Exact strings `mg/dl`, `mmol` | `mg/dl`, `lib/server/env.js:233` |
| `SHOW_SECONDS` | JSON boolean | `false`, `lib/settings.js:13` |

This preserves the measured configuration lab's spellings, grammar and defaults
(`tools/lab/tenant-config-schema/migrations/0004_catalogue_seed.up.sql:56-59`,
`tools/lab/tenant-config-schema/lib/merge.js:16-18` in the alignment workspace).
Legacy environment aliases and truthy-string parsing remain in legacy code;
this typed internal API deliberately refuses strings such as `"true"`.
Unsupported names reject with `SETTINGS_UNSUPPORTED`. Credentials,
timezone (not yet a reviewed catalogue entry here), alarms, deployment/runtime
names and anonymous-role settings cannot enter this two-name catalogue.
The database independently checks the exact keys/types in current and history
rows, including JSON null refusal. This subset introduces no clinical setting.

`createTenantSettings({store, policyFor, authorize})` requires already
authenticated `{tenant, principal, consumer}` context and an explicit current
management authorization callback. Exactly `true` permits `read`, `replace`
or `rollback`; a caller-provided root name is not authentication. Context
principal/consumer are copied into committed version history, never interpreted
as a verified human identity.

`policyFor(tenant)` must supply trusted current
`{deployment: {name: rule}, overrides: {name: rule}}`. Unknown tenants and
policy failures must reject, not produce an empty policy. Empty maps are an
explicit provisioned open policy, not an outage fallback. Tenant overrides
replace a deployment rule **whole**, regardless of JSON property order.
Missing rules use the shipped open catalogue policy.

A rule has `mode` (`open`, `bounded`, `pinned`) and an optional typed `default`.
Bounded rules require a nonempty typed `allowed` list; pinned rules require a
typed `pin`. Invalid or unsupported rule fields refuse. Precedence:
code default, operator default, permissible owner value, operator pin.
Bounded constraints govern owner values; operator defaults/pins must obey the
code catalogue's grammar. Operator policy is injected, not owner writable.

`read(context)` returns the current version, stored owner snapshot, and for
each name: effective value/source, governing policy/source, stored owner value
if present, and an explicit ignored reason (`pinned` or `outside-constraint`)
when a later operator policy excludes it. Stored values are not deleted or
silently rewritten. With no policy/state cache, another adapter's next read
sees a committed settings update. This is not runtime invalidation or push
notification acceptance.

## Versioned writes and rollback

- `replace(context, expectedVersion, values)` replaces the **full** owner
  snapshot. Omission resets a setting to current policy/code precedence, not
  a partial PATCH. Version 0 provisions an absent row; later versions match
  exactly. Unsupported/invalid/pinned/out-of-bounds values refuse before write.
- `rollback(context, expectedVersion, targetVersion)` retrieves that tenant's
  immutable old snapshot and validates **every** value against current policy.
  A blocked rollback rejects whole with a deterministic list of names,
  reasons and governing policy sources. It neither partially applies nor
  creates a version. A permitted rollback creates a new version and records
  `restored_from`; it never rewinds the version counter.
- Two same-version writers have exactly one committed winner. A stale write
  rejects with `SETTINGS_VERSION_CONFLICT`. Versions are bounded positive
  PostgreSQL integers; missing versions and future rollback targets reject.
  An absent state is `SETTINGS_NOT_FOUND`, not implicit provisioning.

Current state and full version history/attribution commit in one private-pool
transaction with `synchronous_commit=on`. A failed history append rolls back
the state change. This reuses the existing configuration version-history
approach, rather than introducing another event bus or storing secret payloads
in audit. Consumers and shared history/audit export infrastructure remain open.

## Candidate persistence and trust boundary

The new `postgres-candidate.json` is experimental and separately reviewable,
for a dedicated namespace. Use the existing explicit operator migration/check
runner; production catalogue approval is not implied. Separately provision a
non-owner `NOSUPERUSER NOBYPASSRLS` application identity:

```sql
GRANT USAGE ON SCHEMA ns_settings_lab TO settings_app;
GRANT SELECT, INSERT, UPDATE ON ns_settings_lab.tenant_settings TO settings_app;
GRANT SELECT, INSERT ON ns_settings_lab.tenant_settings_history TO settings_app;
GRANT USAGE ON SCHEMA ns_policy_lab TO settings_app;
GRANT SELECT ON ns_policy_lab.tenant_operator_policy TO settings_app;
```

Both tables force tenant RLS. Startup screens ownership/RLS/privileges;
it is not proof of every policy, role relationship or catalogue authenticity.
History is tenant-readable for rollback, but cannot be updated/deleted by
application credentials. Database operators remain privileged.

Raw database credentials can mutate tenant-bound current values outside
service version/audit/policy behavior; the database enforces catalogue types,
not injected operator constraints. Keep them off owner request paths.
`policyFor` is a trusted dependency and must return the current policy with its
persisted `generation`. The separately reviewed candidate at
`lib/operator-policy/postgres-candidate.json` stores that document. The
settings adapter requires `policyNamespace` and takes a tenant-specific
transaction advisory lock before checking the generation and changing current
state or history. A concurrent policy update must wait for an owner commit, or the
owner write/rollback sees the newer generation and refuses with
`POLICY_GENERATION_CONFLICT`. Policy-store outage or a missing tenant policy
does not fall back to an open policy.

This fences policy selection against settings replacement and rollback, but
does not provide HTTP authentication, tenant lifecycle, socket revocation,
backup acceptance or serving compatibility. Operator policy history and
production role/candidate approval remain open.

## Acceptance

From this worktree:

```sh
NS_SECRETS_POSTGRES_DOCKER_TEST=1 NS_VAULT_DOCKER_TEST=1 \
  node_modules/.bin/mocha --fail-zero --timeout 30000 \
  tests/secrets.test.js tests/vault-secrets.integration.test.js \
  tests/postgres-secrets.integration.test.js
node_modules/.bin/eslint lib/secrets lib/subject-policy lib/tenant-settings \
  tests/secrets.test.js tests/vault-secrets.integration.test.js \
  tests/postgres-secrets.integration.test.js tests/fixtures/secrets-rewrap-worker.js
npm run test:tiers
```

The PostgreSQL suite exercises both independently pooled settings adapters,
typed/unsupported names, defaults/provenance, A/B isolation, same-version
concurrency, whole overrides (including reversed input property order),
policy narrowing/pins without stored-value loss, whole rollback refusal,
new-version rollback, durable history/attribution, failed append rollback,
unavailable reads, raw SQL type/key/RLS refusals, immutable history grants and
a disabled-RLS exposure/startup-refusal control. The fixture callbacks are
synthetic trusted provisioning, not production authentication/policy stores.
Both Docker opt-ins must execute, never count pending cases as acceptance.
Owned fixtures are removed; no upstream push is authorized.

Measured 2026-11-02, based on subject-authority commit `1dd8990b`:
**36 passing, zero pending** in the combined command; ESLint clean, all
**465 test files** classified, and diff checks pass. Removing current-policy
refusal specifically for rollback in the actual service makes the rollback
test fail with `Missing expected rejection`; restoring it passes.
The first targeted run detected a mistakenly nested test (zero tests, nonzero
exit with `--fail-zero`); it was moved to suite level before acceptance.
JSONB changes object-field order, so blocked-setting reports are explicitly
name-sorted rather than depending on stored key order.
No full application, public owner API or production-policy acceptance is
claimed. The full settings catalogue, persistent operator policy and atomic
operator/owner-policy fencing remain unfinished.
