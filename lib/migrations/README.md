# Operator migration foundation

This is a **bounded PostgreSQL and MongoDB replica-set foundation**, not completion of MIG-RUNNER. There
is no shipped/deployed migration catalogue and no startup integration. Default
single-process MongoDB and v16 startup behavior are unchanged. Standalone
MongoDB mutation, MongoDB DDL/index steps and all rollback requests remain
explicitly unsupported.

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

## MongoDB transactional operator slice

Use the same explicit subcommand/options with `--backend mongodb`. The URL must
name one direct writable MongoDB 5+ replica-set primary, explicit username,
password and database; only `authSource` and `tls=true|false` query options are
accepted. Use `tls=true` for verified TLS outside the disposable loopback lab.
SRV discovery, sharded clusters, secondary endpoints and standalone servers
are not supported. Direct connection is operator-attested; this does not prove
the absence of a proxy. No application connection environment is consulted.

MongoDB uses a **separate** JSON catalogue grammar:

```json
{
  "version": 1,
  "backend": "mongodb",
  "migrations": [{
    "name": "0001_example",
    "transactional": true,
    "up": [{"collection": "samples", "filter": {"kind": "old"}, "set": {"kind": "new"}}],
    "checksum": "<sha256 of JSON.stringify(up)>"
  }]
}
```

Only idempotent `updateMany` with a nonempty scalar equality filter and scalar
`$set` fields is offered, without upsert. Keys are simple identifiers; `_id`
cannot be changed. Unknown step fields, operators, arbitrary JavaScript,
nontransactional steps and metadata-collection targets refuse. Collections
must already exist. Zero matches are valid for a resumed/already-normalized
backfill, not proof that a production catalogue targeted its intended data.
Catalogues are bounded to 1000 migrations and 100 steps per migration.
Checksums use the existing helper but do not authenticate a catalogue.
Review the catalogue, target database, counts and backup before operator use.
No actual application backfill or production catalogue ships with this slice.

One authoritative namespace must coordinate all migrations of a database;
different namespaces are independent, not mutual exclusion for the same data.
The namespace prefixes `<namespace>_migration_state` (lease/fence documents)
and `<namespace>_schema_migrations` (ledger). State initialization and empty
ledger creation are repeatable metadata setup outside migration transactions.
No index/collection creation in application data, serving boot hook or existing
migration checksum change is introduced.

**Fencing and renewal:** acquisition atomically changes the lease owner/epoch
and shared fence in a majority-journaled transaction. Server `$$NOW`, not worker
clocks, governs expiry; the epoch is retained on release. A separate serial
renewal loop extends only the same unexpired owner/epoch every lease/3.
Renewal failure is retained, prevents the next fenced step and is surfaced;
there is no silent lease reacquisition. Library options `leaseMs` (300..600000)
and `waitMs` (1..600000) default to 30000 ms. Acquisition waits/retries within
its driver transaction deadline. Network selection/connect/socket timeouts
remain separate bounds (5/5/10 seconds).

Each migration transaction first checks its lease and **writes the shared
fence**, then performs all data steps and inserts its ledger row. A takeover
must write that same fence: it cannot commit across an active fenced
transaction. A stale snapshot conflicts/retries or refuses before starting a
data command. Heartbeat writes use a separate lease document, so they do not
continually conflict with data transactions. An in-flight fenced transaction
may commit after wall-clock expiry, but only before a successor can commit its
takeover; lease expiry is not retroactive cancellation. Transactions use
snapshot reads, primary routing and majority/journaled writes, a 10-second
driver retry budget and 5-second commit bound. Long backfills need separately
reviewed bounded/chunked steps; no automatic chunking is implemented.

Data, ledger and transactional fence commit together; a process death cannot
commit data without its ledger. Completed migrations survive, and a new process
retries only the pending suffix. Driver transient/unknown-commit handling is
used inside the same bounded transaction helper. A dead worker's transaction
may retain server locks until abort/transaction expiry; its lease alone cannot
force another transaction through those locks. Production timeout/replica-set
failover acceptance remains open. This lab bounds abandoned transactions to
five seconds; it does not change production server parameters.

Status/check inspect the ledger in a snapshot transaction without writing
metadata. Drift/unknown/non-prefix history refuses; a restricted `read` role
can check but cannot run `up`. This is a compatibility helper, not serving-role
wiring. Standalone requests refuse **before metadata/data mutation**. A TTL
lease plus a pre-write check cannot atomically fence arbitrary standalone
cross-document writes: the prior lab's expiry-only lease is not adopted as
safe implementation. Safe standalone/index resumability still needs its own
reviewed operation/quiescence contract.

## Acceptance and remaining work

```sh
node_modules/.bin/mocha tests/migrations.test.js
NS_MIGRATION_DOCKER_TEST=1 node_modules/.bin/mocha --timeout 30000 \
  tests/migrations.test.js tests/postgres-migrations.integration.test.js \
  tests/nightscout-cli.test.js
NS_MIGRATION_DOCKER_TEST=1 NS_MIGRATION_MONGO_DOCKER_TEST=1 \
NS_MIGRATION_MONGO_IMAGE=mongo:8 node_modules/.bin/mocha --fail-zero --timeout 40000 \
  tests/migrations.test.js tests/postgres-migrations.integration.test.js \
  tests/mongodb-migrations.integration.test.js tests/nightscout-cli.test.js
NS_MIGRATION_MONGO_DOCKER_TEST=1 NS_MIGRATION_MONGO_IMAGE=mongo:5.0.32 \
  node_modules/.bin/mocha --fail-zero --timeout 40000 tests/mongodb-migrations.integration.test.js
node_modules/.bin/eslint lib/migrations lib/cli/commands/migrate.js \
  tests/migrations.test.js tests/mongodb-migrations.integration.test.js \
  tests/fixtures/migrations/mongo-worker.js
npm run test:tiers
```

The integration suite owns a disposable PostgreSQL 16 container with random
credentials and a random loopback-only port, no volume, and guaranteed teardown.
It exercises overlapping connections, bounded contention, failed transactions,
SIGKILL/restart, drift/unknown/history refusal, read-only inspection, a restricted
checking identity, and the unsafe split-commit control.

The MongoDB suite owns authenticated disposable single-node replica-set and
standalone containers, random synthetic credentials delivered through
environment/stdin/IPC, loopback-only random ports, no persistent volumes and
owned worker teardown. It measures **12 checks** on MongoDB **5.0.32** and
**8.3.9** (local `mongo:8`); the combined PG/MongoDB/CLI run has **53 passing,
zero pending**. It proves renewal past two lease durations while contenders
wait, exactly one applying runner, paused stale-worker takeover, blocked
takeover across a live transaction, real SIGKILL before and after commit with
new-process retry, atomic failure rollback, immutable completed history on
retry, read-only checking, drift/history refusal and actual paused-server
outage refusal. Removing the shared fence permits a stale worker to attempt
data and fails its assertion; omitting the data session makes uncommitted
changes externally visible and fails the crash assertion. Restored code passes.
These are synthetic operator checks, not production catalogue/HA acceptance.
The tier map includes the new test file (466 files); no dependencies changed.

Remaining: MongoDB standalone idempotent/resumable steps with a demonstrably
fencing-safe renewable exclusive lease; actual reviewed migration catalogues
and baseline decisions; serving-role compatibility integration; release
catalogue authenticity; explicit rollback/export policy; direct/TLS endpoint
deployment acceptance. This foundation does not enable any of those implicitly.
