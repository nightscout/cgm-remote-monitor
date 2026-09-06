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

The candidate refreshed onto Helmet merge 19bd2191 passes a clean Node 22
install/build, all 2,007 backend cases (one existing pending), all 552 Chromium
browser cases and all 283 client-core cases. The 74 combined request, parser,
security-header and MIME cases also pass on Node 24. Application lint has zero
errors and the sixteen existing warnings; npm reports zero audit findings.

One earlier combined backend run had an ECONNRESET in UUID-EDGE-004. Five
consecutive isolated runs of the entire 15-case UUID suite and a full backend
rerun passed without code changes or test retries. The reset's cause was not
established; preserve this observation when assessing hosted CI. No failure is
skipped or retried by the test suite.

Hosted backend, browser, Docker/pruned runtime, npm 12, CodeQL and
exact-current-base CI must pass before merging.

The lockfile has 292 production package records versus 293 with Express 4 and
Helmet 8. All six production browser bundles are byte-identical. Several old
Express debug/MIME dependencies disappear, while the router and newer parser
chains add others. On the local ARM64 installation, summing the files belonging to production
package records (excluding nested node_modules from each package to avoid double
counting) gives 63,143,032 bytes before and 62,941,572 after: 201,460 bytes less.
All production package directories are present in both installations. This is
not a Docker-image or runtime-memory measurement; those remain outstanding.

Migration reference: https://expressjs.com/en/guide/migrating-5/
