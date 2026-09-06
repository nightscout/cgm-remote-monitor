# MongoDB driver 7 migration candidate

Candidate versions: mongodb 7.6.0 and mongodb-connection-string-url 7.0.2.
Remove the obsolete driver-scoped parser-3 override and align the direct
credential parser with the driver. The declared Node floor is >=20.19.0,
below Nightscout's exact supported floors. The vendor's driver 7.6 server
floor is 4.4; retaining Nightscout's MongoDB 5/6 migration policy is possible.
These range facts do not replace actual compatibility testing.

Review source: https://www.mongodb.com/docs/drivers/node/current/reference/upgrade/.

Initial findings:

- SOCKS became peer-optional after driver 5. Preserve existing proxy support
  with an explicit socks 2.8.10 dependency. The first full test attempt stopped
  because the former transitive ip-address/SOCKS path disappeared. Existing
  consumer IPv4/IPv6/SOCKS tests now run again; do not delete them to hide this.
- New BSON ObjectId fields are enumerable. Two historical tests pinned the
  driver-5 opaque representation. Keep that representation as an explicit
  non-enumerable fixture with real ObjectId methods/bytes and test two updates
  through the actual cache. Current real ObjectId/string paths remain covered.
- No application use of removed findOneAnd* metadata defaults, cursor stream
  transforms, keepAlive/useNewUrlParser/useUnifiedTopology options was found
  in the source scan. Db.stats remains in use; it is not Collection.stats.
- Driver 5 defaults getMore to 1000 documents; driver 7 defers to the server
  when batchSize is absent. Do not claim batch/memory equivalence from matching
  returned data. Characterize large real entry/report reads and command sizes
  before choosing an explicit batching policy or accepting the changed default.
- URI credentials, identifier validation, connection/retry/pool errors, BSON
  serialization and database-backed client operations remain regression gates.
  AWS/SOCKS/TLS URI behavior and supported deployment configurations require
  explicit review; do not infer feature parity from a successful ping.

Sixty-one focused identifier/URI/pool/retry/IP/SOCKS cases pass on Node 22;
the production build passes. The corrected isolated full backend suite passes
1,829 tests with one pending on both Node 22 and Node 24 / MongoDB 6
before the explicit batching change.
The initial objectid workflow invocation lacked its CI environment and was
not a valid database-backed result; full isolated CI-style runs are authoritative.
Final batching-change suites, MongoDB 5/6/7/8, browser/build and pruning gates remain open.

No driver migration is merged. The maintained-server baseline PR separately
runs the existing driver against MongoDB 7/8. Rollback must restore the driver,
parser and SOCKS declaration/lockfile together; persisted identifiers and
schemas must remain unchanged. M09/M29 are not complete from this candidate.

## Large entry read characterization

The actual `lib/server/entries.list` path was exercised against a disposable
MongoDB 6.0.27 database with 8,928 deterministic five-minute SGV records (31
days), descending date index, and unlimited / 1,000 / 1,500-record reads.
All three variants returned identical serialized records and ordering at each
limit. Seven fresh processes per variant used Node 22.23.2 on Darwin arm64,
with alternating variant order. The baseline checkout uses driver 5.9.2;
the candidate uses 7.6.0. The bounded experiment wraps only the collection's
find cursor with `.batchSize(1000)`. These measurements precede the application
policy below.

| Month read | Continuation batches | Median elapsed | Median uncollected heap delta |
| --- | --- | --- | --- |
| Driver 5 default | 1,000 maximum | 37.31 ms | 7,658,728 bytes |
| Driver 7 default | One batch of 8,827 | 42.35 ms | 22,788,152 bytes |
| Driver 7 explicit 1,000 | 1,000 maximum | 43.34 ms | 9,760,176 bytes |

Heap delta is sampled immediately around the read after a pre-read GC; it is
neither peak heap, retained heap, nor application RSS. These short local reads
are evidence for investigating batching, not a production performance forecast.
Explicit batch size also changes the initial batch from 101 to 1,000 and can
eliminate a round trip for the 1,000-record limited read. It does not reproduce
the old wire behavior exactly. Keep the driver migration unmerged until the
batch policy covers the relevant API/report read paths with regression tests;
matching output alone does not resolve this memory concern.

Raw samples: `../audits/mongodb-driver-read-comparison.json`. Reproduction probe:
`../../tools/probe-mongodb-driver-reads.cjs CHECKOUT [bounded|unbounded]`, run with the
supported Node executable and `--expose-gc`. It uses an owned, uniquely named
database on loopback port 27169 and drops only that database on completion.

## Candidate bulk-read policy and regression gate

Bulk application `find` calls now explicitly pass a shared, frozen
`{batchSize: 1000}` option. This covers entries/report data, treatments (including
post-upsert identifier lookup), activity, device status, food/quickpicks,
profile lists and queries, authorization lists, and API v3 `findMany`.
Single-document finds and the count aggregation retain their current behavior.
The policy bounds document count per batch, not document byte size or total
query memory: callers still collect their requested results with `toArray()`.

Ten real-database tests in `tests/mongo-read-batches.test.js` inspect returned
wire batches while checking results across batch boundaries. They cover sorted
full/limited repeated reads, food visibility and position, role/subject lists,
profile limits, and API v3 projection, normalization, skip and limit. All ten
fail with the unbounded driver-7 application and pass with the policy on both
Node floors. No memory threshold or timing assertion is used in CI.
The full Node 22 / MongoDB 6 backend suite passes 1,839 tests with one
pending after this policy change. Node 24 and the wider matrix remain gates.
For reproducing pre-policy measurements, the probe's `unbounded` mode strips
application find options; its default uses the checkout's actual policy.

## AWS authentication compatibility still open

A no-network probe using driver 5.9.2 with a synthetic MONGODB-AWS URI
containing username/password reaches its SASL-start command. Driver 7.6.0
rejects the same URI in `new MongoClient` before any connection with
`username and password cannot be provided when using MONGODB-AWS`.
The vendor upgrade guide also requires `@aws-sdk/credential-providers`, which
is not in the current candidate's package graph. This is an identified
compatibility gap, not evidence that existing users do or do not use AWS auth.
Do not merge this candidate until credential handling and dependency policy
preserve supported deployments or an explicit retirement/migration decision
is documented and tested. SCRAM database tests do not establish AWS parity.
