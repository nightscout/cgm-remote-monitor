# Integration CodeQL review: status credentials and entry deletion

The #8605 integration scan at ff5480ed reported two sensitive-GET findings
(status routing and the owned page fixture) and one query-injection finding
at entries.deleteMany. These require separate dispositions.

Browser startup now sends the existing API-secret hash or subject access token
in the existing `api-secret` header. Status URLs contain only the cache-buster.
The status response uses credentials already extracted by permission middleware,
including the signed token created for a legacy token query. Existing external
clients using query credentials remain compatible; this does not claim that all
legacy URL-based authentication has been retired. New clients should use headers.
The owned fixture requires the same header as production startup.

The actual-page regression covers all five pages, stored-secret and dialog
bootstrap, repeated reconnects, and absence of credential query parameters.
The status API regression verifies equivalent subject authorization for headers
and both legacy query parameter forms over two cycles.

The entry deletion endpoint deliberately accepts authorized MongoDB predicates;
wrapping the whole filter in $eq would break its public bulk-delete contract.
The existing api:entries:delete permission gate precedes the storage adapter,
and query_for uses the query builder's recursive executable-operator rejection.
The additional real-Mongo regression monitors delete commands: direct/nested
$where and $function requests fail without a delete command or lost records;
authorized ordinary comparison predicates delete only matching fixture records.
Existing tests verify that read-only roles cannot delete, including broad filters.
These checks distinguish intentional predicate support from operator injection
into a supposedly scalar identifier. Any alert dismissal must be limited to
this reviewed location and rule; no CodeQL query or directory is excluded.
