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

## AWS authentication compatibility

The unadapted driver 7 rejects legacy MONGODB-AWS URI credentials before
connecting. `lib/storage/mongo-client-configuration.js` now moves those
credentials into the documented asynchronous AWS credential-provider interface.
URI values take precedence over environment values, including the session token;
missing URI values retain environment fallback. No process environment is
modified. Non-AWS URIs/options pass through unchanged. Repeated authentication
properties are combined while retaining last-token precedence, since the new
driver rejects duplicate URI option names. Other driver option validation is
retained.

The required `@aws-sdk/credential-providers` 3.1127.0 adds 24 package paths,
2,706 installed regular files and 4,753,775 bytes. No retained package version
changes. See `../audits/mongodb-aws-dependency-cost.json`. This is installation
cost, not compressed image size or runtime RAM. A fresh-process test confirms
ordinary MongoDB client construction does not load AWS SDK modules. With no
static AWS access key, the SDK manages metadata credential retrieval and refresh;
Nightscout does not implement its own AWS metadata protocol.

Twelve regression cases exercise encoded credentials, URI/environment
precedence, session tokens, repeated auth setup through the actual storage
initializer, mixed-case/repeated options, sanitized errors and non-AWS isolation.
The driver's real SASL nonce handling and signer run against an in-process
challenge fixture. A separate child process with empty AWS config files and a
minimal environment exercises the real SDK against an owned loopback metadata
endpoint: unexpired credentials are reused and expired credentials refresh over
two cycles. This does not validate a live Atlas account or deployment IAM role.
The [MongoDB AWS authentication documentation](https://www.mongodb.com/docs/drivers/node/current/security/authentication/aws-iam/)
describes the provider interface.

Clean Node 24 installation/build passes. The first full AWS-enabled backend run
found the existing source inventory parser cannot parse logical assignment;
the helper now uses equivalent ordinary assignment, and its parser regression
passes. The corrected Node 24 / MongoDB 6 full backend run passes 1,854 tests with
one pending before integration of the query boundary below.

## Query validation finding remains a merge blocker

CodeQL alert 105 flags the profile query path. A safe owned-database probe
confirmed that `profile.list_query({find:{$where: ...}})` evaluates a supplied
JavaScript predicate under both driver 5.9.2 and 7.6.0. This is an existing
query-validation gap surfaced on a changed line, not caused by batch sizing.
#8663 now supplies the merged query boundary and regression coverage. The
driver branch retains both its batch options and query validation after resolving
the API v3 import conflict; both runtime documentation sections are retained.
Thirty-seven combined AWS/batching/query-boundary cases pass on Node 24 /
MongoDB 8. Keep the driver PR unmerged until fresh CodeQL and full hosted
validation confirm this integration; the alert has not been dismissed.

## Profile filter alert review

CodeQL alert 105 identifies the profile list's user-controlled filter object.
The API intentionally accepts query predicates after `api:profile:read`; it
does not use the supplied filter as an authentication credential or append a
per-document access constraint. The collection comes from server configuration.
Wrapping this entire filter in `$eq` would break the documented query API.

The HTTP boundary fixture now uses the real authorization middleware and Shiro
role resolution instead of an always-allow stub. Over two cycles, no permissions
and entries-read-only permissions both produce 401 for empty, broad and
JavaScript filters, with zero MongoDB find commands. The same denial holds for
`/profile/` and `/profile/current`. A profile-read role can select all three
owned profiles through ordinary operators. Removing the router's profile-read
gate makes this regression fail (expected 401, received 200). The remaining
JavaScript rejection and literal-data tests also run through real authorization.
All four HTTP cases pass on Node 22/MongoDB 6 and Node 24/MongoDB 8; the combined
Node 22 query-boundary suite has 16 passing cases.

MongoDB distinguishes [query predicates](https://www.mongodb.com/docs/manual/reference/mql/query-predicates/)
from [server-side JavaScript](https://www.mongodb.com/docs/manual/core/server-side-javascript/).
The merged guard rejects `$where`, `$function` and `$accumulator` in executable
contexts. This review supports treating the remaining generic object-flow
warning separately from that fixed executable-query defect. After confirming
that the refreshed analysis reports this same flow, alert 105 was triaged as a
false positive: operator selection is intentional within the caller's profile
read permission, with no per-document authorization predicate being bypassed.
The GitHub dismissal points to these tests and applies only to this alert.
No rule, path or general sanitizer exemption was added. This does not prove
query resource bounds or change authorization policy. Fresh CodeQL analysis
and every other CI/migration gate remain required before merging the driver.
