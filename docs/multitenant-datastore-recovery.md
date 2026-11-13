# Multitenant roles after PostgreSQL loss

*Contributor- and operator-facing. Applies to the multitenant roles that belong to a tenant
operation cohort (`api`, `realtime`, `evaluator`, `tenant-admin`). A single-tenant site is not
affected. Source: `lib/server/serve/datastore-recovery.js`.*

When PostgreSQL restarts or becomes unreachable, each role process:

1. **Reports itself unhealthy while it cannot serve a tenant.** Every 5 s, and at once when a pool
   reports a lost connection, the role asks the database one question on the path a tenant request
   uses. While that fails, the role answers no lifecycle status call (`RESTORE_COHORT_DATASTORE_UNAVAILABLE`).
   A health check built on that call fails for as long as tenants are refused, and a tenant restore
   is refused for the same time.
2. **Reconnects with backoff.** Attempts start 250 ms apart and double up to 5 s, with jitter.
3. **Checks what came back before serving on it.** The role serves again in place only on the same
   database of the same PostgreSQL cluster (the cluster's system identifier) whose lifecycle control
   tables are the ones it admitted at start. The database's address may have changed. A newly
   initialized cluster, another database, or replaced control tables are not adopted; the role stays
   unhealthy and exits at the bound below, and a new process starts from what it then finds.
4. **Drops what it had cached.** After a PostgreSQL restart every tenant is cold again, as after a
   process start: floors and the write clock are read again, realtime sockets are disconnected with
   `TENANT_INVALIDATED` and reconnect, and tenants warm in the background. A request for a tenant
   that is not yet warm answers 503 `TENANT_WARMING` with `Retry-After`. When only connections were
   lost and PostgreSQL itself kept running, nothing cached is dropped.
5. **Exits when it cannot recover.** After 120 s without recovery the role stops its listeners and
   exits with status 1. The platform's restart policy is expected to start it again.

| setting (role process environment) | default | range |
|---|---|---|
| `NS_DATASTORE_PROBE_INTERVAL_MS` | 5000 | 250 to 60000 |
| `NS_DATASTORE_RECOVERY_BOUND_MS` | 120000 | 1000 to 3600000 |

Log lines: `Datastore unavailable; recovering in place: <code>`, `Datastore recovered in place after
<ms> ms, ...`, `Datastore not recovered within <ms> ms (<code>); stopping for the restart policy`.

## What recovery does not do

- A request that was in progress when its lifecycle connection was lost leaves its operation record
  unfinished. Recovery does not clear it. A tenant restore is refused while such records remain;
  clearing them is an audited operator operation (`docs/tenant-operation-cohort.md`).
- A restore that had pinned the roles before the loss is refused afterwards
  (`RESTORE_COHORT_PARTICIPANT_CHANGED`): a role that re-admitted a restarted PostgreSQL counts as a
  new participant. Start the restore again.
- The `admin` and `feed-reader` roles are outside the cohort. Their pools open new connections on
  their next statement; they have no probe and no bounded exit.

## Evidence

`tests/datastore-recovery.test.js` (source protocol and controls) and
`tests/datastore-recovery.integration.test.js` (an owned PostgreSQL container that the suite
restarts, stops and starts; `NS_DATASTORE_RECOVERY_DOCKER_TEST=1`).
