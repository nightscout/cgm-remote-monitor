# Multitenant role settings

*Contributor- and operator-facing reference. Decision `config-few-dozen-env`.*

A multitenant role (`nightscout multitenant <role>[,<role>...]`) is configured by
environment settings with documented defaults. There are no per-role JSON
documents and no plan-contract schemas: each role builds the configuration its
loader validates from the settings below
([`lib/server/serve/deployment-settings.js`](../lib/server/serve/deployment-settings.js)),
and the loader's own checks still apply. Per-tenant values come from storage,
administered by owners under policy (D15, D22); they are not settings.

## Names derived from one prefix

Every PostgreSQL schema a role uses is `<NS_PG_PREFIX>_<kind>`:

| kind | used by |
|---|---|
| `entries`, `treatments`, `devicestatus`, `profile`, `food`, `activity` | clinical data |
| `settings`, `authorization`, `secrets`, `legacy`, `access`, `clock` | api, tenant-admin, admin |
| `rt_checkpoint`, `eval_checkpoint` | realtime and evaluator checkpoints |
| `alarm`, `outbox` | alarm suppression, notification outbox |
| `control`, `registry` | lifecycle control and the tenant registry |
| `display_settings`, `operator_policy` | tenant presentation settings and operator policy |
| `human_session`, `subject_policy`, `owner_configuration` | migrated by provisioning |

The Vault transit mount is `<prefix>_transit`; the logical replication slot and
the stream role are `<prefix>_pgstream`. These names are byte-identical to the
ones the deployment's role documents carried, so an existing database keeps its
schemas (`tests/deployment-settings.test.js` compares them). The checkpoint
consumers (`evaluator-compose-demo`, `realtime-compose-demo`), token issuers and
operator principals also keep the documents' values, because checkpoint rows and
their contract digests are keyed by them.

## Settings

| setting | roles | default | meaning |
|---|---|---|---|
| `NS_PG_PREFIX` | all | `nsdemo` | schema prefix, a lower-case SQL name of at most 24 characters |
| `NS_SECRETS_DIR` | all | `/run/ns-config` | directory of mounted secret files (below) |
| `NS_VAULT_ADDR` | api, tenant-admin, admin, vcpool | none (required) | Vault origin |
| `NS_VAULT_ALLOW_INSECURE_LOOPBACK` | same | `false` | `true` admits `http://` to a loopback Vault (tests, labs) |
| `NS_TENANT_RESOLUTION` | api, tenant-admin | `direct-alias` | `canonical-internal` resolves tenants behind a trusted proxy |
| `NS_TRUSTED_PEERS` | api, tenant-admin | none | comma list of proxy IP addresses, required for `canonical-internal` |
| `NS_REGISTRY_REFRESH_MS` | all | `2000` | tenant registry refresh |
| `NS_REGISTRY_MAX_TENANTS` | all | `10000` | registry working-set bound |
| `NS_OWNER_CATALOGUE` | api, tenant-admin, admin | `*` | comma list: the owner and root permission ceiling |
| `NS_PGSTREAM_RECEIVER_URL` | evaluator | `http://evaluator:19913/` | this evaluator's intake receiver, as the stream service reaches it |
| `NS_PGSTREAM_RECEIVER_BIND_HOST` | evaluator | `0.0.0.0` | the receiver's bind address |
| `NS_PGSTREAM_GENERATION` | evaluator | none (required to serve) | the stream incarnation, 32 hex characters; seeded once per stream and rotated by a destructive wipe |
| `NS_VCPOOL_API_URL` | vcpool | none (required) | the api origin vcpool writes to |
| `NS_VCPOOL_ALLOW_HOSTS` | vcpool | none (required) | comma list of source host names |
| `NS_VCPOOL_ALLOW_INSECURE_HTTP` | vcpool | `false` | admit `http://` sources |

