# M27 decision for Nightscout 15.0.9

Retain Moment 2.30.1 and Moment Timezone 0.6.3 / IANA 2026c, with the existing
English-only browser Moment locale registry and 2015–2035 browser timezone data
range. Keep all configured zones and the full server timezone data. Do not add
another date library to the application or replace individual formatters in this
release. This is the explicit retain/narrow decision for M27, not a claim that
Moment is the best choice for new applications or that a replacement is impossible.

The comparison extends the earlier Intl and Luxon work with Day.js and Temporal,
a shared server/browser corpus, fixed offsets, seasonal overlap selection,
calendar-day arithmetic, invalid dates, elapsed durations and mutation contracts.
The candidate manifests are isolated research fixtures; the root manifests,
production bundles and application implementation are unchanged.

## Why retain the current implementation

1. The supported runtime/browser policy is a requirement. Native Temporal is
   absent on actual Node 22.23.2 and 24.20.0. The retained iOS 9.3 target lacks
   Intl, which the tested Day.js timezone plugin, Luxon and Temporal polyfill
   require. Removing Intl **before loading** each candidate in a fresh browser
   realm demonstrates the dependency: Day.js throws, Luxon returns an invalid
   DateTime, and the Temporal polyfill fails initialization. The existing
   production Moment global still formats the test zone. Removing Intl after
   loading the polyfill is insufficient because it captures constructors.
   These probes verify a missing-feature boundary, not full iOS emulation.
2. The APIs are not interchangeable. Day.js and Luxon choose a different
   occurrence of an overlapping local time depending on the current season.
   Day.js also preserves an obsolete offset when adding a calendar day over all
   four tested DST transitions and normalizes five invalid date inputs.
   Strict parsing and offset/ambiguity adapters are possible, but must be
   implemented and validated rather than weakening Nightscout's contracts.
3. Temporal with explicit `disambiguation: 'compatible'` matches the tested
   gaps, overlaps, fixed offsets and calendar-day arithmetic. However, immutable
   objects differ from the existing mutable profile API. Temporal machine fields
   do not reproduce Moment's locale postformat behavior, and its ISO parsers do
   not replace Nightscout's RFC 2822, numeric epoch-unit and array-fallback API.
   Native Intl alone supplies no parsing/calendar arithmetic API.
4. No complete application migration or whole-server memory reduction is
   demonstrated. The measured candidate costs below are useful tradeoffs, not
   proof of a net app saving. Adding a candidate while Moment remains required
   would add code and another compatibility surface. Further pruning timezone
   years, zones or locales would change supported input/output contracts.

This decision evaluates candidates against mandatory requirements first. It does
not build or claim validation of complete IOB/COB/report replacements for candidates
that fail the retained platform/API boundary. The accepted implementation remains
the existing application, whose full backend and real-browser suites are the
regression gate. A future migration must satisfy those application contracts;
passing a small candidate operation corpus cannot stand in for them.

## Evidence and reproduction

The [recorded server and memory results](../audits/date-candidate-review.json)
contain candidate versions/integrities, source hashes, runtime/ICU/timezone
versions, input corpus, all non-format cases, format mismatch counts/examples,
seven alternating CPU rounds and complete isolated memory samples. Candidate
versions verified on 2026-09-08: Day.js 1.11.23, Luxon 3.7.2,
`@js-temporal/polyfill` 0.5.1 and its JSBI 4.3.2 dependency.

Install the root lockfile normally. Copy `tools/audits/date-candidates/package*.json`
to an **absolute, canonical disposable directory**, then run `npm ci --prefix`
against that directory with scripts disabled. These packages are not installed
into the application tree. Example (replace the directory with an owned path):

```sh
npm ci
mkdir -p /absolute/disposable/date-candidates
cp tools/audits/date-candidates/package*.json /absolute/disposable/date-candidates/
npm ci --prefix /absolute/disposable/date-candidates --ignore-scripts --no-audit --no-fund
node tools/audits/date-candidate-probe.cjs /absolute/disposable/date-candidates
node tools/audits/date-candidate-memory.cjs /absolute/disposable/date-candidates
node tools/audits/browser-date-candidate-probe.cjs /absolute/disposable/date-candidates chromium
```

Repeat with both exact Node floors and Firefox/WebKit. Existing browser CI jobs
install the locked candidates separately and publish `date-candidates-*`
artifacts; no new environment/job is added. The browser probe uses Moment from
the actual built Nightscout page and compares only its available locales. It
records the checkout/tree identity, application bundle hash and all comparison
rows. Missing candidate APIs/load failures fail the research command; output
differences are recorded, not asserted to be equivalent.

