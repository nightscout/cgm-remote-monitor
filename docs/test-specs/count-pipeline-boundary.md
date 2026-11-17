# Public count pipeline boundary

The public `/api/v1/count/:storage/where` handler previously passed the complete
request query to storage aggregation. A caller could append aggregation stages,
including reads from other collections, despite the handler selecting only
entries, treatments or device status. The JavaScript-operator guard in #8663
is a separate boundary; declarative aggregation stages can also cross that
collection boundary.

The count handler now rejects any top-level `pipeline` parameter with HTTP 400
before invoking storage aggregation. Its documented `find` filters and existing
storage selection/fallback remain unchanged. An ordinary document field named
`pipeline` inside `find` is still allowed. The internal aggregation helper is
unchanged by this patch; trusted application pipelines are not removed.

Four real HTTP/database tests cover normal filtered counts across the existing
storage selections, repeated rejection before any aggregate command, malformed
or transformation pipeline parameters, and literal `find.pipeline` filtering.
The unpatched route has two passes and two failures: an owned cross-collection
fixture returns HTTP 200 and count 6 instead of rejecting the custom pipeline.
Both Node 22/MongoDB 6 and Node 24/MongoDB 8 pass all four cases after the fix.
No real user database or private record was accessed for this comparison.

Clean install/production build passes. The Node 22 / MongoDB 6 full backend
run passes 1,835 tests with one pending before refreshing onto the query guard.
Hosted validation remains required. There is no dependency, schema or browser code change. API clients
using custom pipelines must switch to supported `find` filters or run their
own authenticated database queries outside this public endpoint. The README
records the API restriction. Authorization for the existing storage choices
is unchanged; this patch does not claim a general authorization redesign.
