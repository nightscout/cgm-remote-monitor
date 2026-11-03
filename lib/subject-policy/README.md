# Dormant subject-policy/current-authority boundary

This is a bounded MT-CONFIG-MIN dependency, not the complete settings API or
tenant control plane. No serving role, owner route, JWT exchange, legacy
authorization, socket or consumer imports it. Existing secrets/entries
catalogues and checksums are unchanged. The new PostgreSQL candidate requires
separate operator review and execution in a dedicated namespace.

## Minimum contract reconciliation

The existing configuration lab and D22 supply the setting vocabulary and
precedence; this slice does not introduce an alternative scalar catalogue.

| Surface | Existing contract / boundary retained |
|---|---|
| Display | `DISPLAY_UNITS` (`mg/dl`, `mmol`) and boolean `SHOW_SECONDS` are catalogue entries in the configuration lab. Timezone and other display names need their reviewed typed catalogue before offering them. |
| Anonymous roles | `AUTH_DEFAULT_ROLES` is constrained to `denied`, `readable`, `status-only` by project floors. It is not a subject grant or a permission to bypass authenticated secrets operations. |
| Effective settings | Code default, operator default, permitted owner value, then operator pin; ignored stored owner values must be reported with reason and provenance, not silently dropped. |
| Writes / rollback | Explicit expected version; conflicts reject. Rollback is a new version validated against current policy, refused whole if blocked. |
| JWT exchange | Historical issued JWT default is **8 hours** (`lib/server/enclave.js:59-61`), used by `lib/authorization/index.js:320`. The underlying subject access token is different. No existing named maximum-lifetime setting or universal code ceiling is established. This slice does not change issuance or introduce one. |
| Subjects / permissions | Existing roles expand to Shiro permissions. New exact secrets grants below describe only the dormant component's operations; they do not replace roles or grant data/owner/operator API permissions. |
| Attribution | Authenticated token/root principal and named consumer, not an invented verified human identity. Human provider/subject access grants remain separate. |

Sources: alignment `docs/30-design/tenancy/tenant-config-schema-2026-10-27.md`
sections 3, 4, 7 and 11; `tools/lab/tenant-config-schema/migrations/0004_catalogue_seed.up.sql:16-59`;
upstream `lib/authorization/storage.js:54-61` (stored/derived subject fields).
Public endpoint/error mappings, scalar settings persistence/provenance,
versioned token-lifetime policy, live invalidation and consumer integration
remain unfinished. Do not claim that this service completes MT-CONFIG-MIN.

## Service contract

`createSubjectPolicy({store, limitsFor, authorizeManagement})` exposes:

- `read(context)`: management-authorized stored `{version, grants}`, or explicit
  `POLICY_NOT_FOUND`.
- `replace(context, expectedVersion, grants)`: full replacement and revocation
  by omission. Version 0 means provision an absent row; later versions require
  an exact match. Returns the committed state; a conflict rejects with
  `POLICY_VERSION_CONFLICT`.
- `authorize(context, action)`: injectable directly as the existing secrets
  component's `authorize` callback. Exact matching only, no wildcards, implicit
  root, anonymous defaults, JWT-derived grants or worker-local grant cache.

Contexts must already be authenticated by a future transport. Management
authorization is injected trusted current authority, resolving exactly `true`
for `read`/`replace`; caller strings do not authenticate themselves. In
particular, possession of a data token is not policy-management authority.
The fixture's root-name callback is synthetic, not a production authenticator.

Each grant contains `principal`, `consumer`, `operation`, plus an exact `id`
for encrypt/decrypt/reveal/rewrap. Sign/verify grants are tenant-wide and omit
`id`. These operation names reuse the secrets contract. Key versions do not
create new grant identities. Sign is trusted minting authority; rewrap is
maintenance authority. Provisioning must not put either in an owner's
delegable ceiling. Reveal re-authentication and operator reveal refusal still
need their owner-policy/transport contract; this slice never adds an implicit
reveal grant.

