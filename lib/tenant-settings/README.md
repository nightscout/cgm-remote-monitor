# Projected tenant settings

Source implementation of the adopted first-preview owner catalogue. Native
PostgreSQL, actual HTTP, cross-worker and browser acceptance of this expansion
remain UNMEASURED. The prior two-name acceptance does not establish this broader
capability. [Composition](../../docs/owner-settings-preview.md) describes the
explicit deployment selection; boot checks never apply migrations.

## Catalogue

`catalogue.js` derives names and defaults from the actual
`lib/server/tenant-app/environment.js` `CLIENT_KEYS`, plus `enable` and all four
threshold names. `DISPLAY_UNITS` (`mg/dl` or `mmol`) and `SHOW_SECONDS` (boolean)
retain their persisted spellings. Their projected aliases `units` and
`showSeconds` are accepted on write and normalized; supplying both spellings
refuses. Every other projected name keeps its client spelling. Values retain
JSON types: boolean, string, finite number or numeric array as the shipped
setting requires; `enable` is a distinct list of valid plugin names. No string
truthiness or number coercion is performed. Other names, including credentials,
integrations, process/security settings, `IMPORT_CONFIG` and debug logging,
refuse by name. Owner integration configuration remains unsupported.

`bgHigh`, `bgTargetTop`, `bgTargetBottom`, `bgLow` are stored as mg/dL numbers in
30–600. A replacement supplies all four or none; the complete `thresholds`
object is accepted as a normalized input spelling. Partial or out-of-range
bundles refuse before state/history writes. Display units never convert these
stored values or clinical documents. A default per threshold comes from the
current operator rule or shipped settings.

## Authority, merge and persistence

`createTenantSettings({store, policyFor, authorize})` requires authenticated
`{tenant,principal,consumer}` and explicit current configuration authority.
Data/root permission possession supplies none. Existing PostgreSQL actor locks,
operator-generation fence, tenant RLS, CAS, atomic current/history commit and
history attribution remain in place. Every consumer reads a committed snapshot;
unavailability refuses instead of supplying cached or open-policy fallback.

Rules retain `open`, `bounded` (nonempty `allowed` list) and `pinned` (`pin`), plus
an optional typed `default`. Array constraints compare complete typed values,
not JavaScript object identity. Tenant overrides replace whole deployment
rules. Precedence is code default, operator default, permitted owner value,
operator pin. Current policy may ignore an old stored owner value without
rewriting it. Returned snapshots cannot mutate stored state or catalogue arrays.

`replace` is a full snapshot with explicit expected version. `rollback` checks
all values against current policy and either appends one version or refuses
whole with named conflicts; it never rewinds history. Version, authority or
policy races cannot produce a partial replacement.

The immutable `0001_tenant_settings` bytes remain unchanged.
`0002_projected_owner_settings` replaces the two-name constraints on current
and history tables with a typed projected-catalogue validator and complete,
bounded threshold checks. The operator applies it explicitly through the
migration runner. Native execution of this new migration is UNMEASURED.
Existing RLS and restricted role grants remain required; database operators
remain privileged. Raw database credentials do not enforce injected owner
policy and stay off owner request paths.

## Consumers and bounded source checks

Presentation reads construct a fresh safe environment for all effective
projected values. Raw uploads, exchange and raw collection reads never load
this capability. The evaluator optionally selects the same settings/policy
reader and includes the resulting effective configuration in its output
identity. Compatible settings-only changes rebuild the actual clinical views
over retained committed input on the next cycle, including a time-only cycle;
no hidden acquisition/statistics reload occurs. Tenant/source revision changes
still discard the component. Old output identity refuses notification use.

Listener-free focused checks:

```sh
node_modules/.bin/mocha --timeout 10000 \
  tests/owner-configuration-persistence.test.js \
  tests/evaluator-preview-runtime.test.js \
  tests/tenant-projection-evaluator.test.js \
  tests/evaluator-consumer-metadata.test.js
```

These use synthetic stores/SQL read doubles with the actual clinical evaluator
and plugins. Stale-settings corruption suppresses the independently expected
high alarm; restoration produces it. Removing complete-bundle validation admits
a partial value and falsifies the complete-bundle oracle. Existing authority,
policy-fence and atomic-history controls remain in this command. They establish
source behavior, not native SQL, HTTP, worker or production acceptance.
