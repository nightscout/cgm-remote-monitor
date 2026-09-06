# Express 5 request and routing migration (M09)

Baseline: modernization c4eb117b, Express 4.22.2. Candidate: Express 5.2.1.
This review does not complete M09 or the integration release gates.

## Compatibility changes

Express 5's default simple query parser loses nested Nightscout filters. Its
extended parser also uses a smaller array limit than Express 4.22.2, and its
request query getter reparses on each access. Nightscout deliberately refines
and replaces filters between middleware. The shared request configuration uses
existing qs 6.16.0 explicitly, with the baseline prototype, array (1000) and
parameter (1000) options, and materializes one writable query per request.
Mounted APIs retain that object, including mutations made before mounting.
Unparsed bodies retain the legacy empty object; matching parsers still replace
it with parsed content, including an empty JSON array. Parser size, compression,
strict JSON and URL-encoded parameter options are unchanged.

Server and API application factories install that configuration before routes.
Standalone router test fixtures install the same configuration explicitly.
No Express prototype is patched. qs was already installed and overridden; its
new direct declaration does not add a second implementation.

Named optional route segments use brace syntax. Boot-error and properties
catchalls include the root path. API dispatcher regexes preserve legacy prefix
matching and do not strip the URL before the nested router handles it.
Status JavaScript negotiation specifies application/javascript explicitly to
retain the v1 format contract despite Express's changed MIME database.
Browser fixture translation routes use the supported wildcard syntax.

The old empty-batch test referenced a nonexistent fixture and sent no body.
It now asserts that its fixture is an empty array before sending it. Separate
request tests distinguish absent, unsupported, empty-array and document bodies.

## Evidence and remaining gates

The initial unadapted compatibility run failed on nested queries and wildcard
routes. A subsequent run exposed the array-limit difference. Seven query
lifecycle cases and thirty parser/compatibility cases pass on Node 22.23.2 and
24.20.0. The same 37 cases pass against the original Express 4 implementation,
without the new request configuration. Tests include mutation/replacement across
a mounted API, URL rewriting, request isolation, prototype pollution, three array
notations, 1000-parameter boundaries and empty versus parsed bodies.

A preliminary backend run passed 1,982 tests (one existing pending), before the
final unparsed-body compatibility addition and Helmet integration. That is not
final validation of the combined change. Full backend, client core, browser,
Docker/pruned runtime, audit and exact-current-base CI must pass before merging.
Installed package and image/memory measurements remain outstanding; no saving
is claimed from removing Express 4's old transitive packages alone.

Migration reference: https://expressjs.com/en/guide/migrating-5/