`limitsFor(tenant)` must resolve explicit `{code: grants, operator: grants}`
from trusted tenant provisioning. A grant must belong to **both** sets, at
write time and on every authorization call. Neither owner rows nor operator
limits can expand the code ceiling. No limits/unknown tenant/outage rejects,
never defaults. The service copies limits into sets for that call. These are
exact secrets-grant bounds, not the general D22 settings-policy engine.
The callback must provide current trustworthy limits; its service, persistence
and atomic coordination with operator-policy updates are not implemented here.
An already-authorized operation may finish; tightening limits is not retroactive.

Authorization linearizes at the PostgreSQL SELECT's committed READ COMMITTED
snapshot after limits are obtained. A policy replacement that commits before
that read is seen by every independent adapter. Revocation removes the grant
for the next read; a store error rejects rather than trusting earlier success.
A concurrent change after that read does not undo the authorized in-flight
operation. No socket/data-stream end-to-end revocation is claimed.

## PostgreSQL candidate and trust boundary

Use the explicit operator runner with `lib/subject-policy/postgres-candidate.json`
and a dedicated namespace, never a serving boot migration. Review/provision
roles separately. For namespace `ns_policy_lab`:

```sql
GRANT USAGE ON SCHEMA ns_policy_lab TO policy_app;
GRANT SELECT, INSERT, UPDATE ON ns_policy_lab.subject_policy TO policy_app;
GRANT INSERT ON ns_policy_lab.subject_policy_audit TO policy_app;
```

Use `NOSUPERUSER NOBYPASSRLS` non-owner credentials for the adapter. Startup
screens both tables for forced RLS, ownership and expected privileges. It is
not comprehensive role/policy/catalogue authenticity verification.

The private adapter pool commits each call independently with
`synchronous_commit=on`. Conditional UPDATE or INSERT serializes same-version
competitors; exactly one succeeds. The successful replacement and redacted
audit event commit together. Audit failure rolls the replacement back. Audit
uses the secrets identity/time vocabulary, but `policy-replace`/`committed`
means committed change, not the secrets adapter's authorized attempt; no
grant payload, token or plaintext is logged. Application audit access is
INSERT-only. There is no second notification bus or audit-reader endpoint.
Unifying audit export/read infrastructure still needs the shared audit inventory.

Raw policy database credentials can change tenant-bound grants/version without
service validation/audit and can select another tenant through a manually
bound session. Service ceilings, authenticated context and audit are trusted
application behavior, not protection against stolen provisioning/DB credentials.
The JSONB check validates array shape/size only, not full grant semantics.
All callers must use the service; the adapter itself is a trusted persistence
port, not an owner API. Database operators remain privileged. There is no
production schema, token-ID revocation list, tenant suspension or backup
acceptance for this new state.

## Acceptance

```sh
NS_SECRETS_POSTGRES_DOCKER_TEST=1 NS_VAULT_DOCKER_TEST=1 \
  node_modules/.bin/mocha --fail-zero --timeout 30000 \
  tests/secrets.test.js tests/vault-secrets.integration.test.js \
  tests/postgres-secrets.integration.test.js
node_modules/.bin/eslint lib/secrets lib/subject-policy tests/secrets.test.js \
  tests/vault-secrets.integration.test.js tests/postgres-secrets.integration.test.js \
  tests/fixtures/secrets-rewrap-worker.js
npm run test:tiers
```

The existing PostgreSQL opt-in suite uses two independent adapters, overlapping
A/B subject identities and the actual secrets authorization callback. It tests
committed revocation, concurrent/stale version conflicts, exact references,
duplicate/invalid grants, separate code/operator limits, tightened limits on
existing rows, management refusal, actual database pause/outage refusal,
audit rollback/attribution, RLS/grant refusals and a disabled-RLS exposure control.
Synthetic state only; containers are owned and removed.

Measured 2026-11-02 on integration baseline `0de90852`: **35 passing, zero
pending** in the combined command, ESLint clean, **465 test files** classified
and diff checks clean. Ignoring persisted grants in the actual authorization
method makes the cross-worker revocation assertion fail (`true !== false`);
restoring the grant lookup passes. The paused-database case takes about ten
seconds: a five-second client query timeout followed by bounded rollback,
after which the failed connection is discarded. Server statement timeout
alone cannot bound a paused/unresponsive server, so the adapter also supplies
the client query timeout. No production outage/recovery, management-auth
service or end-to-end runtime enforcement is claimed.
