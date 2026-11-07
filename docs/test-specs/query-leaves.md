# Query leaf conversion

M23 replaces the two `traverse` calls in `lib/server/query.js` with a scoped,
in-place helper. It does not provide cloning, path inspection or general tree
editing. Query operators and array structure remain unchanged; configured
leaf conversions and ObjectId normalization retain their existing behavior.

Nine characterization cases ran on the unchanged integration implementation
before the replacement. The same cases run against the replacement and can
also run against an independently installed parent through
`NIGHTSCOUT_QUERY_ORACLE=/absolute/path/to/lib/server/query.js`.

Coverage includes nested operators, scalar truthiness, ignored root
replacement, empty/null leaves, sparse arrays, aliases/cycles, own versus
inherited/symbol keys, null prototypes, own prototype-like keys, BSON ObjectIds,
dates/regex values, UUID equality versus complex operators, conversion errors
and non-writable properties. Conversion does not clone caller-owned values.
The helper visits own enumerable string keys, matching the current parser;
it is not a replacement for HTTP query-parser security controls.

Both Node 22.23.2 and 24.20.0 pass 52 focused cases: nine parent cases, nine
replacement cases, five existing query tests and 29 Express/parser contracts.
The parent and replacement use separate BSON module instances; tests assert
BSON type and hex values rather than cross-module instanceof identity.
Production build passes. All six generated browser JavaScript bundles are
byte-identical to the reviewed callback-task parent build. Lint has no errors;
the dynamic optional oracle import and existing RegExp constructor warn.
Full backend, clean final installation and hosted CI remain required.

The lockfile removes 71 installed package paths, with no additions or changes
to retained entries. Their installed regular-file contents in the integration
checkout total 4,342,582 bytes. This is uncompressed installed content, not a
compressed deployment/image measurement or a server heap measurement.
Other dependencies remain only where still reachable in the lockfile.

Rollback restores the query implementation, manifest and lockfile together
and removes the local helper. No database/schema or UI migration is involved.
