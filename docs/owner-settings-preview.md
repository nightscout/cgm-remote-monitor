# Explicit headless owner settings composition

An owner uses the private tenant-admin listener and the tenant's issued management bearer to
read or replace their projected display settings. Compose and Kubernetes mount one service
login as `ns_owner_settings_pg` under `NS_SECRETS_DIR`. Its namespaces come from the deployment's
`NS_PG_PREFIX`. Each tenant's values, versions, history, policy and configure grants live in
PostgreSQL. The same deployment settings serve all tenants.

The private operator's ownership add, transfer and recovery initialize configure authority for
a newly assigned principal and consumer in the same transaction as the ownership change.
Transfer and recovery retire former owners' configure authority. On upgrade, an existing owner
whose grant is absent can be initialized by calling the ordinary private ownership add operation
with that owner and the current expected owner list. The operator can obtain that list through
ownership list. Repeating add preserves an existing inactive or denied grant. A DATA permission
or the subject administration flag cannot grant configuration rights.

The login differs from the subject writer and access reader and uses the same database. The
deployment bootstrap installs the settings, operator policy and configuration authority
catalogues. Serving processes check their grants and migration ledgers when starting.

Grant settings identity SELECT/INSERT/UPDATE on tenant_settings, SELECT/INSERT on
tenant_settings_history, SELECT ONLY on tenant_operator_policy, SELECT plus
UPDATE(owner_fence) ONLY on tenant_owner_configuration_authority. Schema USAGE
and migration-ledger SELECT support read-only checks. The sentinel permits row
locks, not changing active/can_configure. Current-access reader needs no new
authority-table grant. The owner plane never uses the operator-policy writer
factory or receives operator-policy UPDATE authority.

Authority table keys tenant/principal/trusted consumer. Both active and
can_configure default false; only explicitly true grants internal authz:configure.
Each operation checks current management state and configuration authority.
Replacement/rollback rechecks and locks authority in the mutation transaction,
then fences current operator generation and CAS/history. A committed revoke
refuses the next operation across workers; already admitted in-flight work may
finish. No data-reader clamping, role reinterpretation or delegator provenance is
introduced.

| route on tenant-admin listener | body | behavior |
|---|---|---|
| GET /api/v1/tenant/settings | none | version, stored values, effective values/provenance |
| PUT /api/v1/tenant/settings | expectedVersion, values | full typed replacement and new version |
| POST /api/v1/tenant/settings/rollback | expectedVersion, restoredFrom | validate old full snapshot against current policy; append new version |

The [typed projected catalogue](../lib/tenant-settings/README.md#catalogue) accepts actual projected client keys plus enable and complete mg/dL threshold bundles. DISPLAY_UNITS strings mg/dl/mmol and SHOW_SECONDS boolean retain their persisted spellings.
Unknown names, null/wrong types and extra request fields refuse. Reads and
writes require explicit configure authority. Invalid credential401, valid actor
without configure403, missing state/history404, stale version/policy generation409,
unavailable/unsafe dependencies503. Errors never return SQL, connection strings
or private diagnostics. Owner routes stay off DATA; operator and DATA handlers
stay off this owner router. Existing subject routes retain their own writer fence.

## Reading owner settings

The API reads the current settings and operator policy through the deployment's read-only
`NS_DISPLAY_PG` login. The deployment grants that login SELECT on the current values,
policy and their ledgers. API presentation reads use the admitted display login and open its
pool on demand. Unavailable policy reads refuse presentation with HTTP 503. A restored read
succeeds on the next request. Raw uploads and credential exchange are independent of the
display store.

Each presentation operation uses its own effective settings. The next authenticated status
request in any worker sees a committed change or policy pin. Changing display units affects
presentation and preserves the original stored glucose values and timestamps.

## Evaluator and notification identity

The evaluator and the API's notification metadata reader use their respective deployment
display-reader bindings. Reads combine the tenant's stored values with current operator policy.
The evaluator constructs the effective settings per operation.

The effective values and settings version enter evaluator output identity.
Settings-only changes preserve the source identity and rebuild clinical views
over retained committed input, so changed thresholds and alarm enables take
effect on the next time-only cycle without acquiring records again. A changed
tenant revision or extended source configuration still discards the component.
Notification current-identity checks refuse old output while retaining input
for the settings-only transition. Stored SGV values and mg/dL thresholds never
change because presentation switches to mmol.

The opt-in owner configuration suite runs the shipping CLI with PostgreSQL and Vault. It
exercises operator-issued management sessions, persisted cross-worker CAS, restart reads,
neighbor isolation, policy pins, operator revocation and refusal of writes from the display reader.
Browser presentation and joined notification/evaluator acceptance are separate measurements.
