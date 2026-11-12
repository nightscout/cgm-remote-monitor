# Durable tenant connector sources

*Contributor-facing configuration contract for the multitenant preview. The
single-site connector driver and existing static lab configuration remain supported.*

The tenant registry owns tenant membership and public aliases. A tenant's connector
sources are D15 configuration in the tenant-settings namespace (`display_settings`
in the reference deployment), distinct from the raw DATA `settings` domain.
Endpoint and credential values remain in the existing encrypted tenant-secrets
component; definitions contain only three secret-reference IDs.

## Storage and operator resource

Tenant-settings migration `0003_connector_source_definitions` adds
`tenant_connector_sources` and `tenant_connector_source_history`. Both force tenant
row security. Sources have a stable `(tenant_id, source_id)`, monotonic generation,
enabled/deleted flags, collections, credential kind and three references. History
records the operator identity and generation. Both tables enter the existing
lifecycle catalogue: export, deletion and deployment backup include them. Original-
tenant clinical reconciliation preserves current nonclinical configuration, as it
does settings and authority. Neither table is deployment-operational inventory.

The admin listener exposes the resources in the [operator OpenAPI description](../lib/tenant-registry/openapi.json):

- `GET /v1/tenants/{id}/connector-sources` pages sources with `after` and `limit` (1..1,000).
- `GET /v1/tenants/{id}/connector-sources/{source}` reads one definition.
- `PUT` to that source creates or updates with `{ifGeneration, enabled, connector}`.
  Zero selects creation; otherwise the generation must match. An identical retry
  returns `existing`, without another history row or revision change.
- `DELETE` with `If-Match: "<generation>"` writes a disabled tombstone. Matching
  retries are idempotent. A later explicit update can recreate the source at its
  current tombstone generation.

`connector` has `collections` (a nonempty unique subset of `entries`, `treatments`,
`devicestatus`, `profiles`), `sourceCredentialKind` (`token` or `api-secret`), and
`sourceEndpoint`, `sourceCredential`, `writeCredential` (distinct secret-reference IDs).
The referenced secrets must exist under the requested tenant's RLS binding. Secret
values are entered through existing tenant credential authority, never this resource.
Source responses and history contain references, not decrypted values.

Admin configuration adds:

```json
{
  "connectorSources": {
    "connectionEnv": "NS_CONNECTOR_CONFIG_WRITER_PG",
    "namespaces": {
      "settings": "ns_display_settings",
      "registry": "ns_registry",
      "secrets": "ns_secrets",
      "control": "ns_control"
    },
    "operator": { "principal": "deployment-operator", "consumer": "admin" }
  }
}
```

Use `lib/tenant-connector/postgres-sources.grants({namespaces, writer, reader})` for
the reviewed privileges. The writer can inspect secret-reference IDs but cannot
read ciphertext, alter clinical rows or write the clinical clock. Configuration
updates use the existing shared tenant maintenance lock and require its current
active phase inside the same transaction. CAS/history and one registry revision
increment commit together. This adds no work to clinical data writes.

The admin listener stays on the private operator plane. Definition resources are
not mounted on DATA, owner or component-private listeners.

## Registry-mode worker

`MULTITENANT_VCPOOL_CONFIG` replaces `tenants` and per-tenant Vault bindings with:

```json
{
  "registry": { "namespace": "ns_registry", "maxTenants": 10000, "refreshMs": 2000 },
  "definitions": {
    "connectionEnv": "NS_CONNECTOR_CONFIG_READER_PG",
    "namespaces": {
      "settings": "ns_display_settings",
      "registry": "ns_registry",
      "secrets": "ns_secrets",
      "control": "ns_control"
    }
  },
  "maxTenants": 10000,
  "maxSources": 10000,
  "vault": { "address": "https://vault.example.test/", "mount": "transit", "tokenFile": "/run/vault/token" }
}
```

Existing API destination, secrets/activity identities, source host allowlist,
cycle/poll/retry timing and egress proxy settings are still required. Definitions,
activity and secrets use separate database identities. A registry configuration
refuses a tenant list; static tenant lists remain behind the explicit lab flag.

Normal refresh reads one registry revision. A changed revision triggers bounded
pages of registry tenant IDs and tenant-bound source definitions; no full tenant
scan runs on an unchanged tick. A complete stable-revision snapshot replaces the
old snapshot atomically. Failed refresh stops new requests until recovery; cached
configuration expires after three refresh intervals without a successful poll.
`maxSources` bounds configured source state (default 10,000; maximum 100,000), and
`maxTenants` bounds registry enumeration (set it explicitly for larger cohorts).

Multiple sources for a tenant stay on the same tenant-hashed `vcpool` member.
Source generations, additions and removals refresh without restarting the role.
The destination Host comes from the tenant's first public alias, through
`tenant_registry_alias(uuid)`: a narrowly granted, pinned definer that requires the
argument to match the caller's tenant binding. The adapter admits its exact body,
owner and settings and refuses a version change before calling it.
Vault data/signing key names follow the existing registry rule.

Every registry-mode connector poll re-reads/decrypts its references. An unchanged
credential keeps the existing driver bookmark/session; a changed credential
rebuilds the driver, and a missing reference refuses the poll. Before every actual
source or output request, the worker rechecks the current source generation and
activity eligibility. Paused tenants keep polling; suspended, removed or disabled
sources send no new requests. An already transmitted request retains its ordinary
bounded in-flight/uncertainty semantics. Source host allowlists, redirect refusal,
member egress policy and the `nightscout-connect` driver are unchanged.

Connector inspection protocol version 2 adds optional `sourceId` and `definitionGeneration` fields
per work item and a `configuration-refused` status. These are private operational
metadata; they are not new clinical output or delivery guarantees.


Upgrade connector-inspection clients and the vcpool listener together. Version 1
clients refuse against the version 2 listener; there is no fallback that strips
source identity or configuration-refusal state. Other private service versions
and legacy client data contracts are unchanged.