Settings that existed before and keep their meaning and defaults: listeners
(`<ROLE>_HOSTNAME`, `<ROLE>_PORT`, `NS_SERVE_INTERNAL_*`, `NS_<ROLE>_INTERNAL_*`,
[`internal-service-api.md`](internal-service-api.md)), pool sizes
(`NS_POOL_<ROLE>_*`, `lib/server/serve/pool-config.js`), REST admission
(`NS_API_REST_*`), tenant start-up (`NS_TENANT_*`), datastore recovery
(`NS_DATASTORE_*`), evaluator residency (`NS_EVALUATOR_RESIDENT_MAX`,
`NS_EVALUATOR_RETRY_MS`), realtime and evaluator slices (lane S), vcpool egress
(`MULTITENANT_VCPOOL_EGRESS_PROXY`) and the opt-in diagnostics.

## Secrets

A secret `NAME` is read from the environment variable `NAME`, else from the file
named by `NAME_FILE`, else from `<NS_SECRETS_DIR>/<name in lower case>` when that
file exists. A Kubernetes Secret volume or the Vault Agent sink mounted at
`NS_SECRETS_DIR` therefore needs no other setting, and no password has to be in
the process environment.

| role | connection secrets |
|---|---|
| api | `NS_API_PG`, `NS_READINESS_PG`, `NS_API_ROOT_WRITER_PG`, `NS_ALARM_PG`, `NS_DISPLAY_PG` |
| realtime | `NS_REALTIME_PG`, `NS_DISPLAY_PG` |
| evaluator | `NS_EVALUATOR_PG`, `NS_OUTBOX_PG`, `NS_SUPPRESSION_PG`, `NS_DISPLAY_PG`, `NS_ACTIVITY_PG`, `NS_STREAM_RECOVERY_PG` |
| tenant-admin | `NS_OWNER_WRITER_PG`, `NS_OWNER_READER_PG`, `NS_OWNER_CREDENTIALS_PG` |
| admin | `NS_PROVISIONER_PG`, `NS_OWNERSHIP_PG`, `NS_CONNECTOR_SOURCES_PG`, `NS_MANAGEMENT_SESSIONS_PG` |
| vcpool | `NS_VCPOOL_SECRETS_PG`, `NS_VCPOOL_ACTIVITY_PG`, `NS_VCPOOL_DEFINITIONS_PG` |
| api, realtime, evaluator, tenant-admin | `NS_LIFETIME_PG` (the operation lease; a role without it runs no lease) |

The Vault token is the file `<NS_SECRETS_DIR>/vault-token` (admin's management
signer: `management-vault-token`; vcpool: `vcpool-token`), or `NS_VAULT_TOKEN`
when set. A Vault Agent deployment can set `NS_VAULT_TOKEN_FILE` to its sink.
The role reads that file on each provider call so Agent token rotation takes effect
without a process restart. Admin's elevated identities belong in admin's mount only.

The evaluator accepts `NS_PGSTREAM_GENERATION` inline or in a mounted file
selected by `NS_PGSTREAM_GENERATION_FILE` or `<NS_SECRETS_DIR>/ns_pgstream_generation`.
The deployment seeds this value once and rotates it on destructive stream replacement.

## Stream source identity

The roles do not pin the database's identity (system identifier, timeline,
database, slot). The stream state each tenant records in PostgreSQL is the only
source identity: after a restore, point-in-time recovery or failover, a source
mismatch resets and re-bootstraps that tenant, a missing slot goes through
snapshot recovery, and a role that exits is restarted by the platform's restart
policy (decision `stream-source-identity-in-data`).

## Removed

`MULTITENANT_PREVIEW_CONFIG`, `MULTITENANT_REALTIME_CONFIG`,
`MULTITENANT_EVALUATOR_CONFIG`, `MULTITENANT_OWNER_PREVIEW_CONFIG`,
`MULTITENANT_ADMIN_CONFIG`, `MULTITENANT_VCPOOL_CONFIG`,
`MULTITENANT_OPERATION_CONFIG`, `MULTITENANT_CONFIG_MAX_BYTES`,
`MULTITENANT_STATIC_TENANTS` (static tenant lists), the `MULTITENANT_POOL_<KIND>_*`
partition settings, the operation document's participant manifest and
`leaseSessions` (validated, read by nothing), `nightscout plan`, the admin `ensure`
and `pools` services, and the plan-contract schemas.

Admin composes each of its services (provisioning, ownership, connector
sources, management sessions) when the process has that service's connection
secret, and refuses to start with none.
