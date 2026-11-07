# Bounded restricted-role readiness diagnostic

Source instrument only; actual PostgreSQL metadata representation remains
UNMEASURED until the coordinator grants a fresh owned probe. Neither readiness
predicate, policy canonicaliser nor installed candidate is relaxed by this change.

Callable:

```js
const result = await require('./tenant-notification-readiness-diagnostic')({
  env, connectionEnv, namespace, tenant, maxRows, maxBytes, timeoutMs,
  kind: 'outbox', // or 'suppression', using that actual restricted role
  onObservation: async record => { /* parent-owned private capture */ }
});
```

The parent supplies the real restricted-role URI only through the named environment
value and enables NS_NOTIFICATION_DIAGNOSTIC_NATIVE=1 under its explicit grant.
All bounds are explicit positive finite integers. The adapter opens one own pool
with max1 and bounded connect/statement time, scopes its metadata transaction to
the synthetic tenant, and closes the pool in finally. No schema/role/grant/data
mutation, services, retries or campaign is performed. Importing the adapter does
nothing; missing grant/input refuses before connection acquisition.

Actual current_user, current_database and PostgreSQL version are recorded first.
The exact existing readiness queries then emit raw role flags, table columns,
primary key, policies including pg_get_expr output, and ledger rows **before each
existing predicate**. policyRoleTypes records JavaScript primitive types of raw
policy role values. An observer receives a deep copy and cannot mutate the rows
used by a predicate. Aggregate row/byte limits include the context and every
published record. A limit or SQL error is incomplete, not a passing readiness.
The outbox and suppression guards use the same observer, with their own unchanged
policy/privilege checks.

Return values distinguish:

- complete:true, ready:true: all selected checks completed and accepted;
- complete:true, ready:false: an existing readiness predicate refused; stage/code
  identify the last captured guard and records retain the raw cause;
- complete:false, ready:false: SQL, bound or instrument refusal before completion.

A completed metadata capture is not notification, delivery, role-lifecycle or
joined native acceptance. Do not treat process exit0 or complete:true as ready.
Output never contains a connection URI, password, token or raw provider error.
The parent owns the service/admin fixture and must close it after this adapter
closes its restricted pool.

The first stopped ordinary PG campaign reported NOTIFICATION_SCHEMA_UNSAFE without
capturing policy data, and the inherited consumer fixture reset queried its outbox
before setup (primary3F000; missing-role cleanup42704 secondary). Actual fixture
open/reset/close code now has source protocol coverage of that reset order, eighteen
successful SQL creation interruption boundaries and exact preexisting-name refusal.
Those setup protocol checks replace driver/migration effects and are not PG/RLS
proof. New schemas are explicitly created before being marked owned; only successful
creations are cleaned. Base reset still runs while extension reset waits for its
schemaReady boundary. Cleanup attempts all tracked owned resources and reports
errors rather than adopting uncreated roles/namespaces.