There are 353 server cases per simulated season: 325 formatting cases plus
28 parsing/calendar/fixed-offset/duration/mutation cases. Both Node floors agree
on the observations. Of the 325 server formatting cases, Intl and Luxon differ
on 65 Arabic cases; Day.js and Temporal machine fields differ on 130 Arabic/
Persian cases. The browser's actual English-only registry has 65 formatting
cases plus the same 28 other cases. Its clipped historical timezone data can
differ from Intl-backed candidates; those known range differences are not
silently treated as correctness improvements.

## Measured costs and limits

Median milliseconds for 5,000 zone conversions plus editor date/time formatting
pairs, seven alternating rounds after warmup, from pre-parsed instants:

| Candidate | Node 22.23.2 | Node 24.20.0 |
| --- | ---: | ---: |
| Moment | 10.67 | 9.23 |
| Cached Intl adapter | 12.69 | 10.63 |
| Day.js | 160.18 | 151.94 |
| Luxon | 23.22 | 21.98 |
| Temporal polyfill | 54.66 | 52.01 |

This is a bounded formatting workload, not application throughput. Native browser
Temporal is not the polyfill measured in the Node timing table.

Standalone candidate bundles built with the project's Babel targets, including
candidate timezone/duration plugins and the five comparison locales where
applicable: Day.js 20,801 raw / 7,627 gzip bytes; Luxon 93,295 / 25,819;
Temporal polyfill 192,076 / 53,165. These are **not** replacement deltas for the
Nightscout app. They exclude a compatibility shim and any Intl fallback needed
for old supported browsers. No application bundle reduction is claimed.

Seven alternating fresh processes per candidate/runtime measured cold loading,
post-GC heap/RSS, loaded modules and five populate/release cycles of 5,000 zoned
values. Node 22 median loaded heap increases were Moment 1,792,104 bytes,
Day.js 214,432, Luxon 994,376 and Temporal 1,035,096. Median additional heap with
5,000 retained values was respectively 2,635,760; 1,932,560; 3,573,936; and
2,095,136 bytes. All raw Node 22/24 samples, including release-cycle residuals
and RSS, are in the evidence file. These isolated constructors do not measure
Nightscout servers, therapy workloads or a typical-instance saving; differences
cannot be added to earlier modernization estimates.

## Application regression coverage and known behavior

`tests/timezone-modernization.test.js` has 51 cases on each Node floor, including
new 23/25-hour and 23.5/24.5-hour calendar-day boundaries through real profile
parsing in both glucose unit modes. Invalid date-only and space-separated inputs
remain rejected through the real API3 parser. Existing cases cover epoch units,
RFC 2822, first-valid array fallback, mutable timezone conversion, fixed offsets,
overlap occurrences and timezone-data updates. IOB/COB/profile and browser report
pipelines remain exercised by the full suites, including both unit modes and
existing report goldens. No candidate has replaced these code paths.

Local validation: clean Node 22.23.2/npm 10.9.8 install/production build; 2,109
backend tests pass with one existing pending case, 283 client-core tests and
305 dependency tests. The focused 51 cases pass on Node 22.23.2 and 24.20.0.
Current-head hosted checks and all four browser comparison artifacts are required
before accepting the decision PR.

The existing spring-gap basal schedule discrepancy and browser pre-2015/post-2035
data limitation stay explicit. This dependency decision does not redefine therapy
schedule semantics, expand the bundled data range or claim those discrepancies
are corrected. A behavior fix needs its own application-level contract review.

## Support sources, ownership and revisit trigger

[MDN compatibility data at the recorded commit](https://github.com/mdn/browser-compat-data/tree/8d205d1e63a56b31e19265fba92e56840314c188)
and [support snapshot](../audits/date-candidate-runtime-support.json) distinguish
current Chromium/Firefox and WebKit preview support from stable Safari/iOS and
Node support. Stage 4 standardization does not establish the installed runtime's
capabilities. The [Temporal polyfill](https://github.com/js-temporal/temporal-polyfill)
ships ES2020 code and documents transpilation/JSBI requirements;
[Temporal string documentation](https://tc39.es/proposal-temporal/docs/strings.html)
explains its parsing boundary. The [Day.js timezone documentation](https://day.js.org/docs/en/timezone/timezone)
identifies its Intl dependency. [Moment's maintenance policy](https://momentjs.com/docs/)
is a reason to continue security/timezone maintenance, not a claim of ongoing
feature development.

Revisit at the next supported-browser/Node policy change, or by 2027-04-30
(Node 22 retirement review), whichever comes first. Prefer evaluating a direct
Moment-to-Temporal migration once the required runtimes support it, rather than
committing now to an intermediate library migration. Any earlier security or
correctness issue overrides that review date. Re-run the corpus and measure the
actual app with necessary adapters/fallbacks before choosing a migration.

Per the maintainer's 2026-09-08 instruction, production-host and physical-device
validation follow the automated work and are performed by the maintainer. This
record does not claim those manual checks passed. Rollback of this review is a
revert of its child PR; there is no runtime, configuration or persisted-data change.
