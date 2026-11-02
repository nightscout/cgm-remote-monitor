# Operator migration foundation

This is a **PostgreSQL-only foundation**, not completion of MIG-RUNNER. There
is no shipped/deployed migration catalogue and no startup integration. Default
single-process MongoDB and v16 startup behavior are unchanged. MongoDB migration
requests and all rollback requests are explicitly unsupported.

An operator supplies a separately reviewed JSON catalogue, a dedicated
non-system schema namespace, and the name of an environment variable holding
the migration identity's connection URL:

```sh
node bin/nightscout.js migrate status --backend postgres \
  --namespace hosted_schema --catalogue reviewed-catalogue.json \
  --connection-env OPERATOR_DATABASE_URL --direct
```

Use the same explicit options with `up` to mutate, or `check` to require exact
compatibility. `status` prints JSON and exits 1 if pending migrations exist;
`check` refuses a stale schema. Unknown applied migrations, checksum drift and
non-prefix histories fail every operation. Status/check open a read-only,
repeatable-read transaction; they never create a namespace, ledger or lock.
Serving identities can be given only schema `USAGE` and ledger `SELECT` for
compatibility checking. No serving-role boot hook is installed by this slice.

The connection URL must explicitly contain host, username, password and
database. Port defaults to 5432. The only supported query parameter is
`sslmode=verify-full` (TLS with certificate validation) or `sslmode=disable`.
Without it TLS is disabled: use only trusted/local links or explicitly select
verified TLS. Ambient application/PG connection settings are not used. Do not
put credentials in command arguments. Driver errors are intentionally not
printed because they may contain credentials, SQL data or paths.

`--direct` is an operator assertion that this is a direct PostgreSQL endpoint,
**not a transaction-pooling proxy**; the runner cannot detect an intermediary.
Every run owns one `pg.Client`, never an application pool. A namespace-specific
session advisory lock covers initialization, validation and all migrations.
Lock acquisition has a 30-second deadline; statements have a 60-second server
timeout. Library callers may explicitly set `waitMs` and `statementTimeoutMs`
between 1 and 600000. Each migration's SQL and its ledger row commit in the same
transaction on that pinned client. Connection closure releases the lock, and
an interrupted transaction rolls back. The migration role needs DDL permission;
the application role should not receive it.

## Reviewed catalogue contract

The injected JSON has `version: 1` and a **nonempty**, lexically ordered
`migrations` array. Every migration has:

- `name`: unique `NNNN_lowercase_name`;
- `up`: a nonempty array of individual SQL statements;
- `checksum`: lowercase SHA-256 of UTF-8 `JSON.stringify(up)`.

The exported `checksum(up)` helper computes that checksum. It detects release
drift; it is **not** a signature or proof of review. Review and distribution of
an authoritative catalogue remain operator/release responsibilities.

Statements must start with CREATE, ALTER, DROP, INSERT, UPDATE, DELETE, GRANT,
REVOKE or COMMENT (no leading comments). Extended-query mode rejects multiple
statements in an entry; transaction/session-control statements are not allowed.
This intentionally bounded format is not a general SQL parser or a sandbox
for untrusted migrations. Each migration gets a transaction-local search path
of its namespace followed by `pg_catalog`. Reviewed SQL must not alter the
ledger, weaken transaction boundaries, bypass the lock, or rely on row counts
hidden by FORCE RLS. Existing tenant schemas are not automatically baselined or
imported into this ledger.

## Acceptance and remaining work

```sh
node_modules/.bin/mocha tests/migrations.test.js
NS_MIGRATION_DOCKER_TEST=1 node_modules/.bin/mocha --timeout 30000 \
  tests/migrations.test.js tests/postgres-migrations.integration.test.js \
  tests/nightscout-cli.test.js
```

The integration suite owns a disposable PostgreSQL 16 container with random
credentials and a random loopback-only port, no volume, and guaranteed teardown.
It exercises overlapping connections, bounded contention, failed transactions,
SIGKILL/restart, drift/unknown/history refusal, read-only inspection, a restricted
checking identity, and the unsafe split-commit control.

Remaining: MongoDB standalone idempotent/resumable steps with a demonstrably
fencing-safe renewable exclusive lease; actual reviewed migration catalogues
and baseline decisions; serving-role compatibility integration; release
catalogue authenticity; explicit rollback/export policy; direct/TLS endpoint
deployment acceptance. This foundation does not enable any of those implicitly.
