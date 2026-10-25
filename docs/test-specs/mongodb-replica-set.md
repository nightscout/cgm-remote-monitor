# MongoDB replica-set continuity

M29 requires evidence beyond standalone MongoDB tests before the driver migration.
`tools/validate-mongodb-replica-set.js` exercises the actual storage initializer
and entries adapter against three disposable localhost MongoDB members.

The CI matrix tests the edges of the supported range: Node 22.23.4 (the floor)
and 26 (the newest line) with MongoDB 5.0.32 (the oldest supported) and 8.0.29
(the newest tested). Docker publication depends on this matrix; the
pull-request image check runs alongside it.
Each job owns its containers and volumes and removes them even after failure.

The validator checks the dedicated replica-set name, ports and bind addresses
before initialization. It creates a unique test database and drops only that
database on exit. It must never be pointed at a deployment. For local use,
start three disposable members with the exact options in the workflow, then run:

```sh
node tools/validate-mongodb-replica-set.js
```

An optional absolute checkout argument loads that checkout's actual driver and
storage modules, allowing comparison before and after a driver migration.
Run comparisons sequentially against the shared test replica set.

Assertions cover majority-acknowledged writes immediately after each of two
commanded primary stepdowns, election of a different primary, subsequent reads,
identifier-preserving updates without duplicate records, descending entry order,
five data-update events, and database statistics. There is no application retry
loop around the writes. Driver retryWrites is enabled and asserted.

Local evidence in `../audits/mongodb-replica-local.json` records all four Node/driver
combinations on MongoDB 8.0.29. Driver 5.9.2 uses integration source `ea31587e`;
driver 7.6.0 uses migration source `cc0b2e70`. Every run passed two primary changes.
The report includes the validator hash to identify the exact tested source.

These tests do not inject a retryable write error or prove that a write was
retried. They do not cover process crashes, packet loss, authentication/TLS,
live Atlas, backup/restore, HTTP request recovery or deployment rollback.
Those remain separate migration gates. This PR changes CI only; it does not
upgrade the production driver or change UI behavior.
