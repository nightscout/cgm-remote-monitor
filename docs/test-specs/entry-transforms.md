# Entry transforms (M17, in progress)

The HTTP entries API already receives and returns materialized arrays. Native transforms now supply type defaults and restore legacy date offsets after the conditional-304 check; JSON, tabular field order, quoting and CRLF output are preserved. SVG Accept requests retain the existing JSON fallback. Preview and persistent writes retain the previous next-tick callback boundary. Persistent writes call the existing ordered bulk-create method once, avoiding the extra stream collector array.

The storage module retains map()/persist(callback) compatibility with native PassThrough/Writable object streams. Persistence collects records for one batch, reports success/failure once and reports destruction before end without writing the incomplete input. Ordered partial MongoDB failures are returned without retrying the batch; database rollback behavior is unchanged.

Sixteen focused cases pass on Node 22.23.2 and 24.20.0, and the same cases pass against the original implementation. They cover exact output, date/type mutation, empty/conditional output, previews, the 10,000-item limit, ordered writes/partial failures and stream callback/destruction behavior. To compare a clean installed parent:

```sh
NIGHTSCOUT_ENTRIES_ORACLE_ROOT=/path/to/parent node node_modules/mocha/bin/mocha --timeout 5000 tests/entry-transform-contract.test.js
```

Normal CI leaves that variable unset. The fixture uses the real router/storage code with an owned collection boundary; real API/auth/database suites remain required.

Seven package paths are removed: event-stream, from, map-stream, pause-stream, split, stream-combiner and through. Duplexer remains for development only. Removed packages contained 110,686 regular-file bytes in the matched installed parent. All six production browser JavaScript files are byte-identical after rebuilding.

An exploratory seven-pair fresh-process module-load comparison loads lib/server/entries and lib/api/entries, then forces GC. Median retained heap delta changes from 9,418,272 to 9,400,528 bytes (17,744 fewer), with 374 versus 366 cached modules. Median module-load time was 90.29 versus 77.42 ms on this machine. This is not a full-server RSS or request-throughput measurement; request allocation/latency evidence remains required before M17 completion.

The first full local backend run had an unexpected 405 on an unrelated cachebuster request. It is not waived: a diagnostic run tags each owned HTTP server so a future unexpected response can be attributed to its intended server without recording credentials or response bodies. The diagnostic is outside the repository. Full backend/hosted validation and final integration refresh remain open; this PR is not merge-ready.
