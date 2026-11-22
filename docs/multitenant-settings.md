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

The Vault transit mount is `<prefix>_transit`. These names are byte-identical to the
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
| `NS_VCPOOL_API_URL` | vcpool | none (required) | the api origin vcpool writes to |
| `NS_VCPOOL_ALLOW_HOSTS` | vcpool | none (required) | comma list of source host names |
| `NS_VCPOOL_ALLOW_INSECURE_HTTP` | vcpool | `false` | admit `http://` sources |
| `NS_METRICS` | api, evaluator, realtime, tenant-admin, vcpool | `false` | `true` serves Prometheus metrics at `GET /metrics` on the private listener ([below](#metrics)) |

Settings that existed before and keep their meaning and defaults: listeners
(`<ROLE>_HOSTNAME`, `<ROLE>_PORT`, `NS_SERVE_INTERNAL_*`, `NS_<ROLE>_INTERNAL_*`,
[`internal-service-api.md`](internal-service-api.md)), pool sizes
(`NS_POOL_<ROLE>_*`, `lib/server/serve/pool-config.js`), REST admission
(`NS_API_REST_*`), tenant start-up (`NS_TENANT_*`), datastore recovery
(`NS_DATASTORE_*`), evaluator residency (`NS_EVALUATOR_RESIDENT_MAX`,
`NS_EVALUATOR_RETRY_MS`), realtime and evaluator slices (lane S), vcpool egress
(`MULTITENANT_VCPOOL_EGRESS_PROXY`) and the opt-in diagnostics.

## Metrics

`NS_METRICS=true` turns on Prometheus metrics for a role process (decision
`prometheus-metrics-narrow`). The default is off. Off, nothing is registered,
the metrics library is not loaded and no request, pool or socket is touched.
The setting means the same with one tenant or many. Any value other than
`true`, `false` or empty refuses start-up (`METRICS_CONFIG_REFUSED`).

**Where.** `GET /metrics` on the process's private listener (serve.internal),
beside `/healthz/*`, never on the public api port. Give the listener a network
address so Prometheus can reach it: `NS_SERVE_INTERNAL_HOST` and
`NS_SERVE_INTERNAL_PORT` ([internal-service-api.md](internal-service-api.md)).
With metrics on, the listener opens even for a role with no internal contract.
Left unset it is a Unix socket, which Prometheus cannot scrape directly. Like
the health endpoints, it has no credential of its own: keep it off the internet
with the deployment's network policy. The admin role has no private listener
and serves no metrics.

**Series.** Every series carries `role` (the process's roles, sorted and
joined with `+`, for example `api` or `api+realtime`).

| series | type | labels | what it measures |
|---|---|---|---|
| `process_*`, `nodejs_*` | default | role | @prometheus-io/client defaults: CPU, resident memory, heap, event-loop lag, GC, handles |
| `nightscout_evaluator_phase_seconds` | histogram | slice, phase | evaluator wall time per phase, with awaited I/O: `receive` (parse and accept a delivery), `begin` (durable receipt read), `settings` (metadata and current configuration), `acquisition` or `time` (the evaluation), `completion` (durable completion, including its recheck), `consumers` (one notification delivery pass) |
| `nightscout_evaluator_pending_oldest_age_seconds` | gauge | slice | age of the oldest input the evaluator still owes a completion for, 0 when none |
| `nightscout_evaluator_pending_tenants` | gauge | slice | tenants with input pending completion |
| `nightscout_evaluator_queued_cycles` | gauge | slice | tenants with a cycle queued or running (backlog) |
| `nightscout_evaluator_tenants` | gauge | slice | tenants the evaluator holds state for |
| `nightscout_pg_statements_total` | counter | application_name, outcome (`ok`, `error`) | SQL statements through each core pool |
| `nightscout_pg_statement_seconds_total` | counter | application_name | client-side statement time summed, from the query call to its result; divided by the statement count it gives the mean. Statements are accumulated in plain numbers and published at scrape time; a per-statement histogram cost too much at about 170 statements per write. For statement latency distributions, use `postgres_exporter` |
| `nightscout_http_request_seconds` | histogram | method, route, status_class | api request duration by Express route template, refused requests included |
| `nightscout_realtime_connected_sockets` | gauge | namespace (`/`, `/storage`, `/alarm`) | connected Socket.IO sockets |
| `nightscout_evaluator_completion_lag_seconds` | histogram | slice | per durable completion that covers the oldest input the evaluator owed for a tenant: completion time minus that input's mark. The mark is the older of the writer's durable `work_pending_at` (api clock) and the evaluator's own hint receipt or sweep, so the value can include a clock offset between the api and evaluator nodes. Buckets 0.1 to 600 s with edges at 1, 30 and 120 s |
| `nightscout_realtime_frame_lag_seconds` | histogram | (none) | per fanout that sent a `dataUpdate` frame: send time minus the time this realtime process's output drain first addressed the tenant for that output. It excludes the evaluator-to-realtime hint and drain wait. Same buckets |
| `nightscout_realtime_pending_oldest_age_seconds` | gauge | (none) | age of the oldest completed-output notice this realtime process has not yet published, 0 when none |
| `nightscout_realtime_pending_tenants` | gauge | (none) | tenants with such a notice |
| `nightscout_stage_lag_negative_total` | counter | stage (`evaluator`, `realtime`) | lag observations whose end preceded their start (clock offset); each is observed as 0 |

`NS_TEST_EVALUATOR_COMPLETION_DELAY_MS` (integer 0 to 120000, default 0) is a
measurement control for tests and the capacity harness only. It makes the
evaluator wait that long before each durable completion, so the lag series and
the pending gauges can be shown to see a known delay. Never set it in a
deployment that serves people.

`slice` is the evaluator's configured slice ordinal, or `all` for an unsliced
evaluator. The evaluator gauges are read from memory at scrape time. A cycle
that has just finished can still count as queued in the scrape that follows it.

**No tenant labels.** Every label value comes from a fixed set: a role, slice,
phase, outcome, HTTP method or status class, a socket namespace, a pool's
source-owned `nightscout-*` `application_name` (at most 48; anything else is
`other`), or an Express route template. In a template, any path segment that
is not a short word or a `:parameter` becomes `:value`, and there are at most
128 templates (then `other`). A per-tenant label would make the series count
grow with the tenant population, and a scrape or retained snapshot would then
carry tenant identifiers. Per-tenant questions are answered by the per-input
events and the evaluator inspection contract, not by metrics.
`tests/metrics.test.js` fails if any label value looks like a tenant id.

**Cost.** The hooks are explicit `performance.now()` spans and pool-level
statement counting, with no async hooks and no global `pg` patch.

Measured offline (Node 22.23.4, one pinned core of an i7-11800H), with a
stand-in client and no PostgreSQL:

- **evaluator:** about 27 µs added per accepted write (one receipt, seven phase
  spans, 170 statements). That is roughly 0.25% of the evaluator's main-thread
  time per write at 83 writes/s.
- **api:** about 1.5 µs added per request.

These figures do not include scraping. The on/off pair under live load is
measured separately on Kubernetes.

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
| evaluator | `NS_EVALUATOR_PG`, `NS_OUTBOX_PG`, `NS_SUPPRESSION_PG`, `NS_DISPLAY_PG`, `NS_ACTIVITY_PG` |
| tenant-admin | `NS_OWNER_WRITER_PG`, `NS_OWNER_READER_PG`, `NS_OWNER_CREDENTIALS_PG`, `NS_OWNER_SETTINGS_PG` |
| admin | `NS_PROVISIONER_PG`, `NS_OWNERSHIP_PG`, `NS_CONNECTOR_SOURCES_PG`, `NS_MANAGEMENT_SESSIONS_PG` |
| vcpool | `NS_VCPOOL_SECRETS_PG`, `NS_VCPOOL_ACTIVITY_PG`, `NS_VCPOOL_DEFINITIONS_PG` |
| api, realtime, evaluator, tenant-admin | `NS_LIFETIME_PG` (the operation lease; a role without it runs no lease) |

The Vault token is the file `<NS_SECRETS_DIR>/vault-token` (admin's management
signer: `management-vault-token`; vcpool: `vcpool-token`), or `NS_VAULT_TOKEN`
when set. A Vault Agent deployment can set `NS_VAULT_TOKEN_FILE` to its sink.
The role reads that file on each provider call so Agent token rotation takes effect
without a process restart. Admin's elevated identities belong in admin's mount only.

## Removed

`MULTITENANT_PREVIEW_CONFIG`, `MULTITENANT_REALTIME_CONFIG`,
`MULTITENANT_EVALUATOR_CONFIG`, `MULTITENANT_OWNER_PREVIEW_CONFIG`,
`MULTITENANT_ADMIN_CONFIG`, `MULTITENANT_VCPOOL_CONFIG`,
`MULTITENANT_OPERATION_CONFIG`, `MULTITENANT_CONFIG_MAX_BYTES`,
`MULTITENANT_STATIC_TENANTS` (static tenant lists), the `MULTITENANT_POOL_<KIND>_*`
partition settings, the operation document's participant manifest and
`leaseSessions` (validated, read by nothing), `nightscout plan`, the admin `ensure`
and `pools` services, and the plan-contract schemas. With pgstream (decision
`writer-driven-transport-direction`): `NS_INPUT_TRANSPORT`,
`NS_PGSTREAM_RECEIVER_URL`, `NS_PGSTREAM_RECEIVER_BIND_HOST`,
`NS_PGSTREAM_GENERATION`, `NS_STREAM_RECOVERY_PG`, `NS_POOL_RECEIVER_*`, the
`<prefix>_pgstream` slot and stream role, and the
`nightscout_pgstream_receipt_seconds` metric.

Admin composes each of its services (provisioning, ownership, connector
sources, management sessions) when the process has that service's connection
secret, and refuses to start with none.
