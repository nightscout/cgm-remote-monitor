# Multitenant roles after PostgreSQL loss

The `api`, `realtime`, `evaluator` and `tenant-admin` operation cohorts report unavailable while their tenant operation probe fails. The existing supervisor retries with bounded backoff and stops the role when its recovery bound expires. Single-tenant operation is unchanged.

Unselected roles can recover the same database in the same PostgreSQL cluster after its network endpoint changes. Recovery compares the database name, database OID, PostgreSQL system identifier and previously admitted lifecycle catalogue object identities. It re-runs catalogue admission, drops old tenant state before adopting a changed endpoint or postmaster, and then re-admits storage pools before serving. Cancellation or an unconfirmed metadata read prevents adoption. Lost operation markers remain unfinished until the existing audited operator procedure handles them.

Selected connection-admission profiles retain their exact resource binding. A changed endpoint or postmaster reaches `DATASTORE_RECOVERY_REBIND_REQUIRED` before cached state is dropped or the new identity is adopted. A matching system identifier grants no new worker incarnation, resource binding, physical credit or cleanup acknowledgement. Physical copies can retain the same PostgreSQL system identifier; it is supplemental lineage metadata, not proof of a unique physical server.

The fixed `pg_catalog.pg_control_system()` read runs on the already held lifetime client at initial admission and recovery, without changing public datastore snapshot fields or normal tenant query paths. A denied or malformed response refuses admission; there is no endpoint-only fallback. This implementation adds no database grants. An isolated PostgreSQL 16.15 qualification confirmed that a fresh non-superuser role without monitoring membership or added grants can invoke this function. Operators who revoke that existing privilege must account for the resulting admission refusal.

The existing process settings remain:

| Setting | Default | Allowed range |
| --- | --- | --- |
| `NS_DATASTORE_PROBE_INTERVAL_MS` | 5000 ms | 250–60000 ms |
| `NS_DATASTORE_RECOVERY_BOUND_MS` | 120000 ms | 1000–3600000 ms |

Source protocol controls are in `tests/datastore-recovery.test.js`. The isolated restart/role tests are in `tests/datastore-recovery.integration.test.js`, enabled by `NS_DATASTORE_RECOVERY_DOCKER_TEST=1`. Source controls and the least-privilege function probe do not establish native failover, selected-controller recovery or capacity acceptance; those require the coherent joined acceptance campaign.
