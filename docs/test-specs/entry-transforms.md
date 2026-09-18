# Entry transforms (M17, in progress)

The HTTP entries API already receives and returns materialized arrays. Native transforms now supply type defaults and restore legacy date offsets after the conditional-304 check; JSON, tabular field order, quoting and CRLF output are preserved. SVG Accept requests retain the existing JSON fallback. Preview and persistent writes retain the previous next-tick callback boundary. Persistent writes call the existing ordered bulk-create method once, avoiding the extra stream collector array.

The storage module retains map()/persist(callback) compatibility with native PassThrough/Writable object streams. Persistence collects records for one batch, reports success/failure once and reports destruction before end without writing the incomplete input. Ordered partial MongoDB failures are returned without retrying the batch; database rollback behavior is unchanged.

Sixteen focused cases pass on Node 22.23.2 and 24.20.0, and the same cases pass against the original implementation. They cover exact output, date/type mutation, empty/conditional output, previews, the 10,000-item limit, ordered writes/partial failures and stream callback/destruction behavior. To compare a clean installed parent:

```sh
NIGHTSCOUT_ENTRIES_ORACLE_ROOT=/path/to/parent node node_modules/mocha/bin/mocha --timeout 5000 tests/entry-transform-contract.test.js
```

Normal CI leaves that variable unset. The fixture uses the real router/storage code with an owned collection boundary; real API/auth/database suites remain required.

Seven package paths are removed: event-stream, from, map-stream, pause-stream, split, stream-combiner and through. Duplexer remains for development only. Removed packages contained 110,686 regular-file bytes in the matched installed parent. All six production browser JavaScript files are byte-identical after rebuilding.

An exploratory seven-pair fresh-process module-load comparison loads lib/server/entries and lib/api/entries, then forces GC. Median retained heap delta changes from 9,418,272 to 9,400,528 bytes (17,744 fewer), with 374 versus 366 cached modules. Median module-load time was 90.29 versus 77.42 ms on this machine. This is not a full-server RSS or request-throughput measurement; the matched HTTP request measurement below provides separate allocation/latency evidence.

The first full local backend run had an unexpected 405 on an unrelated cachebuster request. The origin-tagged diagnostic run then passed all 1,632 tests; 1,000 cache/auth stress requests also returned matching owned-server markers. This did not identify the earlier anomaly. The diagnostic also exposed an ignored preview HTTP-status assertion: the test now checks the established 200 response, and entry API callbacks propagate errors. The combined branch incorporating M16 subsequently passed all 1,632 backend tests (one existing pending) without diagnostic instrumentation. Hosted validation of the final head remains required.

## Paired request costs

`node tools/measure-entry-requests.js /path/to/installed/parent` starts fresh Node processes for seven paired samples of reads, previews and writes, alternating parent/candidate order. Each serves 1,000 synthetic entries through the real router with an owned fake collection. Five warmups precede 30 timed requests, followed by 30 separately profiled requests. Response status, item count, ordering and storage-call counts are checked. No deployment/database is contacted; the fake write history is cleared after each response so it does not accumulate memory.

[Raw samples and implementation hashes](../audits/entry-request-baseline.json) compare the M16 parent with the native entry implementation on Node 22.23.2. Values below are medians across the seven samples.

| Operation | Mean request latency, parent → candidate (ms) | Estimated allocated bytes per 30 profiled requests, parent → candidate |
| --- | ---: | ---: |
| Read JSON | 1.002 → 0.860 | 22,068,912 → 14,154,520 |
| Preview | 0.872 → 0.704 | 19,521,240 → 11,586,984 |
| Ordered write | 1.972 → 1.828 | 86,519,112 → 78,897,896 |

Allocation profiling uses [V8 sampling](https://chromedevtools.github.io/devtools-protocol/v8/HeapProfiler/#method-startSampling) at a 32,768-byte average interval, including objects collected by minor/major GC. These are statistical allocation estimates, not exact allocated bytes, retained heap or peak RSS. The same-process HTTP client and fake collection are included in both versions. Raw records also contain entry-stack attribution and before/after-GC heap observations; asynchronous stack boundaries limit attribution. Timing is measured before profiling to avoid sampler overhead. Response sizes match between versions (46,001 bytes for reads/previews and 97,001 for writes).

The measurements demonstrate lower request costs in this fixture, not guaranteed production throughput or a full-server memory reduction. Existing functional CI enforces format, batch and error contracts; host-dependent timings are a reproducible review measurement, not a hard-coded cross-platform CI deadline.
