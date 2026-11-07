# Explicit headless owner settings composition

Source implementation; native PostgreSQL/CLI acceptance is UNMEASURED. This is
the two-name tenant configuration surface, separate from API3 settings documents,
subject grants, operator policy administration and human identity/session issuance.

The existing tenant-admin preview remains subject-only unless its explicit JSON
selects `ownerSettings`. Its management issuer, audience, purpose, tenant key and
maximum 600-second verification policy remain unchanged. A new independently
operator-provisioned relationship grants configuration; a data wildcard, root
credential, anonymous role or subject can_update flag grants none.

```json
{"ownerSettings":{"connectionEnv":"OWNER_SETTINGS_CONNECTION","namespaces":{
  "settings":"owner_settings","operatorPolicy":"operator_policy",
  "authority":"owner_configuration"}}}
```

The third identity must differ from subject writer/current-access reader, use
the same database, and have no schema creation, table ownership, bypass RLS or
unrelated write authority. Operator applies existing settings/operator policy
catalogues and NEW `lib/tenant-settings/owner-authority-candidate.json` explicitly
in separate namespaces. Existing catalogue bytes/ledgers are unchanged; boot
runs checks, never migrations or credential/row provisioning. Omitted optional
configuration needs no new tables or identity.

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

Only DISPLAY_UNITS strings mg/dl/mmol and SHOW_SECONDS boolean are accepted.
Unknown names, null/wrong types and extra request fields refuse. Reads and
writes require explicit configure authority. Invalid credential401, valid actor
without configure403, missing state/history404, stale version/policy generation409,
unavailable/unsafe dependencies503. Errors never return SQL, connection strings
or private diagnostics. Owner routes stay off DATA; operator and DATA handlers
stay off this owner router. Existing subject routes retain their own writer fence.

Optional DATA configuration selects a distinct restricted reader:

```json
{"tenantSettings":{"connectionEnv":"DISPLAY_SETTINGS_CONNECTION","namespaces":{
  "settings":"owner_settings","operatorPolicy":"operator_policy"}}}
```

DATA boot parses configuration syntax and registers an owned lazy resource; it
never connects to display storage before the raw listener starts. The first
presentation operation validates a SELECT-only capability before reading any
configuration rows. Unsafe/unavailable configuration gives presentation503,
without blocking uploads/exchange even after restart. Failures close the failed
pool and the next presentation retries fresh; shutdown drains pending
initialization and closes late-created pools before finishing. OWNER selected
settings readiness still refuses unsafe/unavailable configuration before bind.
The reader joins current owner state and operator policy and reuses the same
strict merge. DISPLAY_UNITS and SHOW_SECONDS affect presentation/status/derived
READs only. Each operation gets a separate safe environment; shared boot objects
are never mutated. The next authenticated status operation in another worker
must show a committed change/pin. Raw uploads, credential exchange and raw
collection paths never invoke the presentation reader or reinterpret incoming
SGV/treatment/date values. Existing static units/showSeconds must be migrated
explicitly before selecting persisted settings; overlapping static values reject.
Other static display configuration is preserved. No common clinical revision,
push invalidation, notification, timezone/alarms or full catalogue expansion is
claimed. Older binaries reject the new explicit optional keys; rolling migration
requires operator coordination.

The separate default-opt-out owner-configuration native suite prepares actual
owner/DATA workers, independent stored-state oracles, revocation, CAS/history,
policy fences, presentation visibility, raw-upload independence and boundary
controls. Original owner9 remains unchanged. Source fixtures include meaningful
GET-authority, write-authority, generation and boot-environment controls; their
modeled/source effects are not native acceptance. Whole application, provider,
performance and production identity acceptance remain separate.
