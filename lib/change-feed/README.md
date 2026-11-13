# Change-feed reconciliation

The feed reader publishes hints. Each consumer reads current tenant-bound state;
a hint is not authority, data, or proof that an evaluation completed. The listener
commits LISTEN before its initial reconciliation. Missing hints and reconnects
are covered by a rotating reconciliation scan.

## Healthy scan selection

Consumer `changeFeed.sweepMs` is optional. When absent, every healthy tick rotates
up to `pageSize` tenants. When set, elapsed time earns a proportional share of the
roster for the quiet scan, capped at one page per tick. Data, settings and activity
hints retain priority. A tick can select a page of hints plus a page of rotation;
overlapping tenants are checked once. The callback still runs on empty ticks so
membership checks retain their cadence.

This changes how often unchanged tenants are checked. It does not cache settings,
permissions or query results, or defer a tenant's due-time evaluator timer.
`resync()` requests an immediate paged check after worker admission changes.
Missing heartbeats, reconnects and refused reconciliation use full degraded pages.

A sweep period is a work-allocation target, not a wall-clock completion guarantee.
Roster size, page capacity, scheduling delays and check duration can extend it.
The evaluator also requires two selected sweep periods to fit its evaluation-gap
alert interval. Operators must measure actual completion, failures and freshness;
a lower SQL rate or CPU figure alone does not establish an improvement.

The companion Compose binding selects this through `NS_FEED_SWEEP_MS`, off when
empty. Its accepted range is 1000–30000 milliseconds. The binding and core must
both support the field. Default behavior is unchanged.

`tests/change-feed-sweep.test.js` exercises quiet coverage, a sustained stream of
write hints, degraded recovery, dynamic admission and evaluator time work. Its
synthetic-clock work counts are source evidence, not PostgreSQL, CPU or capacity
measurements. Native deployment and overload/recovery qualification remain
separate integration work.
