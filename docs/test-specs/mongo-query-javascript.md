# MongoDB query JavaScript boundary

The driver modernization review surfaced CodeQL alert 105 at the profile
query sink. An owned MongoDB 6 database confirmed that a supplied `$where`
predicate is evaluated by both driver 5.9.2 and 7.6.0. The profile read API
accepts MongoDB filters, so retaining comparisons and logical operators is
intentional; submitting JavaScript to the database is not required for those
filters. MongoDB documents `$where`, `$function` and `$accumulator` as
[server-side JavaScript operations](https://www.mongodb.com/docs/manual/reference/operator/query/where/).

A shared, iterative guard rejects those three operators before database I/O.
It applies to the legacy query builder, aggregation pipelines, API v3 filters,
projections and bulk-delete filters. Query literals (`$eq`, `$ne`, `$in`,
`$nin`, schema definitions and ordinary `$all` values) remain data. Aggregation
expressions are checked recursively, except explicit `$literal` data; `$match`
stages switch back to query semantics. A cycle is visited once per context,
so reusing an object as both a literal comparison and an expression cannot
bypass the expression check.

The `/profiles/` HTTP route now reports rejected JavaScript queries as HTTP
400 with a fixed explanatory message, instead of ignoring the storage error.
Other storage errors return a generic HTTP 500 without exposing database error
text. Aggregation validation reports failures through the existing promise
and callback contract. There is no dependency, schema, credential or browser
bundle change. Clients that submitted server-side JavaScript must express
filters using ordinary MongoDB query/aggregation operators.

## Evidence and remaining gates

The initial before/after boundary check produced four passes and nine failures
without the guard wiring, including the real profile endpoint accepting a
JavaScript predicate with HTTP 200. The guard made all those cases pass.
The final focused set includes 15 new cases plus five existing query tests:
20 pass on Node 22/MongoDB 6 and Node 24/MongoDB 8. Coverage includes repeated
HTTP rejection with no MongoDB find command, sorting/limit after rejection,
operator names inside literal documents, nested expressions, projection and
delete rejection, aggregate callback behavior and shared/cyclic contexts.
The existing D3 source inventory parser also accepts the changed source.

The full Node 22 / MongoDB 6 backend suite passes 1,846 tests with one pending.
Clean installation/production build and the development/HTTP asset checks pass.
Hosted browser, server matrix, Docker and CodeQL checks remain merge gates.
Do not equate this narrowly scoped guard with a general query cost limit,
a replacement for authorization, or proof that every NoSQL misuse is covered.
CodeQL alert 105 must be reassessed on the driver branch after integrating
the fix; it has not been dismissed.
